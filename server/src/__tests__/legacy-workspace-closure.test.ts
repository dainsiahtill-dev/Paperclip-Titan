import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { withWorkspaceProcessGuard, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { workspaceNamespaceDrained, type WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { workspaceWriteOwnershipService, physicalWorkspaceIdentity } from "../services/workspace-write-ownership.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { recordLegacyProcessIdentity } from "../services/legacy-process-capacity.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
let root: string;
beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("pc-legacy-closure-"); db = createDb(temporary.connectionString); root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-legacy-closure-")); }, 20_000);
afterEach(() => vi.restoreAllMocks());
afterAll(async () => { await temporary?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function implementation() {
  const filename = "../services/legacy-workspace-closure.js";
  const module = await import(filename).catch(() => ({} as any));
  expect(module.legacyWorkspaceClosureService).toBeTypeOf("function");
  return module.legacyWorkspaceClosureService(db);
}

async function hostEpoch() {
  const filename = "../services/legacy-workspace-host.js";
  const module = await import(filename).catch(() => ({} as any));
  expect(module.readLegacyWorkspaceHost).toBeTypeOf("function");
  const actual = module.readLegacyWorkspaceHost;
  const live = await actual(db);
  const previousBoot = randomUUID();
  let previous = true;
  // Only this test models the captured older kernel epoch. Actual guarded
  // subprocesses, /proc drain and Stop remain real, unmocked kernel operations.
  vi.spyOn(module, "readLegacyWorkspaceHost").mockImplementation(async (...args: any[]) => {
    const observed = await actual(...args);
    return previous ? { ...observed, bootId: previousBoot } : observed;
  });
  return { live, boot: previousBoot, namespace: live.pidNamespace, next: () => { previous = false; } };
}

async function fixture(status = "succeeded", host?: { boot: string; namespace: string }, processPid = 2147480000, within?: { cwd: string; companyId: string; agentId: string }) {
  const cwd = within?.cwd ?? await fs.mkdtemp(path.join(root, "original-"));
  const companyId = within?.companyId ?? randomUUID(), agentId = within?.agentId ?? randomUUID(), runId = randomUUID();
  if (!within) {
    await db.insert(companies).values({ id: companyId, name: "Private migration fixture", issuePrefix: randomUUID().slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  }
  const bootId = host?.boot ?? (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim();
  const namespace = host?.namespace ?? await fs.readlink("/proc/self/ns/pid");
  const controllerBootId = randomUUID(), processStartedAt = new Date(0);
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "legacy", status,
    controllerBootId, controllerLeaseExpiresAt: new Date(1), processPid, processGroupId: processPid, processStartedAt,
    finishedAt: new Date(2), contextSnapshot: { paperclipWorkspace: { cwd } } });
  const payload = { controllerBootId, processPid, processGroupId: processPid, processStartedAt: processStartedAt.toISOString(),
    localProcess: true, localNamespace: createHash("sha256").update(`${bootId}\n${namespace}`).digest("hex") };
  await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "legacy.process_identity_recorded", stream: "system", payload });
  await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "legacy.local_process_stopped", stream: "system", payload });
  await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local",
    status: status === "succeeded" ? "released" : "failed", releasedAt: new Date(3) });
  return { cwd, companyId, agentId, runId, payload };
}

async function prepare(service: any, f: Awaited<ReturnType<typeof fixture>>) {
  const inspection = await service.inspect({ companyId: f.companyId, cwd: f.cwd });
  return service.prepare({ companyId: f.companyId, cwd: f.cwd, expectedDigest: inspection.digest });
}

