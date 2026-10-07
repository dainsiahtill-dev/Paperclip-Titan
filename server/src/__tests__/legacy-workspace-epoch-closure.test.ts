import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { afterAll, afterEach, beforeAll, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import * as schema from "@paperclipai/db";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import * as hostModule from "../services/legacy-workspace-host.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { withWorkspaceProcessGuard, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import { workspaceNamespaceDrained, type WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { workspaceWriteOwnershipService, physicalWorkspaceIdentity } from "../services/workspace-write-ownership.js";
import { recordLegacyProcessIdentity } from "../services/legacy-process-capacity.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
let root: string;
beforeAll(async () => {
  temporary = await startEmbeddedPostgresTestDatabase("pc-legacy-epoch-");
  db = createDb(temporary.connectionString);
  root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-legacy-epoch-"));
}, 20_000);
afterEach(async () => {
  vi.restoreAllMocks();
  await db.transaction(async tx => {
    await tx.execute(sql`set local client_min_messages = warning`);
    await tx.execute(sql`truncate companies cascade`);
    if ((schema as any).legacyWorkspaceEpochClosures) await tx.execute(sql`truncate legacy_workspace_epoch_closures, workspace_write_owners`);
  });
});
afterAll(async () => { await temporary?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

async function implementation() {
  const filename = "../services/legacy-workspace-epoch-closure.js";
  const module = await import(filename).catch(() => ({} as any));
  expect(module.legacyWorkspaceEpochClosureService).toBeTypeOf("function");
  return { ...module, service: module.legacyWorkspaceEpochClosureService(db) };
}

async function fixture(options: { cwd?: string; status?: string; runtimeMode?: string; emptyProcess?: boolean } = {}) {
  const cwd = options.cwd ?? path.join(root, `deleted-private-${randomUUID()}`);
  const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Epoch fixture", issuePrefix: randomUUID().slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: options.status ?? "succeeded", runtimeMode: options.runtimeMode ?? "legacy",
    controllerBootId: options.emptyProcess ? null : randomUUID(), processPid: options.emptyProcess ? null : 2147480000,
    processGroupId: options.emptyProcess ? null : 2147480000, processStartedAt: new Date(0),
    contextSnapshot: { paperclipWorkspace: { cwd } } });
  await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "released", releasedAt: new Date(3) });
  // No identity event: exactly the unknown historical lifetime this governance covers.
  await appendHeartbeatRunEvent(db, { companyId, agentId, runId, eventType: "fixture.historical_output", stream: "stdout", payload: { text: "preserve verbatim" } });
  return { cwd, companyId, agentId, runId };
}

async function simulatedEpoch() {
  const actual = hostModule.readLegacyWorkspaceHost;
  const oldBoot = randomUUID();
  let before = true;
  // Simulation of an older boot only. Database authentication and all filesystem
  // checks remain real. This is not proof of a real host epoch transition.
  vi.spyOn(hostModule, "readLegacyWorkspaceHost").mockImplementation(async tx => {
    const host = await actual(tx);
    return before ? { ...host, bootId: oldBoot } : host;
  });
  return { next: () => { before = false; } };
}

it("captures deleted roots and missing identity events without mutating historical rows", async () => {
  const f = await fixture({ emptyProcess: true });
  const { service } = await implementation();
  const beforeRuns = await db.select().from(heartbeatRuns);
  const beforeEvents = await db.select().from(heartbeatRunEvents);
  const beforeLeases = await db.select().from(environmentLeases);
  const capture = await service.inspect();
  expect(capture.cohort.map((entry: any) => entry.runId)).toEqual([f.runId]);
  expect(capture.requiresHostEpochChange).toBe(true);
  expect(await db.select().from((schema as any).legacyWorkspaceEpochClosures)).toEqual([]);
  const hold = await service.prepare({ expectedDigest: capture.digest });
  expect(hold.state).toBe("prepared");
  expect(hold.manifest.cohort[0].process.controllerBootId).toBeNull();
  await expect(service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest })).rejects.toMatchObject({ code: "host_epoch_unchanged" });
  expect(await db.select().from(heartbeatRuns)).toEqual(beforeRuns);
  expect(await db.select().from(heartbeatRunEvents)).toEqual(beforeEvents);
  expect(await db.select().from(environmentLeases)).toEqual(beforeLeases);
});

