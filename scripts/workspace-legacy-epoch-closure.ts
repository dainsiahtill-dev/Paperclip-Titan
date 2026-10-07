import fs from "node:fs/promises";
import path from "node:path";

const help = `Usage: tsx scripts/workspace-legacy-epoch-closure.ts inspect|prepare|status|close
  Every action: --config <existing private local instance config.json>
  prepare: --expected-digest <inspection sha256>
  status: --id <closure uuid> --generation <uuid>
  close: --id <closure uuid> --generation <uuid> --expected-digest <inspection sha256>

inspect is read-only and captures an instance-scoped deleted-workspace cohort.
prepare creates an audited instance dispatch fence for new protected dispatch.
status reads the exact prepared or closed record without changing it.
close requires an actual changed kernel boot, unchanged UID/database identity,
and unchanged captured history. A Paperclip service restart is insufficient.
Closure records host epoch evidence; it does not assert namespace drain or source acceptance.
This command does not reboot, signal processes, delete locks, rewrite runs or wake tasks.
Boot and namespace proof cannot be supplied through arguments, environment or stdin.
WSL shutdown requires separate explicit approval after workload checkpoint and handoff.
`;

class ArgumentError extends Error {}
function argumentsFor(argv: string[]) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) return null;
  const action = argv[0];
  if (!["inspect", "prepare", "status", "close"].includes(action ?? ""))
    throw new ArgumentError("Expected inspect|prepare|status|close");
  const allowed = ["--config",
    ...(action === "status" || action === "close" ? ["--id", "--generation"] : []),
    ...(action === "prepare" || action === "close" ? ["--expected-digest"] : [])];
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
  const { legacyWorkspaceEpochClosureService } = await import("../server/src/services/legacy-workspace-epoch-closure.js");
  const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${database.embeddedPostgresPort}/paperclip`);
  try {
    const service = legacyWorkspaceEpochClosureService(db, { databaseDirectory: directory });
    const exact = { id: parsed.values["--id"]!, generation: parsed.values["--generation"]! };
    const result = parsed.action === "inspect" ? await service.inspect()
      : parsed.action === "prepare" ? await service.prepare({ expectedDigest: parsed.values["--expected-digest"]! })
      : parsed.action === "status" ? await service.status(exact)
      : await service.close({ ...exact, expectedDigest: parsed.values["--expected-digest"]! });
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
