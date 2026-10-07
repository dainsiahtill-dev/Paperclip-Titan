import fs from "node:fs/promises";
import path from "node:path";

const help = `Usage: tsx scripts/workspace-legacy-reconcile.ts inspect|reconcile
  Every action: --config <private local instance config.json> --company-id <uuid> --cwd <original source root>
  reconcile: --expected-digest <inspection sha256> --reason <explicit operator decision>
    --evidence-file <existing private audit/backup evidence> --evidence-sha256 <file sha256>

inspect is read-only. reconcile records an audited manual operator decision for
the exact reviewed cohort, company and physical source root. It preserves the
unresolved host/namespace proof and requires a reason plus verified evidence.
This decision does not assert namespace drain, host exit or completed source work.
It does not disable protection globally or permit unrelated companies/source roots.
This command does not reboot, signal processes, delete locks, rewrite runs or wake tasks.
Boot and namespace proof cannot be supplied through arguments, environment or stdin.
Actual task execution, safe release and human acceptance remain separate checks.
`;

class ArgumentError extends Error {}
function argumentsFor(argv: string[]) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) return null;
  const action = argv[0];
  if (!["inspect", "reconcile"].includes(action ?? "")) throw new ArgumentError("Expected inspect|reconcile");
  const allowed = ["--config", "--company-id", "--cwd",
    ...(action === "reconcile" ? ["--expected-digest", "--reason", "--evidence-file", "--evidence-sha256"] : [])];
  const values: Record<string, string> = {};
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!;
    if (!allowed.includes(key)) throw new ArgumentError(`Unknown option: ${key}`);
    if (Object.hasOwn(values, key)) throw new ArgumentError(`Duplicate option: ${key}`);
    const value = argv[i + 1];
    if (!value || value.startsWith("-")) throw new ArgumentError(`Missing value: ${key}`);
    values[key] = value;
  }
  for (const key of allowed) if (!values[key]) throw new ArgumentError(`Missing ${key}`);
  return { action, values };
}
function failure(code: string): never { throw Object.assign(new Error(code), { code }); }

async function main() {
  const parsed = argumentsFor(process.argv.slice(2));
  if (!parsed) { console.log(help); return; }
  if (process.platform !== "linux" || process.getuid === undefined || process.env.PAPERCLIP_RUN_ID
    || process.env.PAPERCLIP_AGENT_ID || process.env.PAPERCLIP_API_KEY) failure("host_operator_required");
  if (process.env.DATABASE_URL || process.env.DATABASE_MIGRATION_URL) failure("external_database_override_refused");
  if (["PAPERCLIP_BOOT_ID", "PAPERCLIP_HOST_BOOT_ID", "PAPERCLIP_PID_NAMESPACE", "PAPERCLIP_MOUNT_NAMESPACE"]
    .some(name => Boolean(process.env[name]))) failure("caller_host_proof_refused");
  const configFile = await fs.realpath(path.resolve(parsed.values["--config"]!));
  const configStat = await fs.stat(configFile);
  if (!configStat.isFile() || configStat.uid !== process.getuid() || (configStat.mode & 0o077) !== 0)
    failure("private_operator_config_required");
  let config: { database?: { mode?: string; embeddedPostgresPort?: number; embeddedPostgresDataDir?: string } };
  try {
    config = JSON.parse(await fs.readFile(configFile, "utf8"));
    if (!config || typeof config !== "object" || Array.isArray(config)) failure("invalid_instance_config");
  } catch { failure("invalid_instance_config"); }
  const database = config.database;
  if (database?.mode !== "embedded-postgres" || typeof database.embeddedPostgresDataDir !== "string"
    || !database.embeddedPostgresDataDir || !Number.isInteger(database.embeddedPostgresPort)
    || database.embeddedPostgresPort! < 1 || database.embeddedPostgresPort! > 65535)
    failure("local_embedded_instance_required");
  const directory = await fs.realpath(database.embeddedPostgresDataDir);
  const { createDb } = await import("../packages/db/src/index.js");
  const { legacyWorkspaceOperatorReconciliationService } = await import("../server/src/services/legacy-workspace-operator-reconciliation.js");
  const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${database.embeddedPostgresPort}/paperclip`);
  try {
    const service = legacyWorkspaceOperatorReconciliationService(db, { databaseDirectory: directory });
    const sourceScope = { companyId: parsed.values["--company-id"]!, cwd: path.resolve(parsed.values["--cwd"]!) };
    const result = parsed.action === "inspect" ? await service.inspect(sourceScope)
      : await service.reconcile({ ...sourceScope, expectedDigest: parsed.values["--expected-digest"]!, reason: parsed.values["--reason"]!,
        evidence: { path: path.resolve(parsed.values["--evidence-file"]!), sha256: parsed.values["--evidence-sha256"]! } });
    console.log(JSON.stringify({ action: parsed.action, result }, null, 2));
  } finally { await db.$client.end({ timeout: 1 }); }
}

main().catch(error => {
  if (error instanceof ArgumentError) { console.error(error.message); process.exitCode = 2; }
  else {
    console.error(JSON.stringify({ error: typeof error?.code === "string" ? error.code : "maintenance_failed" }));
    process.exitCode = 1;
  }
});