it("closes a simulated older epoch once and discounts only its exact unchanged cohort", async () => {
  const epoch = await simulatedEpoch();
  const a = await fixture(), b = await fixture();
  const { service, legacyWorkspaceEpochClosedRunIds } = await implementation();
  const capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest });
  expect((await service.prepare({ expectedDigest: capture.digest })).id).toBe(hold.id);
  epoch.next();
  const closeInput = { id: hold.id, generation: hold.generation, expectedDigest: capture.digest };
  const closed = await service.close(closeInput);
  expect(closed.state).toBe("closed");
  expect(closed.closure.proof).toBe("host_epoch_closed");
  const auditCount = (await db.select().from(schema.activityLog)).length;
  expect(await service.close(closeInput)).toEqual(closed);
  expect((await db.select().from(schema.activityLog)).length).toBe(auditCount);
  expect(await service.status({ id: hold.id, generation: hold.generation })).toEqual(closed);
  const admitted = await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm));
  expect([...admitted].sort()).toEqual([a.runId, b.runId].sort());
  await fs.mkdir(a.cwd);
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(admitted);
  await db.update(heartbeatRuns).set({ resultJson: { changed: true } }).where(eq(heartbeatRuns.id, a.runId));
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(new Set());
});

it.each(["running", "native", "mixed_lease"])("refuses unsafe captured history: %s", async reason => {
  const f = await fixture({ status: reason === "running" ? "running" : "succeeded", runtimeMode: reason === "native" ? "native" : "legacy" });
  if (reason === "mixed_lease") await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "remote" });
  const { service } = await implementation();
  await expect(service.inspect()).rejects.toMatchObject({ code: "historical_execution_unverified" });
  expect(await db.select().from((schema as any).legacyWorkspaceEpochClosures)).toEqual([]);
});

it.each(["run", "lease", "event", "new_run", "source_restored"])("refuses cohort drift before closure: %s", async mutation => {
  const epoch = await simulatedEpoch(), f = await fixture();
  const { service } = await implementation();
  const capture = await service.inspect(), hold = await service.prepare({ expectedDigest: capture.digest });
  if (mutation === "run") await db.update(heartbeatRuns).set({ stdoutExcerpt: "changed" }).where(eq(heartbeatRuns.id, f.runId));
  if (mutation === "lease") await db.update(environmentLeases).set({ metadata: { changed: true } }).where(eq(environmentLeases.heartbeatRunId, f.runId));
  if (mutation === "event") await appendHeartbeatRunEvent(db, { ...f, eventType: "fixture.extra", stream: "system" });
  if (mutation === "new_run") await fixture();
  if (mutation === "source_restored") await fs.mkdir(f.cwd);
  epoch.next();
  await expect(service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest })).rejects.toMatchObject({ code: "historical_cohort_changed" });
  expect((await service.status({ id: hold.id, generation: hold.generation })).state).toBe("prepared");
});

it("requires precise selectors and rejects caller host proof or stale digest", async () => {
  await fixture();
  const { service } = await implementation(), capture = await service.inspect();
  await expect(service.prepare({ expectedDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "historical_cohort_changed" });
  const hold = await service.prepare({ expectedDigest: capture.digest });
  for (const selector of [{ id: randomUUID(), generation: hold.generation }, { id: hold.id, generation: randomUUID() }]) {
    await expect(service.status(selector)).rejects.toMatchObject({ code: "closure_record_unverified" });
    await expect(service.close({ ...selector, expectedDigest: capture.digest })).rejects.toMatchObject({ code: "closure_record_unverified" });
  }
  await expect(service.close({ id: hold.id, generation: hold.generation, expectedDigest: "0".repeat(64) })).rejects.toMatchObject({ code: "historical_cohort_changed" });
  await expect(service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest, host: { bootId: randomUUID() } })).rejects.toThrow();
});

it.each(["uid", "database", "realm"])("rejects changed authenticated instance: %s", async mutation => {
  await fixture();
  const { service, legacyWorkspaceEpochClosedRunIds } = await implementation(), capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest });
  if (mutation === "realm") {
    await db.update((schema as any).legacyWorkspaceEpochClosures).set({ realm: "0".repeat(64) }).where(eq((schema as any).legacyWorkspaceEpochClosures.id, hold.id));
  } else {
    const actual = hostModule.readLegacyWorkspaceHost;
    vi.spyOn(hostModule, "readLegacyWorkspaceHost").mockImplementation(async tx => {
      const host = await actual(tx);
      return mutation === "uid" ? { ...host, uid: host.uid + 1 } : { ...host, database: { ...host.database, cluster: host.database.cluster + "-other" } };
    });
  }
  await expect(service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest })).rejects.toMatchObject({ code: mutation === "realm" ? "closure_record_unverified" : "host_instance_changed" });
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(new Set());
});