it("never treats a released migration marker with an old run ID as ordinary tracked ownership", async () => {
  const f = await fixture(); const identity = await physicalWorkspaceIdentity(f.cwd);
  await db.insert(workspaceWriteOwners).values({ ...{ resourceKey: identity.resourceKey, realm: identity.realm, canonicalRoot: identity.root, device: identity.device, inode: identity.inode },
    companyId: f.companyId, runId: f.runId, state: "released", releasedAt: new Date(),
    history: [{ kind: "LEGACY_WORKSPACE_MIGRATION", event: "prepared", version: 1 }] });
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("does not trust mere ordinary owner membership or a missing parent PID with a retained group", async () => {
  const f = await fixture(); const identity = await physicalWorkspaceIdentity(f.cwd);
  await db.insert(workspaceWriteOwners).values({ resourceKey: identity.resourceKey, realm: identity.realm, canonicalRoot: identity.root, device: identity.device, inode: identity.inode,
    companyId: f.companyId, runId: f.runId, state: "released", releasedAt: new Date(), history: [{ event: "claimed" }] });
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  const groupOnly = await fixture();
  await db.update(heartbeatRuns).set({ processPid: null }).where(eq(heartbeatRuns.id, groupOnly.runId));
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: groupOnly.cwd, companyId: groupOnly.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("does not let an unprotected observation at A hide a lease/source pointer moved to B", async () => {
  const f = await fixture();
  await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, f.runId));
  const service = workspaceWriteOwnershipService(db);
  expect((await service.claim({ cwd: f.cwd, companyId: f.companyId, runId: f.runId, observeUnprotected: true })).outcome).toBe("claimed");
  const moved = await fs.mkdtemp(path.join(root, "moved-"));
  await db.update(heartbeatRuns).set({ contextSnapshot: { paperclipWorkspace: { cwd: moved } } }).where(eq(heartbeatRuns.id, f.runId));
  expect(await service.claim({ cwd: moved, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("inspection is read-only and preparation binds one precise historical cohort without editing it", async () => {
  const f = await fixture(); const service = await implementation();
  const beforeRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  const beforeEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
  const inspection = await service.inspect({ companyId: f.companyId, cwd: f.cwd });
  expect(inspection.cohort.map((entry: any) => entry.runId)).toEqual([f.runId]);
  expect(await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.companyId, f.companyId))).toEqual([]);
  const hold = await prepare(service, f);
  expect(hold.state).toBe("legacy_migration_hold");
  expect(hold.runId).not.toBe(f.runId);
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  await expect(service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation })).rejects.toMatchObject({ code: "host_epoch_unchanged" });
  expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual(beforeRuns);
  expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toEqual(beforeEvents);
});

it.each(["succeeded", "timed_out", "escaped_child"])("same original directory survives modeled epoch closure, actual write, Stop and second dispatch (%s)", async scenario => {
  const service = await implementation(); const epoch = await hostEpoch();
  const f = await fixture(scenario === "succeeded" ? "succeeded" : "timed_out", epoch);
  let child: ReturnType<typeof spawn> | undefined;
  try {
    if (scenario === "escaped_child") {
      child = spawn(process.execPath, ["-e", "require('node:fs').writeFileSync('old-child-ready','ready');setTimeout(()=>require('node:fs').writeFileSync('old-child-effect','old'),150);setInterval(()=>{},1000)"], { cwd: f.cwd, detached: true, stdio: "ignore" });
      await vi.waitFor(async () => expect(await fs.readFile(path.join(f.cwd, "old-child-ready"), "utf8")).toBe("ready"));
    }
    const originalRuns = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
    const originalEvents = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId));
    const hold = await prepare(service, f);
    const input = { companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation };
    await expect(service.close(input)).rejects.toMatchObject({ code: "host_epoch_unchanged" });
    expect(await workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
    if (child) {
      await vi.waitFor(async () => expect(await fs.readFile(path.join(f.cwd, "old-child-effect"), "utf8")).toBe("old"));
      const exited = once(child, "close"); child.kill("SIGTERM"); await exited;
    }
    epoch.next();
    const closed = await service.close(input);
    expect(closed.state).toBe("legacy_migration_closed");
    expect(closed.stopReceipt).toBeNull();
    expect(closed.history.at(-1)).toMatchObject({ event: "host_boot_epoch_closed", proof: "host_boot_epoch_closed" });
    expect(await service.close(input)).toMatchObject({ id: closed.id, state: "legacy_migration_closed" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId))).toEqual(originalRuns);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, f.runId))).toEqual(originalEvents);
    const ownership = workspaceWriteOwnershipService(db);
    const first = await ownership.claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() });
    expect(first.outcome).toBe("claimed"); if (first.outcome !== "claimed") throw new Error("first dispatch not admitted");
    const abort = new AbortController(); let identity: WorkspaceLaunchIdentity | undefined;
    const guard = ownership.guard(first.owner, abort.signal); const bind = guard.bindPayload;
    guard.bindPayload = async value => { await bind!(value); identity = value; };
    await withWorkspaceProcessGuard(guard, () => runChildProcess("first-dispatch", process.execPath,
      ["-e", "const fs=require('node:fs');fs.writeFileSync('first-effect','first');console.log('stop-ready');setTimeout(()=>fs.writeFileSync('late-effect','unsafe'),1500);setInterval(()=>{},1000)"],
      { cwd: f.cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async (_stream, text) => { if (text.includes("stop-ready")) abort.abort(); } }));
    expect(await fs.readFile(path.join(f.cwd, "first-effect"), "utf8")).toBe("first");
    expect(await workspaceNamespaceDrained(identity!)).toBe(true);
    expect(await fs.readFile(path.join(f.cwd, "late-effect"), "utf8").catch(() => null)).toBeNull();
    expect(await ownership.confirmStopped(first.owner, randomUUID())).toMatchObject({ proof: "namespace_drained" });
    await ownership.releaseIfStopped(first.owner);
    const second = await ownership.claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() });
    expect(second.outcome).toBe("claimed"); if (second.outcome !== "claimed") throw new Error("second dispatch not admitted");
    const result = await withWorkspaceProcessGuard(ownership.guard(second.owner), () => runChildProcess("second-dispatch", process.execPath,
      ["-e", "require('node:fs').writeFileSync('second-effect','second')"], { cwd: f.cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {} }));
    expect(result.exitCode).toBe(0); expect(await fs.readFile(path.join(f.cwd, "second-effect"), "utf8")).toBe("second");
    await ownership.releaseIfStopped(second.owner);
    expect((await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, hold.id)))[0]?.history).toEqual(closed.history);
  } finally { if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill("SIGTERM"); await exited; } }
});

