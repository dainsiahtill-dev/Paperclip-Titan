import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, workspaceRuntimeServices, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { eq, sql } from "drizzle-orm";
import { workspaceWriteOwnershipService } from "../services/workspace-write-ownership.js";
import { runWorkspaceJobForControl } from "../services/workspace-runtime.js";
import { withWorkspaceProcessGuard, runChildProcess } from "@paperclipai/adapter-utils/server-utils";
import type { WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db;
let root: string;
beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("pc-physical-owner-"); db = createDb(temporary.connectionString); root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-owner-")); }, 20_000);
afterAll(async () => { await temporary?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });

it("admits only one physical owner across company, project, and symlink aliases", async () => {
  const modulePath = "../services/workspace-write-ownership.js";
  const implementation = await import(modulePath).catch(() => ({}));
  expect(implementation.workspaceWriteOwnershipService).toBeTypeOf("function");
  const service = implementation.workspaceWriteOwnershipService(db);
  const actual = path.join(root, "actual"); await fs.mkdir(actual);
  const alias = path.join(root, "alias"); await fs.symlink(actual, alias);
  const results = await Promise.all([actual, alias].map(cwd => service.claim({ cwd, companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID() })));
  expect(results.map(r => r.outcome).sort()).toEqual(["busy", "claimed"]);
  expect(results.find(r => r.outcome === "busy")).toEqual({ outcome: "busy" });
});

async function claimFixture() {
  const cwd = await fs.mkdtemp(path.join(root, "case-"));
  const service = workspaceWriteOwnershipService(db);
  const claim = await service.claim({ cwd, companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID() });
  if (claim.outcome !== "claimed") throw new Error("fixture not claimed");
  return { cwd, service, owner: claim.owner };
}

it("same-file successor stays busy until actual delayed writer drains even after controller expiry", async () => {
  const { cwd, service, owner } = await claimFixture();
  // Controller lifetime is deliberately absent from physical ownership: changing
  // logical timestamps cannot revoke this pending write.
  await db.update(workspaceWriteOwners).set({ updatedAt: new Date(0) }).where(eq(workspaceWriteOwners.id, owner.id));
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = withWorkspaceProcessGuard(service.guard(owner), () => runChildProcess("delayed", "/bin/sh", ["-c", "printf ready; sleep 0.2; printf first > shared"], {
    cwd, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => ready(),
  }));
  await started;
  expect(await service.claim({ cwd, companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
  expect((await pending).exitCode).toBe(0);
  expect(await fs.readFile(path.join(cwd, "shared"), "utf8")).toBe("first");
  expect(await service.claim({ cwd, companyId: owner.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  await service.releaseIfStopped(owner);
  const next = await service.claim({ cwd, companyId: owner.companyId, runId: randomUUID() });
  expect(next.outcome).toBe("claimed");
});

it("rejects an old launch receipt and ownership generation", async () => {
  const { cwd, service, owner } = await claimFixture();
  let identity!: WorkspaceLaunchIdentity;
  const guard = service.guard(owner); const bind = guard.bindLaunch;
  guard.bindLaunch = async value => { identity = value; await bind(value); };
  await withWorkspaceProcessGuard(guard, () => runChildProcess("old", "/bin/true", [], { cwd, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {} }));
  await expect(service.recordDrain(owner, { ...identity, observerNamespace: "pid:[foreign]" })).rejects.toThrow("namespace_drain_unverified");
  await service.beforeLaunch(owner);
  await expect(service.recordDrain(owner, identity)).rejects.toThrow("transition_rejected");
  await expect(service.releaseIfStopped({ ...owner, generation: randomUUID() })).rejects.toThrow("generation_mismatch");
  expect(await service.claim({ cwd, companyId: owner.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("durable identity transaction failure prevents provider effects and retains an unknown hold", async () => {
  const { cwd, service, owner } = await claimFixture();
  await db.execute(sql`create function reject_test_workspace_bind() returns trigger language plpgsql as $$ begin if NEW.state = 'active' then raise exception 'injected identity commit failure'; end if; return NEW; end $$`);
  await db.execute(sql`create trigger reject_test_workspace_bind before update on workspace_write_owners for each row execute function reject_test_workspace_bind()`);
  try {
    await expect(withWorkspaceProcessGuard(service.guard(owner), () => runChildProcess("failure", "/bin/sh", ["-c", "printf unsafe > sentinel"], {
      cwd, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {},
    }))).rejects.toThrow();
    const row = (await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, owner.id)))[0]!;
    expect(row.state).toBe("unknown"); expect(row.history.some(event => event.event === "launch_bound")).toBe(false);
    expect(await fs.readdir(cwd)).toEqual([]);
    await expect(service.releaseIfStopped(owner)).rejects.toThrow();
    expect(await service.claim({ cwd, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
  } finally {
    await db.execute(sql`drop trigger reject_test_workspace_bind on workspace_write_owners`);
    await db.execute(sql`drop function reject_test_workspace_bind()`);
  }
});

it("unprotected native lifetime observations exclude protected writers and survive controller replacement", async () => {
  const cwd = await fs.mkdtemp(path.join(root, "native-")); const service = workspaceWriteOwnershipService(db);
  const request = { cwd, companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), observeUnprotected: true };
  const first = await service.claim(request); expect(first.outcome).toBe("claimed");
  const resumed = await workspaceWriteOwnershipService(db).claim({ ...request, runId: randomUUID() });
  expect(resumed).toEqual(first);
  expect(await service.claim({ ...request, observeUnprotected: false })).toEqual({ outcome: "busy" });
});

it("protected physical ownership excludes unsupported aliases symmetrically", async () => {
  const { cwd, service } = await claimFixture(); const alias = `${cwd}-alias`; await fs.symlink(cwd, alias);
  expect(await service.claim({ cwd: alias, companyId: randomUUID(), issueId: randomUUID(), runId: randomUUID(), observeUnprotected: true })).toEqual({ outcome: "busy" });
});

it("reserved private runtime roots cannot become another writer's source workspace", async () => {
  const { service, owner } = await claimFixture(); const privateRoot = await fs.mkdtemp(path.join(root, "private-home-"));
  await service.reservePrivateRoots(owner, [privateRoot]);
  const alias = `${privateRoot}-alias`; await fs.symlink(privateRoot, alias);
  expect(await service.claim({ cwd: alias, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
  const second = await claimFixture();
  await expect(service.reservePrivateRoots(owner, [second.cwd])).rejects.toThrow("private_root_source_overlap");
});

it("reuses one durable private-home reservation for sequential contained launches and requires the latest drain", async () => {
  const { cwd, service, owner } = await claimFixture();
  const home = await fs.mkdtemp(path.join(root, "sequential-home-"));
  const effects = path.join(home, "effects");
  const guard = service.guard(owner, undefined, [home]);
  const launches: WorkspaceLaunchIdentity[] = [], drains: WorkspaceLaunchIdentity[] = [];
  const bind = guard.bindLaunch, drain = guard.recordDrain;
  guard.bindLaunch = async identity => {
    expect(await fs.readFile(effects, "utf8").catch(() => "")).toBe(launches.length === 0 ? "" : "first");
    await bind(identity); launches.push(identity);
  };
  const bindPayload = guard.bindPayload!;
  guard.bindPayload = async identity => {
    expect(await fs.readFile(effects, "utf8").catch(() => "")).toBe(launches.length === 1 ? "" : "first");
    expect(identity).toMatchObject(launches[launches.length - 1]!);
    expect(identity.payloadPid).toBeGreaterThan(0);
    await bindPayload(identity);
    launches[launches.length - 1] = identity;
  };
  guard.recordDrain = async identity => { await drain(identity); drains.push(identity); };
  const options = { cwd, env: { PRIVATE_HOME: home }, timeoutSec: 2, graceSec: 1, onLog: async () => {} };
  const first = await withWorkspaceProcessGuard(guard, () => runChildProcess("private-first", "/bin/sh", ["-c", 'printf first >> "$PRIVATE_HOME/effects"'], options));
  expect(first.exitCode, first.stderr).toBe(0); expect(drains).toHaveLength(1);
  expect(await service.claim({ cwd, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
  expect(await service.claim({ cwd: home, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
  await expect(service.reservePrivateRoots(owner, [cwd])).rejects.toThrow("private_root_source_overlap");
  const other = await claimFixture();
  await expect(service.reservePrivateRoots(other.owner, [home])).rejects.toThrow("private_root_source_overlap");

  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const second = withWorkspaceProcessGuard(guard, () => runChildProcess("private-second", "/bin/sh", ["-c", 'printf ready; sleep 0.4; printf second >> "$PRIVATE_HOME/effects"'], {
    ...options, onLog: async (_stream, text) => { if (text.includes("ready")) ready(); },
  }));
  try {
    await Promise.race([started, second.then(() => { throw new Error("Second launch exited without readiness"); })]);
    expect(launches).toHaveLength(2); expect(launches[1]!.launchId).not.toBe(launches[0]!.launchId);
    await expect(service.recordDrain(owner, drains[0]!)).rejects.toThrow("transition_rejected");
    await expect(service.releaseIfStopped(owner)).rejects.toThrow("transition_rejected");
    expect(await service.claim({ cwd: home, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
    expect((await second).exitCode).toBe(0);
    expect(drains).toEqual(launches);
    expect(await fs.readFile(effects, "utf8")).toBe("firstsecond");
    const current = (await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, owner.id)))[0]!;
    expect(current.history.filter(event => event.event === "private_roots_reserved")).toHaveLength(1);
    expect(current.stopReceipt?.launchId).toBe(launches[1]!.launchId);
    await service.releaseIfStopped(owner);
    expect((await service.claim({ cwd: home, companyId: randomUUID(), runId: randomUUID() })).outcome).toBe("claimed");
  } finally { await second.catch(() => undefined); }
});

it("pre-PC06 board services block protected aliases while delayed descendants can still write", async () => {
  const cwd = await fs.mkdtemp(path.join(root, "old-service-")), alias = `${cwd}-alias`;
  await fs.symlink(cwd, alias);
  const companyId = randomUUID(), serviceId = randomUUID(), service = workspaceWriteOwnershipService(db);
  await db.insert(companies).values({ id: companyId, name: "Old service", issuePrefix: randomUUID().slice(0, 7) });
  const child = spawn("/bin/sh", ["-c", "sleep 0.2; printf old-service > sentinel"], { cwd, stdio: "ignore" });
  const drained = once(child, "close");
  await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId, serviceName: "old-board-service", scopeType: "execution_workspace", lifecycle: "shared", status: "stopped", cwd, provider: "local_process", providerRef: String(child.pid), stoppedAt: new Date(0), startedByRunId: null });
  try {
    expect(await service.claim({ cwd: alias, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
    await drained;
    expect(await fs.readFile(path.join(cwd, "sentinel"), "utf8")).toBe("old-service");
    expect(await service.claim({ cwd, companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
    expect((await claimFixture()).owner.state).toBe("reserved");
  } finally { await drained; await db.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, serviceId)); }
});

it("server death retains the owner until a restarted controller verifies the same namespace drain", async () => {
  const { cwd, service, owner } = await claimFixture();
  const launchId = await service.beforeLaunch(owner);
  const fixture = fileURLToPath(new URL("../../../packages/adapter-utils/src/test-fixtures/workspace-guard-controller.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), fixture, cwd, launchId], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  let identity!: WorkspaceLaunchIdentity; let stderr = "";
  child.stderr!.on("data", data => { stderr += String(data); });
  try {
    await new Promise<void>((resolve, reject) => {
      child.on("message", (message: any) => {
        if (message.type === "identity") { identity = message.identity; void service.bindLaunch(owner, identity).then(() => child.send("committed"), reject); }
        if (message.type === "ready") resolve();
      });
      child.once("exit", () => reject(new Error(`Controller exited before ready: ${stderr}`)));
    });
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    const restarted = workspaceWriteOwnershipService(db);
    expect(await restarted.claim({ cwd, companyId: owner.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
    await new Promise(resolve => setTimeout(resolve, 550));
    expect(await fs.readFile(path.join(cwd, "late"), "utf8").catch(() => null)).toBeNull();
    await expect(restarted.recordDrain({ ...owner, generation: randomUUID() }, identity)).rejects.toThrow("generation_mismatch");
    await restarted.recordDrain(owner, identity); await restarted.releaseIfStopped(owner);
    expect((await restarted.claim({ cwd, companyId: owner.companyId, runId: randomUUID() })).outcome).toBe("claimed");
  } finally { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped; } }
});

it("server death before identity ACK does not open the argv writer gate", async () => {
  const { cwd, service, owner } = await claimFixture(); const launchId = await service.beforeLaunch(owner);
  const fixture = fileURLToPath(new URL("../../../packages/adapter-utils/src/test-fixtures/workspace-guard-controller.ts", import.meta.url));
  const child = spawn(process.execPath, ["--import", createRequire(import.meta.url).resolve("tsx"), fixture, cwd, launchId, "printf unsafe > immediate"], { stdio: ["ignore", "pipe", "pipe", "ipc"] });
  try {
    await once(child, "message");
    const exited = once(child, "exit"); child.kill("SIGKILL"); await exited;
    await new Promise(resolve => setTimeout(resolve, 150));
    expect(await fs.readFile(path.join(cwd, "immediate"), "utf8").catch(() => null)).toBeNull();
    expect(await service.claim({ cwd, companyId: owner.companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  } finally { if (child.exitCode === null && child.signalCode === null) { const stopped = once(child, "exit"); child.kill("SIGKILL"); await stopped; } }
});

it("HTTP workspace jobs cannot bypass a held owner and use their own contained lifetime after release", async () => {
  const { cwd, service, owner } = await claimFixture();
  const input = { db, actor: { id: null, name: "Board", companyId: owner.companyId }, issue: null,
    workspace: { cwd, baseCwd: cwd, source: "project_primary", projectId: null, workspaceId: null, repoUrl: null, repoRef: null,
      strategy: "project_primary", branchName: null, worktreePath: null, warnings: [] } as Parameters<typeof runWorkspaceJobForControl>[0]["workspace"],
    command: { kind: "job", name: "Private fixture", command: "printf verified > job-effect" },
  };
  await expect(runWorkspaceJobForControl(input)).rejects.toMatchObject({ status: 409 });
  expect(await fs.readdir(cwd)).toEqual([]);
  await service.releaseIfStopped(owner);
  await runWorkspaceJobForControl(input);
  expect(await fs.readFile(path.join(cwd, "job-effect"), "utf8")).toBe("verified");
  const owners = await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.canonicalRoot, cwd));
  expect(owners).toHaveLength(2); expect(owners.every(row => row.state === "released")).toBe(true);
  expect(owners.some(row => row.stopReceipt?.namespace)).toBe(true);
});

it("deleting run, issue, and company rows cannot cascade away an active physical owner", async () => {
  const { cwd, service, owner } = await claimFixture(); const agentId = randomUUID();
  await db.insert(companies).values({ id: owner.companyId, name: "Private deletion fixture", issuePrefix: randomUUID().slice(0, 7), defaultResponsibleUserId: "board" });
  await db.insert(agents).values({ id: agentId, companyId: owner.companyId, name: "Fixture", role: "engineer", adapterType: "hermes_local", status: "idle" });
  await db.insert(issues).values({ id: owner.issueId!, companyId: owner.companyId, title: "Fixture", responsibleUserId: "board" });
  await db.insert(heartbeatRuns).values({ id: owner.runId, companyId: owner.companyId, agentId, invocationSource: "assignment", status: "timed_out", controllerLeaseExpiresAt: new Date(0) });
  let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const running = withWorkspaceProcessGuard(service.guard(owner), () => runChildProcess("delete-owner", "/bin/sh", ["-c", "printf ready; sleep 0.2; printf retained > effect"], {
    cwd, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => ready(),
  }));
  await started;
  await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId));
  await db.delete(issues).where(eq(issues.id, owner.issueId!));
  await db.delete(agents).where(eq(agents.id, agentId));
  await db.delete(companies).where(eq(companies.id, owner.companyId));
  expect(await service.claim({ cwd, companyId: randomUUID(), runId: randomUUID() })).toEqual({ outcome: "busy" });
  expect((await running).exitCode).toBe(0);
  expect(await fs.readFile(path.join(cwd, "effect"), "utf8")).toBe("retained");
  const durable = (await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, owner.id)))[0]!;
  expect(durable).toMatchObject({ companyId: owner.companyId, runId: owner.runId, issueId: owner.issueId, releasedAt: null });
});

it("retains an unverified historical service-root hold without inferring stop from logical status", async () => {
  const cwd = await fs.mkdtemp(path.join(root, "unknown-old-service-")); const companyId = randomUUID(), serviceId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Unknown service root", issuePrefix: randomUUID().slice(0, 7) });
  await db.insert(workspaceRuntimeServices).values({ id: serviceId, companyId, serviceName: "old", scopeType: "run", lifecycle: "shared", status: "stopped", cwd: null, provider: "local_process", providerRef: null, stoppedAt: new Date(0) });
  const service = workspaceWriteOwnershipService(db);
  expect(await service.claim({ cwd, companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
  await db.delete(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.id, serviceId));
  expect(await service.claim({ cwd, companyId, runId: randomUUID() })).toEqual({ outcome: "busy" });
});
