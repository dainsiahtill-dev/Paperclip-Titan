import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, projects, projectWorkspaces, workspaceRuntimeServices, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import * as hostModule from "../services/legacy-workspace-host.js";
import { legacyWorkspaceEpochClosureService } from "../services/legacy-workspace-epoch-closure.js";
import * as epochModule from "../services/legacy-workspace-epoch-closure.js";
import { workspaceWriteOwnershipService } from "../services/workspace-write-ownership.js";
import { resetRuntimeServicesForTests, setWorkspaceRuntimeExposureDepsForTests, startRuntimeServicesForWorkspaceControl, type RealizedExecutionWorkspace } from "../services/workspace-runtime.js";

let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
let root: string;
beforeAll(async () => {
  database = await startEmbeddedPostgresTestDatabase("pc-runtime-epoch-fence-");
  db = createDb(database.connectionString);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-runtime-epoch-fence-"));
}, 30_000);
afterEach(async () => {
  await resetRuntimeServicesForTests({ terminateProcesses: true });
  vi.restoreAllMocks();
  await db.transaction(async transaction => {
    await transaction.execute(sql`set local client_min_messages = warning`);
    await transaction.execute(sql`truncate companies cascade`);
    await transaction.execute(sql`truncate legacy_workspace_epoch_closures, workspace_write_owners`);
  });
});
afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function fixture(linkedWorkspace = false) {
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
  const cwd = await fs.mkdtemp(path.join(root, "source-"));
  await db.insert(companies).values({ id: companyId, name: "Runtime epoch fence", issuePrefix: "FENCE" });
  await db.insert(agents).values({ id: agentId, companyId, name: "History", role: "engineer", adapterType: "codex_local" });
  const deletedCwd = path.join(root, `deleted-${randomUUID()}`);
  const projectId = linkedWorkspace ? randomUUID() : null, projectWorkspaceId = linkedWorkspace ? randomUUID() : null;
  const executionWorkspaceId = linkedWorkspace ? randomUUID() : null;
  if (linkedWorkspace) {
    await db.insert(projects).values({ id: projectId!, companyId, name: "Shared source parent" });
    await db.insert(projectWorkspaces).values({ id: projectWorkspaceId!, companyId, projectId: projectId!, name: "Primary", sourceType: "local_path", cwd });
    await db.insert(executionWorkspaces).values({ id: executionWorkspaceId!, companyId, projectId: projectId!, projectWorkspaceId,
      name: "Historical deleted execution", mode: "isolated_workspace", strategyType: "git_worktree", cwd: deletedCwd });
  }
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "succeeded", runtimeMode: "legacy",
    controllerBootId: randomUUID(), processPid: 2147480000, processGroupId: 2147480000, processStartedAt: new Date(0),
    contextSnapshot: { paperclipWorkspace: { cwd: deletedCwd } } });
  await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, executionWorkspaceId, provider: "local", status: "released", releasedAt: new Date(3) });
  const actual = hostModule.readLegacyWorkspaceHost, oldBoot = randomUUID();
  let before = true;
  // Host transition simulation only; database, source checks and runtime entry remain real.
  vi.spyOn(hostModule, "readLegacyWorkspaceHost").mockImplementation(async transaction => {
    const host = await actual(transaction);
    return before ? { ...host, bootId: oldBoot } : host;
  });
  const closure = legacyWorkspaceEpochClosureService(db);
  const capture = await closure.inspect(), prepared = await closure.prepare({ expectedDigest: capture.digest });
  const workspace: RealizedExecutionWorkspace = { baseCwd: cwd, cwd, source: "agent_home", strategy: "project_primary", projectId,
    workspaceId: projectWorkspaceId, repoUrl: null, repoRef: null, branchName: null, worktreePath: null, warnings: [], created: false, branchCreatedByRuntime: false };
  return { cwd, companyId, workspace, closure, prepared, capture, nextEpoch: () => { before = false; } };
}

it("blocks Board provisioning before its command or new registry row and leaves formal closure unpoisoned", async () => {
  const f = await fixture(), sentinel = path.join(f.cwd, "epoch-bypass");
  const result = await startRuntimeServicesForWorkspaceControl({ db, actor: { id: null, name: "Board", companyId: f.companyId }, issue: null,
    workspace: f.workspace, adapterEnv: {}, config: { runtimeProvisionCommand: "touch epoch-bypass", workspaceRuntime: { services: [{ name: "web",
      command: "true", lifecycle: "shared", reuseScope: "execution_workspace", stopPolicy: { type: "manual" } }] } },
  }).then(() => null, error => error);
  expect.soft(result).toMatchObject({ status: 409, details: { code: "workspace_legacy_epoch_prepared" } });
  expect.soft(await db.select().from(workspaceRuntimeServices)).toEqual([]);
  expect.soft(await fs.stat(sentinel).then(() => true, () => false)).toBe(false);
  f.nextEpoch();
  await expect(f.closure.close({ id: f.prepared.id, generation: f.prepared.generation, expectedDigest: f.capture.digest }))
    .resolves.toMatchObject({ state: "closed", closure: { proof: "host_epoch_closed" } });
});