it("refuses stale inspection, wrong generation and changed run/ledger/lease facts", async () => {
  const service = await implementation(); const epoch = await hostEpoch(); const f = await fixture("timed_out", epoch);
  const inspection = await service.inspect({ companyId: f.companyId, cwd: f.cwd });
  await appendHeartbeatRunEvent(db, { companyId: f.companyId, runId: f.runId, agentId: f.agentId, eventType: "probe.new_evidence", stream: "system", payload: {} });
  await expect(service.prepare({ companyId: f.companyId, cwd: f.cwd, expectedDigest: inspection.digest })).rejects.toMatchObject({ code: "inspection_changed" });
  const hold = await prepare(service, f); epoch.next();
  await expect(service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: randomUUID() })).rejects.toMatchObject({ code: "selector_mismatch" });
  await db.update(heartbeatRuns).set({ processPid: 2147480001 }).where(eq(heartbeatRuns.id, f.runId));
  await expect(service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation })).rejects.toMatchObject({ code: "cohort_changed" });
  expect((await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, hold.id)))[0]?.releasedAt).toBeNull();
});

it("serializes preparations and refuses caller supplied boot facts, foreign company and replaced source", async () => {
  const service = await implementation(); const epoch = await hostEpoch(); const f = await fixture("succeeded", epoch);
  const inspection = await service.inspect({ companyId: f.companyId, cwd: f.cwd });
  const results = await Promise.allSettled([1, 2].map(() => service.prepare({ companyId: f.companyId, cwd: f.cwd, expectedDigest: inspection.digest })));
  expect(results.filter(r => r.status === "fulfilled")).toHaveLength(1);
  const hold = (results.find(r => r.status === "fulfilled") as PromiseFulfilledResult<any>).value;
  await expect(service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation, bootId: randomUUID() })).rejects.toThrow();
  epoch.next();
  await expect(service.close({ companyId: randomUUID(), cwd: f.cwd, holdId: hold.id, generation: hold.generation })).rejects.toMatchObject({ code: "selector_mismatch" });
  await fs.rename(f.cwd, f.cwd + "-retained"); await fs.mkdir(f.cwd);
  await expect(service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation })).rejects.toMatchObject({ code: "source_identity_changed" });
});

it("does not let closed proof cover changed execution identity or a different source request", async () => {
  const service = await implementation(); const epoch = await hostEpoch(); const f = await fixture("succeeded", epoch);
  const hold = await prepare(service, f); epoch.next(); await service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation });
  await db.update(heartbeatRuns).set({ processStartedAt: new Date(123) }).where(eq(heartbeatRuns.id, f.runId));
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  const other = await fs.mkdtemp(path.join(root, "different-"));
  const unrelated = await workspaceWriteOwnershipService(db).claim({ cwd: other, companyId: f.companyId, runId: randomUUID() });
  expect(unrelated.outcome).toBe("claimed");
});

