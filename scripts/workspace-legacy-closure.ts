import fs from "node:fs/promises";
import path from "node:path";

const help = `Usage: tsx scripts/workspace-legacy-closure.ts inspect|prepare|close|namespace-inspect|namespace-close
  --config <existing local instance config.json> --company-id <uuid> --cwd <original directory>
  prepare: --expected-digest <inspection sha256>
  close: --hold-id <uuid> --generation <uuid>
  namespace-inspect: --owner-id <uuid> --generation <uuid> --launch-id <uuid>
  namespace-close: same selectors plus --expected-digest <inspection sha256>

inspect is read-only. prepare creates an audited maintenance hold.
close requires an actual changed host kernel epoch and unchanged precise identities.
No command restarts WSL, signals processes, changes run states, deletes records, or wakes tasks.
Boot/namespace proof cannot be supplied as command-line arguments.
namespace-close verifies an exact unknown guarded namespace, appends a real drain
receipt and formally releases it. Old failed runs and their ledgers remain unchanged.
`;

class ArgumentError extends Error {}
function argumentsFor(argv: string[]) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0]!)) return null;
  const action = argv[0];
  if (!["inspect", "prepare", "close", "namespace-inspect", "namespace-close"].includes(action ?? "")) throw new ArgumentError("Expected inspect|prepare|close|namespace-inspect|namespace-close");
  const values: Record<string, string> = {};
  const allowed = ["--config", "--company-id", "--cwd", ...(action === "prepare" || action === "namespace-close" ? ["--expected-digest"] : []), ...(action === "close" ? ["--hold-id", "--generation"] : []), ...(action?.startsWith("namespace-") ? ["--owner-id", "--generation", "--launch-id"] : [])];
  for (let i = 1; i < argv.length; i += 2) {
    const key = argv[i]!;
    if (!allowed.includes(key)) throw new ArgumentError(`Unknown option: ${key}`);
    if (values[key]) throw new ArgumentError(`Duplicate option: ${key}`);
    const value = argv[i + 1]; if (!value || value.startsWith("--")) throw new ArgumentError(`Missing value: ${key}`);
    values[key] = value;
  }
  for (const key of allowed) if (!values[key]) throw new ArgumentError(`Missing ${key}`);
  return { action, values };
}

async function main() {
  const parsed = argumentsFor(process.argv.slice(2));
  if (!parsed) { console.log(help); return; }
  if (process.platform !== "linux" || process.getuid === undefined || process.env.PAPERCLIP_RUN_ID || process.env.PAPERCLIP_AGENT_ID || process.env.PAPERCLIP_API_KEY)
    throw Object.assign(new Error(), { code: "host_operator_required" });
  if (process.env.DATABASE_URL || process.env.DATABASE_MIGRATION_URL) throw Object.assign(new Error(), { code: "external_database_override_refused" });
  const configFile = await fs.realpath(path.resolve(parsed.values["--config"]!));
  const configStat = await fs.stat(configFile);
  if (!configStat.isFile() || configStat.uid !== process.getuid() || (configStat.mode & 0o077) !== 0)
    throw Object.assign(new Error(), { code: "private_operator_config_required" });
  let config: { database?: { mode?: string; embeddedPostgresPort?: number; embeddedPostgresDataDir?: string } };
  try { config = JSON.parse(await fs.readFile(configFile, "utf8")); }
  catch { throw Object.assign(new Error(), { code: "invalid_instance_config" }); }
  const database = config.database;
  if (database?.mode !== "embedded-postgres" || !database.embeddedPostgresDataDir || !Number.isInteger(database.embeddedPostgresPort)
    || database.embeddedPostgresPort! < 1 || database.embeddedPostgresPort! > 65535)
    throw Object.assign(new Error(), { code: "local_embedded_instance_required" });
  const directory = await fs.realpath(database.embeddedPostgresDataDir);
  const { createDb } = await import("../packages/db/src/index.js");
  const { legacyWorkspaceClosureService } = await import("../server/src/services/legacy-workspace-closure.js");
  const { workspaceNamespaceClosureService } = await import("../server/src/services/workspace-namespace-closure.js");
  const db = createDb(`postgres://paperclip:paperclip@127.0.0.1:${database.embeddedPostgresPort}/paperclip`);
  try {
    const service = legacyWorkspaceClosureService(db, { databaseDirectory: directory });
    const request = { companyId: parsed.values["--company-id"]!, cwd: path.resolve(parsed.values["--cwd"]!) };
    const namespace = workspaceNamespaceClosureService(db, { databaseDirectory: directory });
    const namespaceRequest = { ...request, ownerId: parsed.values["--owner-id"]!, generation: parsed.values["--generation"]!, launchId: parsed.values["--launch-id"]! };
    const result = parsed.action === "namespace-inspect" ? await namespace.inspect(namespaceRequest)
      : parsed.action === "namespace-close" ? await namespace.close({ ...namespaceRequest, expectedDigest: parsed.values["--expected-digest"]! })
      : parsed.action === "inspect" ? await service.inspect(request)
      : parsed.action === "prepare" ? await service.prepare({ ...request, expectedDigest: parsed.values["--expected-digest"]! })
        : await service.close({ ...request, holdId: parsed.values["--hold-id"]!, generation: parsed.values["--generation"]! });
    console.log(JSON.stringify({ action: parsed.action, result }, null, 2));
  } finally { await db.$client.end({ timeout: 1 }); }
}

main().catch(error => {
  if (error instanceof ArgumentError) { console.error(error.message); process.exitCode = 2; }
  else { console.error(JSON.stringify({ error: typeof error?.code === "string" ? error.code : "maintenance_failed" })); process.exitCode = 1; }
});