it("serializes actual Board start before parent locks while a protected claim verifies closed workspace history", async () => {
  const f = await fixture(true);
  f.nextEpoch();
  await f.closure.close({ id: f.prepared.id, generation: f.prepared.generation, expectedDigest: f.capture.digest });
  let signalProof!: () => void, releaseProof!: () => void;
  const proofEntered = new Promise<void>(resolve => { signalProof = resolve; });
  const proofBarrier = new Promise<void>(resolve => { releaseProof = resolve; });
  const actual = epochModule.legacyWorkspaceEpochClosedRunIds;
  // Pause only timing: the real claim already holds the realm lock, and the
  // original verifier still acquires all real history/project SHARE locks.
  vi.spyOn(epochModule, "legacyWorkspaceEpochClosedRunIds").mockImplementation(async (transaction, realm) => {
    signalProof();
    await proofBarrier;
    return actual(transaction, realm);
  });
  const claimed = workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })
    .then(value => ({ value }), error => ({ error }));
  await proofEntered;
  const started = startRuntimeServicesForWorkspaceControl({ db, actor: { id: null, name: "Board", companyId: f.companyId }, issue: null,
    workspace: f.workspace, adapterEnv: {}, config: { workspaceRuntime: { services: [{ name: "web", command: "touch epoch-lock-bypass",
      lifecycle: "shared", reuseScope: "project_workspace", stopPolicy: { type: "manual" } }] } },
  }).then(value => ({ value }), error => ({ error }));
  try {
    const deadline = Date.now() + 5_000;
    let waiting = false;
    while (Date.now() < deadline) {
      const rows = await db.execute<{ waiting: boolean }>(sql`select exists(select 1 from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and wait_event = 'advisory') as waiting`);
      if (rows[0]?.waiting) { waiting = true; break; }
      await delay(20);
    }
    expect(waiting).toBe(true);
  } finally { releaseProof(); }
  expect.soft(await claimed).toMatchObject({ value: { outcome: "claimed" } });
  expect.soft(await started).toMatchObject({ error: { status: 409, details: { code: "workspace_write_owner_busy" } } });
  expect(await fs.stat(path.join(f.cwd, "epoch-lock-bypass")).then(() => true, () => false)).toBe(false);
  expect(await db.select().from(workspaceRuntimeServices)).toEqual([]);
});

it("rejects an exposed reservation before inserting a new runtime row or launching its backend", async () => {
  const f = await fixture(), sentinel = path.join(f.cwd, "exposed-epoch-bypass");
  let reservedPorts: number[] = [];
  let activeReservation: string | null = null;
  setWorkspaceRuntimeExposureDepsForTests({
    broker: {
      async reserve(_runtimeId, listeners) {
        reservedPorts = listeners.map(listener => listener.port);
        activeReservation = "runtime-epoch-fence-reservation";
        return { handle: activeReservation, reservedPorts };
      },
      async expose() { throw new Error("Backend must never request publication"); },
      async remove() { activeReservation = null; return { removedPorts: reservedPorts }; },
      async list() { return []; },
    },
    isPortAvailable: async () => true, isBrokerAvailable: async () => true,
    resolveHostname: async () => "fixture.example.ts.net", probeHealth: async () => true, now: () => new Date().toISOString(),
  });
  const result = await startRuntimeServicesForWorkspaceControl({ db, actor: { id: null, name: "Board", companyId: f.companyId }, issue: null,
    workspace: f.workspace, adapterEnv: {}, config: { workspaceRuntime: { services: [{ name: "web", command: "touch exposed-epoch-bypass",
      lifecycle: "shared", reuseScope: "execution_workspace", port: { type: "auto", envKey: "PORT" }, stopPolicy: { type: "manual" },
      expose: { type: "tailscale_https", hostname: "auto", publicPort: "same", includePaperclipViteHmr: false, failurePolicy: "fail_closed" },
    }] } },
  }).then(() => null, error => error);
  expect.soft(result).toMatchObject({ status: 409, details: { code: "workspace_legacy_epoch_prepared" } });
  expect.soft(await db.select().from(workspaceRuntimeServices)).toEqual([]);
  expect.soft(await fs.stat(sentinel).then(() => true, () => false)).toBe(false);
  expect.soft(activeReservation).toBeNull();
  f.nextEpoch();
  await expect(f.closure.close({ id: f.prepared.id, generation: f.prepared.generation, expectedDigest: f.capture.digest }))
    .resolves.toMatchObject({ state: "closed" });
});