it("enforces exact configured database directory and authenticates a separate DB", async () => {
  await fixture();
  const { service, legacyWorkspaceEpochClosureService } = await implementation(), capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest });
  await expect(legacyWorkspaceEpochClosureService(db, { databaseDirectory: capture.host.database.directory + "/" }).inspect()).rejects.toMatchObject({ code: "host_instance_changed" });
  const other = await startEmbeddedPostgresTestDatabase("pc-legacy-epoch-other-");
  try {
    const otherDb = createDb(other.connectionString);
    await otherDb.insert((schema as any).legacyWorkspaceEpochClosures).values(hold);
    await expect(legacyWorkspaceEpochClosureService(otherDb).status({ id: hold.id, generation: hold.generation })).rejects.toMatchObject({ code: "host_instance_changed" });
  } finally { await other.cleanup(); }
}, 20_000);

it("captures per-company immutable private paths without putting them in display activity", async () => {
  const a = await fixture(), b = await fixture();
  const { service } = await implementation(), capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest });
  expect(hold.manifest.cohort.find((entry: any) => entry.runId === a.runId).sources[0].cwd).toBe(a.cwd);
  const activity = await db.select().from(schema.activityLog);
  expect(activity.map(row => row.companyId).sort()).toEqual([a.companyId, b.companyId].sort());
  expect(JSON.stringify(activity)).not.toContain(a.cwd);
  expect(JSON.stringify(activity)).not.toContain(b.cwd);
  for (const row of activity) expect((row.details as any).runIds).toEqual([row.companyId === a.companyId ? a.runId : b.runId]);
});

it("excludes existing and symlinked sources and records renamed sources as unavailable", async () => {
  const existing = await fs.mkdtemp(path.join(root, "existing-"));
  await fixture({ cwd: existing });
  const symlink = path.join(root, randomUUID()); await fs.symlink(existing, symlink); await fixture({ cwd: symlink });
  const renamed = await fs.mkdtemp(path.join(root, "renamed-"));
  const old = await fixture({ cwd: renamed }); await fs.rename(renamed, renamed + "-retained");
  const noPath = await fixture();
  await db.update(heartbeatRuns).set({ contextSnapshot: {} }).where(eq(heartbeatRuns.id, noPath.runId));
  const { service } = await implementation(), capture = await service.inspect();
  expect(capture.cohort.map((entry: any) => entry.runId).sort()).toEqual([old.runId, noPath.runId].sort());
  expect(capture.cohort.find((entry: any) => entry.runId === noPath.runId).sources[0].sourceUnavailable).toBe("no_cwd");
  expect(capture.cohort.find((entry: any) => entry.runId === old.runId).sources[0].sourceUnavailable).toBe("missing_root");
});

it("rejects active physical owners and local process service rows without trusting status", async () => {
  const f = await fixture(), cwd = await fs.mkdtemp(path.join(root, "held-"));
  const { service } = await implementation(), capture = await service.inspect();
  const identity = await physicalWorkspaceIdentity(cwd);
  const [owner] = await db.insert(schema.workspaceWriteOwners).values({ ...{ resourceKey: identity.resourceKey, realm: identity.realm, canonicalRoot: identity.root, device: identity.device, inode: identity.inode },
    companyId: f.companyId, runId: randomUUID(), state: "unknown" }).returning();
  await expect(service.prepare({ expectedDigest: capture.digest })).rejects.toMatchObject({ code: "workspace_held" });
  await db.update(schema.workspaceWriteOwners).set({ releasedAt: new Date(), state: "released" }).where(eq(schema.workspaceWriteOwners.id, owner!.id));
  await db.insert(schema.workspaceRuntimeServices).values({ id: randomUUID(), companyId: f.companyId, provider: "local_process", status: "stopped", scopeType: "project", serviceName: "private", lifecycle: "persistent", stoppedAt: new Date() });
  await expect(service.prepare({ expectedDigest: capture.digest })).rejects.toMatchObject({ code: "workspace_service_unverified" });
});

