import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/cli.mjs", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/workspace-legacy-epoch-closure.ts", import.meta.url));
const digest = "a".repeat(64);
const id = "11111111-1111-4111-8111-111111111111";
const generation = "22222222-2222-4222-8222-222222222222";
let temporary: string;
beforeAll(async () => { temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pc-epoch-cli-")); });
afterAll(async () => { if (temporary) await fs.rm(temporary, { recursive: true, force: true }); });

function run(args: string[], env: Record<string, string> = {}, input = "") {
  // Invoke the actual executable. No RTK, inherited agent context or live config.
  return spawnSync(process.execPath, [launcher, script, ...args], {
    cwd: root, env: { PATH: process.env.PATH, ...env }, input, encoding: "utf8", timeout: 15_000,
  });
}

function selectors(action: string, config = "/nonexistent/private-config.json") {
  return [action, "--config", config,
    ...(action === "status" || action === "close" ? ["--id", id, "--generation", generation] : []),
    ...(action === "prepare" || action === "close" ? ["--expected-digest", digest] : [])];
}

async function configFile(name: string, database: unknown, mode = 0o600) {
  const file = path.join(temporary, name);
  await fs.writeFile(file, JSON.stringify({ database }), { mode });
  return file;
}

it("shows the instance dispatch fence and host transition limits without opening a database", () => {
  const result = run(["--help"]);
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("inspect|prepare|status|close");
  expect(result.stdout).toContain("--expected-digest");
  expect(result.stdout).toContain("--generation");
  expect(result.stdout).toContain("instance");
  expect(result.stdout).toContain("dispatch fence");
  expect(result.stdout).toContain("changed kernel boot");
  expect(result.stdout).toContain("namespace drain");
  expect(result.stdout).toContain("does not reboot");
});

it.each(["inspect", "prepare", "status", "close"])("requires --config for %s before database loading", action => {
  const result = run([action]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Missing --config");
});

it.each([
  ["prepare", "--expected-digest"], ["status", "--id"], ["status", "--generation"],
  ["close", "--id"], ["close", "--generation"], ["close", "--expected-digest"],
])("requires exact %s selector %s before config loading", (action, missing) => {
  const args = selectors(action);
  const index = args.indexOf(missing);
  args.splice(index, 2);
  const result = run(args);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`Missing ${missing}`);
});

it.each(["--config", "--id", "--generation", "--expected-digest"])("rejects duplicate %s before configuration loading", flag => {
  const result = run([...selectors("close"), flag, "duplicate"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain(`Duplicate option: ${flag}`);
});

it.each(["--boot-id", "--pid-namespace", "--mount-namespace", "--namespace-drained", "--force", "--company-id", "--cwd"])(
  "rejects caller option %s before configuration loading", flag => {
    const result = run([...selectors("close"), flag, "caller-value"]);
    expect(result.status).toBe(2);
    expect(result.stderr).toContain(`Unknown option: ${flag}`);
  },
);

it("rejects an option missing its value before configuration loading", () => {
  const result = run(["inspect", "--config"]);
  expect(result.status).toBe(2);
  expect(result.stderr).toContain("Missing value: --config");
});

it.each(["PAPERCLIP_RUN_ID", "PAPERCLIP_AGENT_ID", "PAPERCLIP_API_KEY"])("rejects agent context %s before reading config", variable => {
  const result = run(selectors("inspect"), { [variable]: "private-agent-value" });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "host_operator_required" });
});

it.each(["DATABASE_URL", "DATABASE_MIGRATION_URL"])("rejects %s override before reading config", variable => {
  const result = run(selectors("inspect"), { [variable]: "postgres://secret@example.invalid/private" });
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "external_database_override_refused" });
});

it.each(["PAPERCLIP_BOOT_ID", "PAPERCLIP_HOST_BOOT_ID", "PAPERCLIP_PID_NAMESPACE", "PAPERCLIP_MOUNT_NAMESPACE"])(
  "rejects caller host proof environment %s before reading config", variable => {
    const result = run(selectors("inspect"), { [variable]: "caller-proof" });
    expect(result.status).toBe(1);
    expect(JSON.parse(result.stderr)).toEqual({ error: "caller_host_proof_refused" });
  },
);

