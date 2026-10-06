import { randomUUID, createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, heartbeatRuns, heartbeatRunEvents, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { workspaceWriteOwnershipService } from "../services/workspace-write-ownership.js";
import { withWorkspaceProcessGuard, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { readLegacyWorkspaceHost } from "../services/legacy-workspace-host.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>, db: Db, directory: string;
beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("pc-namespace-close-"); db = createDb(temporary.connectionString); directory = await fs.mkdtemp(path.join(os.tmpdir(), "pc-namespace-cases-")); }, 20_000);
afterAll(async () => { await temporary?.cleanup(); if (directory) await fs.rm(directory, { recursive: true, force: true }); });

async function fixture(live = false) {
  const cwd = await fs.mkdtemp(path.join(directory, "case-")), companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID(), controllerBootId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Namespace proof", issuePrefix: `N${companyId.slice(0, 6)}` });
  await db.insert(agents).values({ id: agentId, companyId, name: "CLI", adapterType: "codex_local" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "legacy", status: "running", controllerBootId,
    startedAt: new Date(), contextSnapshot: { paperclipWorkspace: { cwd } } });
  const ownership = workspaceWriteOwnershipService(db), claim = await ownership.claim({ cwd, companyId, runId });
  if (claim.outcome !== "claimed") throw new Error("Expected ownership");
  let identity!: WorkspaceLaunchIdentity;
  const controller = new AbortController(); let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const guard = ownership.guard(claim.owner, controller.signal), bind = guard.bindLaunch;
  guard.bindLaunch = async value => { identity = value; await bind(value); };
  guard.recordDrain = async () => { throw new Error("fixture persistence unavailable"); };
  const pending = withWorkspaceProcessGuard(guard, () => runChildProcess(runId, "/bin/sh", ["-c", live ? "printf ready; sleep 10" : "printf verified > report"], {
    cwd, env: {}, timeoutSec: live ? 10 : 3, graceSec: 1, onLog: async (_stream, text) => { if (text.includes("ready")) ready(); }, onSpawn: async info => {
      await db.update(heartbeatRuns).set({ processPid: info.pid, processGroupId: info.processGroupId, processStartedAt: new Date(info.startedAt) }).where(eq(heartbeatRuns.id, runId));
      await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 1, eventType: "legacy.process_identity_recorded", stream: "system", payload: {
        processPid: info.pid, processGroupId: info.processGroupId, processStartedAt: info.startedAt, controllerBootId, localProcess: true,
        localNamespace: createHash("sha256").update(`${identity.bootId}\n${identity.observerNamespace}`).digest("hex"),
      } });
    },
  }));
  if (live) { await started; await ownership.markUnknown(claim.owner, identity.launchId); }
  else await expect(pending).rejects.toThrow("fixture persistence unavailable");
  await db.update(heartbeatRuns).set({ status: "failed", error: "retained failure", finishedAt: new Date() }).where(eq(heartbeatRuns.id, runId));
  const request = { companyId, cwd, ownerId: claim.owner.id, generation: claim.owner.generation, launchId: identity.launchId };
  return { request, runId, identity, controller, pending };
}

async function service() {
  const module = await import("../services/workspace-namespace-closure.js").catch(() => ({} as any));
  if (!module.workspaceNamespaceClosureService) throw new Error("formal namespace reconciliation unavailable");
  return module.workspaceNamespaceClosureService(db);
}

it("formally closes an unknown guarded namespace after actual exit without changing failed runs or events", async () => {
  const f = await fixture(), closure = await service();
  const beforeRun = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  const beforeEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
  const inspected = await closure.inspect(f.request);
  expect(inspected.namespaceDrained).toBe(true);
  const closed = await closure.close({ ...f.request, expectedDigest: inspected.digest });
  expect(closed).toMatchObject({ state: "released", proof: "namespace_drained" });
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual(beforeRun);
  expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toEqual(beforeEvents);
  const [owner] = await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, f.request.ownerId));
  expect(owner.history).toContainEqual(expect.objectContaining({ event: "unknown" }));
  expect(owner.history).toContainEqual(expect.objectContaining({ event: "namespace_drained", generation: f.request.generation, launchId: f.request.launchId }));
  expect(owner.stopReceipt).toMatchObject({ ...f.identity, generation: f.request.generation, verification: "local_operator" });
  await db.insert(heartbeatRunEvents).values({ companyId: f.request.companyId, runId: f.runId, agentId: beforeRun[0].agentId, seq: 2, eventType: "system", message: "Later operator annotation" });
  expect(await closure.close({ ...f.request, expectedDigest: inspected.digest })).toMatchObject({ state: "released", proof: "namespace_drained", alreadyClosed: true });
  expect((await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, f.request.ownerId)))[0]).toEqual(owner);
});

it.each(["digest", "generation", "launch", "company", "source", "binding", "running"])("refuses changed or unverified reconciliation evidence: %s", async mode => {
  const f = await fixture(), closure = await service(), inspected = await closure.inspect(f.request);
  const request = { ...f.request, expectedDigest: inspected.digest };
  if (mode === "digest") request.expectedDigest = "0".repeat(64);
  if (mode === "generation") request.generation = randomUUID();
  if (mode === "launch") request.launchId = randomUUID();
  if (mode === "company") request.companyId = randomUUID();
  if (mode === "source") request.cwd = directory;
  if (mode === "binding") await db.delete(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
  if (mode === "running") await db.update(heartbeatRuns).set({ status: "running", finishedAt: null }).where(eq(heartbeatRuns.id, f.runId));
  await expect(closure.close(request)).rejects.toThrow();
  expect((await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, f.request.ownerId)))[0].state).toBe("unknown");
});

it("does not close a still-live namespace even when its logical run is terminal", async () => {
  const f = await fixture(true), closure = await service();
  try {
    const inspected = await closure.inspect(f.request);
    expect(inspected.namespaceDrained).toBe(false);
    await expect(closure.close({ ...f.request, expectedDigest: inspected.digest })).rejects.toThrow("namespace_exit_unverified");
    expect((await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, f.request.ownerId)))[0].state).toBe("unknown");
  } finally { f.controller.abort(); await f.pending.catch(() => undefined); }
});

it("rejects operator inspection when the proc filesystem metadata is not kernel procfs", async () => {
  const actual = await fs.statfs("/proc");
  const metadata = vi.spyOn(fs, "statfs").mockResolvedValueOnce({ ...actual, type: 0x01021994 });
  try { await expect(readLegacyWorkspaceHost(db)).rejects.toThrow("host_database_unverified"); }
  finally { metadata.mockRestore(); }
});

it("rejects a namespace descriptor without genuine nsfs metadata", async () => {
  const actual = fs.statfs.bind(fs);
  const metadata = vi.spyOn(fs, "statfs").mockImplementation((async (pathname: any, options: any) => {
    const observed = await actual(pathname, options);
    return /^\/proc\/self\/fd\/\d+$/.test(String(pathname)) ? { ...observed, type: 0x01021994 } : observed;
  }) as any);
  try { await expect(readLegacyWorkspaceHost(db)).rejects.toThrow("host_database_unverified"); }
  finally { metadata.mockRestore(); }
});