it.each(["succeeded", "timed_out", "live_child"])("simulated boot closure permits real protected write, Stop and second dispatch: %s", async scenario => {
  const epoch = await simulatedEpoch(), cwd = await fs.mkdtemp(path.join(root, "guarded-"));
  const f = await fixture({ status: scenario === "timed_out" ? "timed_out" : "succeeded", cwd });
  let child: ReturnType<typeof spawn> | undefined;
  try {
    if (scenario === "live_child") {
      child = spawn(process.execPath, ["-e", "console.log('ready');setInterval(()=>{},1000)"], { cwd, detached: true, stdio: ["ignore", "pipe", "ignore"] });
      await once(child.stdout!, "data");
      await db.update(heartbeatRuns).set({ processPid: child.pid, processGroupId: child.pid, processStartedAt: new Date() }).where(eq(heartbeatRuns.id, f.runId));
    }
    await fs.rename(cwd, cwd + "-retained");
    const { service } = await implementation(), capture = await service.inspect();
    const history = await db.select().from(heartbeatRuns), events = await db.select().from(heartbeatRunEvents);
    const hold = await service.prepare({ expectedDigest: capture.digest }), ownership = workspaceWriteOwnershipService(db);
    const input = { id: hold.id, generation: hold.generation, expectedDigest: capture.digest };
    await expect(service.close(input)).rejects.toMatchObject({ code: "host_epoch_unchanged" });
    expect(await ownership.claim({ cwd: cwd + "-retained", companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
    if (child) { const exited = once(child, "close"); child.kill("SIGTERM"); await exited; }
    // Only switch the simulated boot after the real old child has exited.
    epoch.next();
    await service.close(input);
    expect(await db.select().from(heartbeatRuns)).toEqual(history);
    expect(await db.select().from(heartbeatRunEvents)).toEqual(events);
    await fs.mkdir(cwd);
    const first = await ownership.claim({ cwd, companyId: f.companyId, runId: randomUUID() });
    expect(first.outcome).toBe("claimed"); if (first.outcome !== "claimed") throw new Error("not admitted");
    const abort = new AbortController(); let identity: WorkspaceLaunchIdentity | undefined;
    const guard = ownership.guard(first.owner, abort.signal), bind = guard.bindPayload;
    guard.bindPayload = async value => { await bind!(value); identity = value; };
    await withWorkspaceProcessGuard(guard, () => runChildProcess("epoch-first", process.execPath,
      ["-e", "const fs=require('node:fs');fs.writeFileSync('first-effect','first');console.log('stop-ready');setTimeout(()=>fs.writeFileSync('late-effect','unsafe'),1500);setInterval(()=>{},1000)"],
      { cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async (_stream, text) => { if (text.includes("stop-ready")) abort.abort(); } }));
    expect(await fs.readFile(path.join(cwd, "first-effect"), "utf8")).toBe("first");
    expect(await workspaceNamespaceDrained(identity!)).toBe(true);
    expect(await fs.readFile(path.join(cwd, "late-effect"), "utf8").catch(() => null)).toBeNull();
    expect(await ownership.confirmStopped(first.owner, randomUUID())).toMatchObject({ proof: "namespace_drained" });
    await ownership.releaseIfStopped(first.owner);
    const second = await ownership.claim({ cwd, companyId: f.companyId, runId: randomUUID() });
    expect(second.outcome).toBe("claimed"); if (second.outcome !== "claimed") throw new Error("second not admitted");
    const result = await withWorkspaceProcessGuard(ownership.guard(second.owner), () => runChildProcess("epoch-second", process.execPath,
      ["-e", "require('node:fs').writeFileSync('second-effect','second')"], { cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {} }));
    expect(result.exitCode).toBe(0); expect(await fs.readFile(path.join(cwd, "second-effect"), "utf8")).toBe("second");
    await ownership.releaseIfStopped(second.owner);
    await fixture();
    expect(await ownership.claim({ cwd, companyId: f.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) { const exited = once(child, "close"); child.kill("SIGTERM"); await exited; }
  }
}, 20_000);

it("excludes never-spawned local leases from both capture and quiescence checks", async () => {
  const queued = await fixture({ status: "queued", emptyProcess: true });
  await db.update(heartbeatRuns).set({ processStartedAt: null }).where(eq(heartbeatRuns.id, queued.runId));
  const historical = await fixture();
  const { service } = await implementation(), capture = await service.inspect();
  expect(capture.cohort.map((entry: any) => entry.runId)).toEqual([historical.runId]);
  expect((await service.prepare({ expectedDigest: capture.digest })).state).toBe("prepared");
});

it("does not require host-reader privileges with no closed proof and isolates rejected proof SQL", async () => {
  const { legacyWorkspaceEpochClosedRunIds } = await implementation();
  const realm = (await physicalWorkspaceIdentity(root)).realm;
  const role = sql.identifier(`epoch_reader_${randomUUID().replaceAll("-", "")}`);
  await db.execute(sql`create role ${role}`);
  await db.execute(sql`grant usage on schema public to ${role}`);
  await db.execute(sql`grant select on all tables in schema public to ${role}`);
  const check = () => db.transaction(async tx => {
    await tx.execute(sql`set local role ${role}`);
    expect(await legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, realm)).toEqual(new Set());
    expect(await tx.select().from(heartbeatRuns)).toEqual([]);
  });
  await check();
  await db.insert((schema as any).legacyWorkspaceEpochClosures).values({ realm, state: "closed", digest: "0".repeat(64), manifest: {}, closure: {} });
  await check();
});

it.each(["pointer", "execution_row", "project_row"])("seals lease workspace references against drift: %s", async mutation => {
  const epoch = await simulatedEpoch(), f = await fixture();
  const [project] = await db.insert(schema.projects).values({ companyId: f.companyId, name: "Epoch workspace fixture" }).returning();
  const [source] = await db.insert(schema.projectWorkspaces).values({ companyId: f.companyId, projectId: project!.id, name: "Deleted source", cwd: f.cwd }).returning();
  const [execution] = await db.insert(schema.executionWorkspaces).values({ companyId: f.companyId, projectId: project!.id,
    projectWorkspaceId: source!.id, mode: "shared", strategyType: "local", name: "Deleted execution", cwd: f.cwd }).returning();
  await db.update(environmentLeases).set({ executionWorkspaceId: execution!.id }).where(eq(environmentLeases.heartbeatRunId, f.runId));
  const { service } = await implementation(), capture = await service.inspect(), hold = await service.prepare({ expectedDigest: capture.digest });
  if (mutation === "pointer") await db.update(environmentLeases).set({ executionWorkspaceId: null }).where(eq(environmentLeases.heartbeatRunId, f.runId));
  if (mutation === "execution_row") await db.update(schema.executionWorkspaces).set({ cwd: f.cwd + "-moved" }).where(eq(schema.executionWorkspaces.id, execution!.id));
  if (mutation === "project_row") await db.update(schema.projectWorkspaces).set({ cwd: f.cwd + "-moved" }).where(eq(schema.projectWorkspaces.id, source!.id));
  epoch.next();
  await expect(service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest })).rejects.toMatchObject({ code: "historical_cohort_changed" });
});

it("excludes a deleted source whose actual guarded namespace already drained", async () => {
  const cwd = await fs.mkdtemp(path.join(root, "drained-")), f = await fixture({ cwd, status: "running", emptyProcess: true });
  const ownership = workspaceWriteOwnershipService(db), owner = await ownership.claim({ cwd, companyId: f.companyId, runId: f.runId });
  if (owner.outcome !== "claimed") throw new Error("initial writer not admitted");
  const result = await withWorkspaceProcessGuard(ownership.guard(owner.owner, undefined, undefined, undefined, f.agentId), () => runChildProcess("tracked-epoch", process.execPath,
    ["-e", "require('node:fs').writeFileSync('effect','tracked')"], { cwd, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
      onSpawn: async meta => {
        const [run] = await db.update(heartbeatRuns).set({ controllerBootId: randomUUID(), processPid: meta.pid, processGroupId: meta.processGroupId,
          processStartedAt: new Date(meta.startedAt) }).where(eq(heartbeatRuns.id, f.runId)).returning();
        await recordLegacyProcessIdentity(db, run!);
      } }));
  expect(result.exitCode).toBe(0); await ownership.releaseIfStopped(owner.owner);
  await fs.rename(cwd, cwd + "-retained");
  const other = await fixture(), { service } = await implementation(), capture = await service.inspect();
  expect(capture.cohort.map((entry: any) => entry.runId)).toEqual([other.runId]);
  expect((await service.prepare({ expectedDigest: capture.digest })).state).toBe("prepared");
});

it("serializes repeated preparations to one immutable record and one company audit", async () => {
  await fixture();
  const { service } = await implementation(), capture = await service.inspect();
  const results = await Promise.all([service.prepare({ expectedDigest: capture.digest }), service.prepare({ expectedDigest: capture.digest })]);
  expect(results[0].id).toBe(results[1].id);
  expect(await db.select().from((schema as any).legacyWorkspaceEpochClosures)).toHaveLength(1);
  expect(await db.select().from(schema.activityLog)).toHaveLength(1);
});

it.each(["manifest", "ending", "generation"])("never discounts a corrupted closed proof: %s", async mutation => {
  const epoch = await simulatedEpoch(); await fixture();
  const { service, legacyWorkspaceEpochClosedRunIds } = await implementation(), capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest }); epoch.next();
  const closed = await service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest });
  const table = (schema as any).legacyWorkspaceEpochClosures;
  if (mutation === "manifest") await db.update(table).set({ manifest: { ...closed.manifest, inventedAuthority: true } }).where(eq(table.id, closed.id));
  if (mutation === "ending") await db.update(table).set({ closure: { ...closed.closure, host: closed.manifest.host } }).where(eq(table.id, closed.id));
  if (mutation === "generation") await db.update(table).set({ generation: randomUUID() }).where(eq(table.id, closed.id));
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(new Set());
});