it("refuses a public config before inspecting its database", async () => {
  const config = await configFile("public.json", { mode: "embedded-postgres" }, 0o644);
  const result = run(selectors("inspect", config));
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "private_operator_config_required" });
});

it("refuses malformed private config without exposing its contents", async () => {
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
])("refuses unsafe database configuration %# before database loading", async database => {
  const config = await configFile(`unsafe-${Math.random()}.json`, database);
  const result = run(selectors("inspect", config));
  expect(result.status).toBe(1);
  expect(JSON.parse(result.stderr)).toEqual({ error: "local_embedded_instance_required" });
});

it("inspects without mutation, prepares only an exact digest, and rejects stdin boot proof on the unchanged host", async () => {
  const database = await startEmbeddedPostgresTestDatabase("pc-epoch-cli-db-");
  const db = schema.createDb(database.connectionString);
  try {
    const rows = await db.execute<{ directory: string }>(sql`select current_setting('data_directory') as directory`);
    const port = Number(new URL(database.connectionString).port);
    const config = await configFile("embedded.json", {
      mode: "embedded-postgres", embeddedPostgresPort: port, embeddedPostgresDataDir: rows[0]!.directory,
    });
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(schema.companies).values({ id: companyId, name: "CLI isolated fixture", issuePrefix: "CLI" });
    await db.insert(schema.agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
    await db.insert(schema.heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "legacy",
      controllerBootId: randomUUID(), processPid: 2147480000, processGroupId: 2147480000, processStartedAt: new Date(0),
      contextSnapshot: { paperclipWorkspace: { cwd: path.join(temporary, "never-created-source") } } });
    await db.insert(schema.environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "released", releasedAt: new Date(3) });
    const beforeRuns = await db.select().from(schema.heartbeatRuns);
    const beforeLeases = await db.select().from(schema.environmentLeases);
    const beforeEvents = await db.select().from(schema.heartbeatRunEvents);
    const beforeAudit = await db.select().from(schema.activityLog);

    const inspected = run(selectors("inspect", config));
    expect(inspected.status, inspected.stderr).toBe(0);
    const capture = JSON.parse(inspected.stdout).result;
    expect(capture.cohort.map((entry: { runId: string }) => entry.runId)).toEqual([runId]);
    expect(capture.requiresHostEpochChange).toBe(true);
    expect(await db.execute(sql`select id from legacy_workspace_epoch_closures`)).toHaveLength(0);
    expect(await db.select().from(schema.activityLog)).toEqual(beforeAudit);

    const wrong = run(selectors("prepare", config));
    expect(wrong.status).toBe(1);
    expect(JSON.parse(wrong.stderr)).toEqual({ error: "historical_cohort_changed" });
    expect(await db.execute(sql`select id from legacy_workspace_epoch_closures`)).toHaveLength(0);

    const prepared = run(["prepare", "--config", config, "--expected-digest", capture.digest]);
    expect(prepared.status, prepared.stderr).toBe(0);
    const hold = JSON.parse(prepared.stdout).result;
    expect(hold.state).toBe("prepared");
    const exactSelectors = ["--config", config, "--id", hold.id, "--generation", hold.generation];
    const status = run(["status", ...exactSelectors]);
    expect(status.status, status.stderr).toBe(0);
    expect(JSON.parse(status.stdout).result).toEqual(hold);
    const closed = run(["close", ...exactSelectors, "--expected-digest", capture.digest], {},
      JSON.stringify({ bootId: randomUUID(), namespaceDrained: true }));
    expect(closed.status).toBe(1);
    expect(JSON.parse(closed.stderr)).toEqual({ error: "host_epoch_unchanged" });
    expect(await db.select().from(schema.heartbeatRuns)).toEqual(beforeRuns);
    expect(await db.select().from(schema.environmentLeases)).toEqual(beforeLeases);
    expect(await db.select().from(schema.heartbeatRunEvents)).toEqual(beforeEvents);
  } finally { await db.$client.end({ timeout: 1 }); await database.cleanup(); }
}, 60_000);
