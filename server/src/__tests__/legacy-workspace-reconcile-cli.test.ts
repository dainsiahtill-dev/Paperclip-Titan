import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workspaceWriteOwnershipService } from "../services/workspace-write-ownership.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/cli.mjs", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/workspace-legacy-reconcile.ts", import.meta.url));
const companyId = "11111111-1111-4111-8111-111111111111";
const digest = "a".repeat(64);
let temporary: string;
beforeAll(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pc-reconcile-cli-")); });
afterAll(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

function run(args: string[], env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [launcher, script, ...args], {
    cwd: root, env: { PATH: process.env.PATH, ...env }, encoding: "utf8", timeout: 15_000,
  });
}
function selectors(action: string, config = "/nonexistent/private-config.json") {
  return [action, "--config", config, "--company-id", companyId, "--cwd", "/nonexistent/source",
    ...(action === "reconcile" ? ["--expected-digest", digest, "--reason", "Explicit manual decision after backup and live audit",
      "--evidence-file", "/nonexistent/private-evidence.json", "--evidence-sha256", digest] : [])];
}
async function configFile(name: string, database: unknown, mode = 0o600) {
  const file = path.join(temporary, name);
  await fs.writeFile(file, JSON.stringify({ database }), { mode });
  return file;
}

it("explains manual scope and unresolved proof without opening the database", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("inspect|reconcile");
  expect(result.stdout).toContain("--company-id");
  expect(result.stdout).toContain("--expected-digest");
  expect(result.stdout).toContain("--reason");
  expect(result.stdout).toContain("--evidence-file");
  expect(result.stdout).toContain("--evidence-sha256");
  expect(result.stdout).toContain("manual operator decision");
  expect(result.stdout).toContain("unresolved");
  expect(result.stdout).toContain("namespace drain");
  expect(result.stdout).toContain("does not reboot");
});

it.each([
  ["inspect", "--config"], ["inspect", "--company-id"], ["inspect", "--cwd"],
  ["reconcile", "--config"], ["reconcile", "--company-id"], ["reconcile", "--cwd"],
  ["reconcile", "--expected-digest"], ["reconcile", "--reason"], ["reconcile", "--evidence-file"], ["reconcile", "--evidence-sha256"],
])("requires %s selector %s before configuration loading", (action, missing) => {
  const args = selectors(action);
  args.splice(args.indexOf(missing), 2);
  const result = run(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`Missing ${missing}`);
});

it.each(["--config", "--company-id", "--cwd", "--expected-digest", "--reason", "--evidence-file", "--evidence-sha256"])(
  "refuses duplicate %s before configuration loading", flag => {
    const result = run([...selectors("reconcile"), flag, "duplicate"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Duplicate option: ${flag}`);
  },
);
it.each(["--boot-id", "--namespace-drained", "--pid-namespace", "--mount-namespace", "--force", "--global", "--generation"])(
  "refuses caller proof or unsupported scope %s before configuration loading", flag => {
    const result = run([...selectors("reconcile"), flag, "caller-value"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Unknown option: ${flag}`);
  },
);
it("refuses a missing reason value before configuration loading", () => {
  const args = selectors("reconcile");
  args.splice(args.indexOf("--reason") + 1, 1);
  const result = run(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Missing value: --reason");
});
it.each(["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_API_KEY"])("refuses agent context %s before configuration loading", name => {
  const result = run(selectors("inspect"), { [name]: "private-agent-value" });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "host_operator_required" });
});
it.each(["DATABASE_URL", "DATABASE_MIGRATION_URL"])("refuses external database override %s before configuration loading", name => {
  const result = run(selectors("inspect"), { [name]: "postgres://secret@example.invalid/private" });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "external_database_override_refused" });
});
it.each(["PAPERCLIP_BOOT_ID", "PAPERCLIP_HOST_BOOT_ID", "PAPERCLIP_PID_NAMESPACE", "PAPERCLIP_MOUNT_NAMESPACE"])(
  "refuses caller proof environment %s before configuration loading", name => {
    const result = run(selectors("reconcile"), { [name]: "caller-proof" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: "caller_host_proof_refused" });
  },
);
it("refuses a public config before database import", async () => {
  const config = await configFile("public.json", { mode: "embedded-postgres" }, 0o644);
  const result = run(selectors("inspect", config));
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "private_operator_config_required" });
});
it("refuses malformed private config without exposing contents", async () => {
  const config = path.join(temporary, "malformed.json");
  await fs.writeFile(config, "private-secret not JSON", { mode: 0o600 });
  const result = run(selectors("inspect", config));
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "invalid_instance_config" });
});
it.each([
  { mode: "postgres", connectionString: "postgres://secret@example.invalid/private" },
  { mode: "embedded-postgres", embeddedPostgresPort: 0, embeddedPostgresDataDir: "/nonexistent" },
  { mode: "embedded-postgres", embeddedPostgresPort: 65536, embeddedPostgresDataDir: "/nonexistent" },
  { mode: "embedded-postgres", embeddedPostgresPort: "5432", embeddedPostgresDataDir: "/nonexistent" },
  { mode: "embedded-postgres", embeddedPostgresPort: 5432 },
])("refuses unsafe database config %# before database import", async database => {
  const config = await configFile(`unsafe-${Math.random()}.json`, database);
  const result = run(selectors("inspect", config));
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "local_embedded_instance_required" });
});