it("retains closed proof when shared workspace operational metadata changes", async () => {
  const epoch = await simulatedEpoch(), f = await fixture();
  const [project] = await db.insert(schema.projects).values({ companyId: f.companyId, name: "Shared workspace fixture" }).returning();
  const [source] = await db.insert(schema.projectWorkspaces).values({ companyId: f.companyId, projectId: project!.id, name: "Shared source", cwd: f.cwd }).returning();
  const [execution] = await db.insert(schema.executionWorkspaces).values({ companyId: f.companyId, projectId: project!.id,
    projectWorkspaceId: source!.id, mode: "shared", strategyType: "local", name: "Shared execution", cwd: f.cwd }).returning();
  await db.update(environmentLeases).set({ executionWorkspaceId: execution!.id }).where(eq(environmentLeases.heartbeatRunId, f.runId));
  const { service, legacyWorkspaceEpochClosedRunIds } = await implementation(), capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest }); epoch.next();
  await service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest });
  await db.update(schema.executionWorkspaces).set({ metadata: { unrelatedNewTask: true }, updatedAt: new Date(), lastUsedAt: new Date(), name: "Renamed shared execution" }).where(eq(schema.executionWorkspaces.id, execution!.id));
  await db.update(schema.projectWorkspaces).set({ metadata: { unrelatedUiPreference: true }, updatedAt: new Date(), name: "Renamed source" }).where(eq(schema.projectWorkspaces.id, source!.id));
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(new Set([f.runId]));
});