it("invalidates a closed cohort if another captured execution changes, and binds the selected database", async () => {
  const service = await implementation(); const epoch = await hostEpoch(); const f = await fixture("succeeded", epoch);
  const other = await fixture("timed_out", epoch, 2147480001, f);
  const hold = await prepare(service, f); epoch.next(); await service.close({ companyId: f.companyId, cwd: f.cwd, holdId: hold.id, generation: hold.generation });
  await db.update(heartbeatRuns).set({ processStartedAt: new Date(999) }).where(eq(heartbeatRuns.id, other.runId));
  const filename = "../services/legacy-workspace-closure.js"; const module = await import(filename);
  const firstRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId)))[0]!;
  const proof = await db.transaction(async tx => module.legacyWorkspaceCandidateClosed(tx as unknown as Db, firstRun,
    await physicalWorkspaceIdentity(f.cwd), await tx.select().from(workspaceWriteOwners)));
  expect(proof).toBe(false);
  expect(await workspaceWriteOwnershipService(db).claim({ cwd: f.cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  await expect(module.legacyWorkspaceClosureService(db, { databaseDirectory: "/not-this-instance" }).inspect({ companyId: f.companyId, cwd: f.cwd })).rejects.toMatchObject({ code: "host_instance_changed" });
});

it("retains normal guarded admission with a real host process binding after its namespace drains", async () => {
  const cwd = await fs.mkdtemp(path.join(root, "guarded-"));
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Guarded binding fixture", issuePrefix: randomUUID().slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "legacy", status: "running", controllerBootId: randomUUID(), contextSnapshot: { paperclipWorkspace: { cwd } } });
  await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "active" });
  const service = workspaceWriteOwnershipService(db);
  const first = await service.claim({ cwd, companyId, runId }); expect(first.outcome).toBe("claimed");
  if (first.outcome !== "claimed") throw new Error("first guarded binding failed");
  const result = await withWorkspaceProcessGuard(service.guard(first.owner, undefined, undefined, undefined, agentId), () => runChildProcess("bound-writer", process.execPath,
    ["-e", "require('node:fs').writeFileSync('effect','bound')"], { cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
      onSpawn: async meta => {
        const [run] = await db.update(heartbeatRuns).set({ processPid: meta.pid, processGroupId: meta.processGroupId, processStartedAt: new Date(meta.startedAt) }).where(eq(heartbeatRuns.id, runId)).returning();
        await recordLegacyProcessIdentity(db, run!);
      } }));
  expect(result.exitCode).toBe(0);
  await service.releaseIfStopped(first.owner);
  const stored = (await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, first.owner.id)))[0]!;
  expect(stored.history.some(event => event.event === "run_process_bound")).toBe(true);
  const successor = await service.claim({ cwd, companyId, runId: randomUUID() });
  expect(successor.outcome).toBe("claimed");
  if (successor.outcome !== "claimed") throw new Error("tracked successor failed");
  await service.releaseIfStopped(successor.owner);
  const provenance = await import("../services/workspace-owner-provenance.js");
  const currentRun = (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)))[0]!;
  const v1 = { ...stored, history: stored.history.filter(event => event.event !== "run_process_bound") };
  const historical = await db.transaction(async tx => provenance.workspaceRunHasTrackedOwner(tx as unknown as Db, currentRun, await physicalWorkspaceIdentity(cwd), [v1]));
  expect(historical).toBe(true);
  const namespaceModule = await import("@paperclipai/adapter-utils/workspace-process-guard");
  const currentProbe = vi.spyOn(namespaceModule, "workspaceNamespaceDrained").mockResolvedValue(false);
  const rebound = await service.claim({ cwd, companyId, runId: randomUUID() });
  expect(rebound.outcome).toBe("claimed");
  expect(currentProbe).not.toHaveBeenCalled();
  if (rebound.outcome !== "claimed") throw new Error("durable proof successor failed");
  await service.releaseIfStopped(rebound.owner);
  await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "legacy.process_identity_recorded", stream: "system", payload: {
    controllerBootId: currentRun.controllerBootId, processPid: currentRun.processPid, processGroupId: currentRun.processGroupId,
    processStartedAt: currentRun.processStartedAt!.toISOString(), localProcess: false, localNamespace: "foreign" } });
  const reopened = await db.transaction(async tx => provenance.workspaceRunHasTrackedOwner(tx as unknown as Db, currentRun, await physicalWorkspaceIdentity(cwd), [v1]));
  expect(reopened).toBe(false);
  const reopenedNew = await db.transaction(async tx => provenance.workspaceRunHasTrackedOwner(tx as unknown as Db, currentRun, await physicalWorkspaceIdentity(cwd), [stored]));
  expect(reopenedNew).toBe(false);
});