it("records only the reviewed manual company/source scope from actual private evidence without altering historical rows", async () => {
  const database = await startEmbeddedPostgresTestDatabase("pc-reconcile-cli-db-");
  const db = schema.createDb(database.connectionString);
  try {
    const rows = await db.execute<{ directory: string }>(sql`select current_setting('data_directory') as directory`);
    const config = await configFile("embedded.json", { mode: "embedded-postgres", embeddedPostgresPort: Number(new URL(database.connectionString).port),
      embeddedPostgresDataDir: rows[0]!.directory });
    const historicalCompany = randomUUID(), targetCompany = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(schema.companies).values([{ id: historicalCompany, name: "Historical", issuePrefix: "HST" }, { id: targetCompany, name: "Manual target", issuePrefix: "CUR" }]);
    await db.insert(schema.agents).values({ id: agentId, companyId: historicalCompany, name: "Historical", role: "engineer", adapterType: "codex_local" });
    await db.insert(schema.heartbeatRuns).values({ id: runId, companyId: historicalCompany, agentId, status: "succeeded", runtimeMode: "legacy",
      controllerBootId: randomUUID(), processPid: 2147480000, processGroupId: 2147480000, processStartedAt: new Date(0),
      contextSnapshot: { paperclipWorkspace: { cwd: path.join(temporary, "deleted-source") } } });
    await db.insert(schema.environmentLeases).values({ companyId: historicalCompany, heartbeatRunId: runId, provider: "local", status: "released" });
    const cwd = await fs.mkdtemp(path.join(temporary, "target-source-"));
    const evidencePath = path.join(temporary, "manual-evidence.json");
    const evidenceBytes = JSON.stringify({ exactRunId: runId, archivalMatch: true, namespaceProofAvailable: false });
    await fs.writeFile(evidencePath, evidenceBytes, { mode: 0o600 });
    const evidenceDigest = createHash("sha256").update(evidenceBytes).digest("hex");
    const beforeRuns = await db.select().from(schema.heartbeatRuns), beforeLeases = await db.select().from(schema.environmentLeases);
    const beforeEvents = await db.select().from(schema.heartbeatRunEvents), beforeAudit = await db.select().from(schema.activityLog);
    const owners = workspaceWriteOwnershipService(db), source = { companyId: targetCompany, cwd };
    expect(await owners.claim({ ...source, runId: randomUUID() })).toEqual({ outcome: "busy" });
    const scopeArgs = ["--config", config, "--company-id", targetCompany, "--cwd", cwd];
    const inspected = run(["inspect", ...scopeArgs]);
    expect(inspected.status, inspected.stderr).toBe(0);
    const capture = JSON.parse(inspected.stdout).result;
    expect(capture.cohort.map((entry: { runId: string }) => entry.runId)).toEqual([runId]);
    expect(await db.select().from(schema.legacyWorkspaceEpochClosures)).toEqual([]);
    expect(await db.select().from(schema.activityLog)).toEqual(beforeAudit);
    const decisionArgs = ["--reason", "Explicit authorized scoped operator decision after backup and live audit; host and namespace proof remains unresolved",
      "--evidence-file", evidencePath, "--evidence-sha256", evidenceDigest];
    const wrongDigest = run(["reconcile", ...scopeArgs, "--expected-digest", digest, ...decisionArgs]);
    expect(wrongDigest.status).toBe(1);
    expect(await db.select().from(schema.legacyWorkspaceEpochClosures)).toEqual([]);
    const wrongEvidence = run(["reconcile", ...scopeArgs, "--expected-digest", capture.digest, ...decisionArgs.slice(0, -1), digest]);
    expect(wrongEvidence.status).toBe(1);
    expect(await db.select().from(schema.legacyWorkspaceEpochClosures)).toEqual([]);
    const reconciled = run(["reconcile", ...scopeArgs, "--expected-digest", capture.digest, ...decisionArgs]);
    expect(reconciled.status, reconciled.stderr).toBe(0);
    const decision = JSON.parse(reconciled.stdout).result;
    expect(decision.state).toBe("operator_reconciled");
    expect(decision.closure.proof).toBe("operator_decision");
    expect(decision.closure.namespaceDrained).toBe(false);
    const otherRoot = await fs.mkdtemp(path.join(temporary, "other-source-"));
    expect(await owners.claim({ companyId: targetCompany, cwd: otherRoot, runId: randomUUID() })).toEqual({ outcome: "busy" });
    expect(await owners.claim({ companyId: historicalCompany, cwd, runId: randomUUID() })).toEqual({ outcome: "busy" });
    expect(await owners.claim({ ...source, runId: randomUUID() })).toMatchObject({ outcome: "claimed" });
    expect(await db.select().from(schema.heartbeatRuns)).toEqual(beforeRuns);
    expect(await db.select().from(schema.environmentLeases)).toEqual(beforeLeases);
    expect(await db.select().from(schema.heartbeatRunEvents)).toEqual(beforeEvents);
  } finally { await db.$client.end({ timeout: 1 }); await database.cleanup(); }
}, 60_000);