it("blocks foreign-key lease inserts while sealing a historical run", async () => {
  const epoch = await simulatedEpoch(), f = await fixture();
  const { service, legacyWorkspaceEpochClosedRunIds } = await implementation(), capture = await service.inspect();
  const hold = await service.prepare({ expectedDigest: capture.digest }); epoch.next();
  let release!: () => void, locked!: () => void;
  const releaseGate = new Promise<void>(resolve => { release = resolve; });
  const lockedGate = new Promise<void>(resolve => { locked = resolve; });
  const leaseBlocker = db.transaction(async tx => {
    await tx.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, f.runId)).for("update");
    locked(); await releaseGate;
  });
  await lockedGate;
  let closing: Promise<any> | undefined;
  try {
    closing = service.close({ id: hold.id, generation: hold.generation, expectedDigest: capture.digest });
    // Observe real PostgreSQL lock wait after readEntry acquired the run lock;
    // no mocked query or timing-only assertion stands in for the race.
    await vi.waitFor(async () => {
      const waiting = await db.execute<{ count: string }>(sql`select count(*)::text as count from pg_stat_activity
        where datname = current_database() and wait_event_type = 'Lock' and query like '%environment_leases%'`);
      expect(Number(waiting[0]?.count)).toBeGreaterThan(0);
    }, { timeout: 5000, interval: 10 });
    const inserted = await db.transaction(async tx => {
      await tx.execute(sql`set local lock_timeout = '250ms'`);
      return tx.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "local", status: "released", releasedAt: new Date() });
    }).then(() => "inserted", error => error.cause?.code ?? error.code);
    expect(inserted).toBe("55P03");
  } finally { release(); await leaseBlocker; if (closing) await closing; }
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(new Set([f.runId]));
  await db.insert(environmentLeases).values({ companyId: f.companyId, heartbeatRunId: f.runId, provider: "local", status: "released", releasedAt: new Date() });
  expect(await db.transaction(tx => legacyWorkspaceEpochClosedRunIds(tx as unknown as Db, capture.realm))).toEqual(new Set());
});
