import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { once } from "node:events";
import { createRequire } from "node:module";
import { afterAll, beforeAll, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, workspaceWriteOwners, type Db } from "@paperclipai/db";
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
