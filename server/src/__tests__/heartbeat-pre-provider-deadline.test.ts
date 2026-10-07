import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, costEvents, createDb, heartbeatRunEvents, heartbeatRuns, issues, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";

let db: Db, temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("pc-pre-provider-deadline-"); db = createDb(temporary.connectionString); }, 20_000);
afterAll(async () => { await temporary?.cleanup(); });
afterEach(async () => { await db.transaction(async tx => { await tx.execute(sql`set local client_min_messages = warning`); await tx.execute(sql`truncate companies cascade`); await tx.delete(workspaceWriteOwners); }); });
const oldDeadline = "2026-10-07T07:50:00.000Z";
const newStart = "2026-10-07T08:04:00.000Z";
const freshDeadline = "2026-10-07T08:34:00.000Z";

async function implementation() {
  const filename = "../services/pre-provider-admission-deadline.js";
  const module = await import(filename).catch(() => ({} as any));
  expect(module.resolvePreProviderAdmissionDeadline).toBeTypeOf("function");
  return module.resolvePreProviderAdmissionDeadline;
}

async function fixture() {
  const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
  await db.insert(companies).values({ id: companyId, name: "Deadline fixture", issuePrefix: randomUUID().slice(0, 7) });
  await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "codex_local" });
  return { companyId, agentId, issueId };
}
type Scope = Awaited<ReturnType<typeof fixture>>;
async function run(scope: Scope, kind: "wait" | "queued_cancel" | "bootstrap" | "actual" | "current", parent?: string, withDeadline = true) {
  const id = randomUUID(), current = kind === "current", queued = kind === "queued_cancel";
  await db.insert(heartbeatRuns).values({ id, companyId: scope.companyId, agentId: scope.agentId, runtimeMode: "legacy",
    status: current ? "running" : kind === "actual" ? "failed" : "cancelled", startedAt: queued ? null : new Date(current ? newStart : "2026-10-07T07:20:00.000Z"),
    finishedAt: current ? null : new Date("2026-10-07T08:03:00.000Z"), retryOfRunId: parent ?? null,
    executionStage: kind === "bootstrap" ? "preparing" : null,
    errorCode: kind === "wait" ? "workspace_busy" : kind === "bootstrap" ? "setup_failed" : kind === "actual" ? "adapter_failed" : "budget_retry_allowance_exhausted",
    resultJson: kind === "wait" ? { executionRecovery: { kind: "workspace_wait", providerWorkStarted: false }, workspaceBusy: { deferralAttempt: 1, projectWorkspaceId: null } }
      : kind === "bootstrap" ? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : null,
    contextSnapshot: { issueId: scope.issueId, ...(withDeadline ? { resourceDeadline: { runId: id, deadlineAt: oldDeadline, maxRunSeconds: 1800 } } : {}) } });
  if (kind === "wait") await appendHeartbeatRunEvent(db, { ...scope, runId: id, eventType: "lifecycle", stream: "system", payload: { retryScheduled: true, deferralAttempt: 1, projectWorkspaceId: null } });
  if (kind === "queued_cancel") await appendHeartbeatRunEvent(db, { ...scope, runId: id, eventType: "lifecycle", stream: "system", message: "Resource retry allowance exhausted before start" });
  if (kind === "bootstrap") await appendHeartbeatRunEvent(db, { ...scope, runId: id, eventType: "error", stream: "system", level: "error", message: "Setup failed before provider execution" });
  if (kind === "actual") await appendHeartbeatRunEvent(db, { ...scope, runId: id, eventType: "adapter.invoke", stream: "system", payload: { adapterType: "codex_local" } });
  return (await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id)))[0]!;
}
async function deadline(current: typeof heartbeatRuns.$inferSelect, scope: Scope, authorizedSupersession = false) {
  const resolve = await implementation();
  return new Date(await resolve(db, { run: current, issueId: scope.issueId, context: current.contextSnapshot ?? {}, maxRunSeconds: 1800, authorizedSupersession })).toISOString();
}

it("starts the first execution clock after a verified workspace wait exceeded the policy duration", async () => {
  const scope = await fixture(), wait = await run(scope, "wait"), current = await run(scope, "current", wait.id);
  expect(await deadline(current, scope)).toBe(freshDeadline);
  expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, wait.id)))[0]!.contextSnapshot!.resourceDeadline).toEqual({ runId: wait.id, deadlineAt: oldDeadline, maxRunSeconds: 1800 });
});

it("follows multiple authenticated never-started hops before granting the first execution clock", async () => {
  const scope = await fixture(), wait = await run(scope, "wait"), queued = await run(scope, "queued_cancel", wait.id), bootstrap = await run(scope, "bootstrap", queued.id), current = await run(scope, "current", bootstrap.id);
  expect(await deadline(current, scope)).toBe(freshDeadline);
});

it("preserves the old deadline when a wait descends from actual provider work", async () => {
  const scope = await fixture(), actual = await run(scope, "actual"), wait = await run(scope, "wait", actual.id), current = await run(scope, "current", wait.id);
  expect(await deadline(current, scope)).toBe(oldDeadline);
});

it("recovers the actual ancestor deadline even if an intermediate wait has no clock", async () => {
  const scope = await fixture(), actual = await run(scope, "actual"), wait = await run(scope, "wait", actual.id, false), current = await run(scope, "current", wait.id, false);
  expect(await deadline(current, scope)).toBe(oldDeadline);
});

it("retains an earlier actual execution clock through an unverified execution hop without a clock", async () => {
  const scope = await fixture(), actual = await run(scope, "actual"), unknown = await run(scope, "actual", actual.id, false), wait = await run(scope, "wait", unknown.id, false), current = await run(scope, "current", wait.id, false);
  expect(await deadline(current, scope)).toBe(oldDeadline);
});

it("does not replace a same-run clock after that run already invoked a provider", async () => {
  const scope = await fixture(), wait = await run(scope, "wait"), current = await run(scope, "current", wait.id);
  await appendHeartbeatRunEvent(db, { ...scope, runId: current.id, eventType: "adapter.invoke", stream: "system" });
  expect(await deadline(current, scope)).toBe(oldDeadline);
});

it.each(["marker_only", "invoked", "process", "usage", "cost", "foreign_issue", "cycle", "missing_ancestor"])("retains strict deadline for unverified history: %s", async reason => {
  const scope = await fixture(), wait = await run(scope, "wait"), current = await run(scope, "current", wait.id);
  if (reason === "marker_only") await db.execute(sql`delete from heartbeat_run_events where run_id=${wait.id}`);
  if (reason === "invoked") await appendHeartbeatRunEvent(db, { ...scope, runId: wait.id, eventType: "adapter.invoke", stream: "system" });
  if (reason === "process") await db.update(heartbeatRuns).set({ processPid: 12345 }).where(eq(heartbeatRuns.id, wait.id));
  if (reason === "usage") await db.update(heartbeatRuns).set({ usageJson: { inputTokens: 1 } }).where(eq(heartbeatRuns.id, wait.id));
  if (reason === "cost") await db.insert(costEvents).values({ companyId: scope.companyId, agentId: scope.agentId, heartbeatRunId: wait.id, provider: "fixture", model: "fixture", costCents: 1, occurredAt: new Date() });
  if (reason === "foreign_issue") await db.update(heartbeatRuns).set({ contextSnapshot: { ...wait.contextSnapshot, issueId: randomUUID() } }).where(eq(heartbeatRuns.id, wait.id));
  if (reason === "cycle") await db.update(heartbeatRuns).set({ retryOfRunId: current.id }).where(eq(heartbeatRuns.id, wait.id));
  if (reason === "missing_ancestor") await db.update(heartbeatRuns).set({ contextSnapshot: { ...wait.contextSnapshot, retryOfRunId: randomUUID() } }).where(eq(heartbeatRuns.id, wait.id));
  expect(await deadline(current, scope)).toBe(oldDeadline);
});

it.each(["missing", "foreign_issue", "cycle", "depth", "actual_without_clock"])("rejects unresolved clockless retry ancestry: %s", async reason => {
  const scope = await fixture();
  let source = await run(scope, reason === "actual_without_clock" ? "actual" : "wait", undefined, false);
  if (reason === "missing") await db.update(heartbeatRuns).set({ contextSnapshot: { ...source.contextSnapshot, retryOfRunId: randomUUID() } }).where(eq(heartbeatRuns.id, source.id));
  if (reason === "foreign_issue") await db.update(heartbeatRuns).set({ contextSnapshot: { ...source.contextSnapshot, issueId: randomUUID() } }).where(eq(heartbeatRuns.id, source.id));
  if (reason === "depth") for (let i = 0; i < 65; i++) source = await run(scope, "queued_cancel", source.id, false);
  const current = await run(scope, "current", source.id, false);
  if (reason === "cycle") await db.update(heartbeatRuns).set({ retryOfRunId: current.id }).where(eq(heartbeatRuns.id, source.id));
  await expect(deadline(current, scope)).rejects.toMatchObject({ code: "resource_run_deadline_unverified" });
});

it("grants the existing policy clock to an initial run without any retry ancestry", async () => {
  const scope = await fixture(), current = await run(scope, "current", undefined, false);
  expect(await deadline(current, scope)).toBe(freshDeadline);
});

it.each(["verified_wait_chain", "actual_provider_source"])("enforces deadline evidence through the real heartbeat dispatcher: %s", async scenario => {
  const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pc-provider-deadline-"));
  const adapterType = `deadline_fixture_${randomUUID()}`, scope = await fixture();
  const source = await run(scope, scenario === "actual_provider_source" ? "actual" : "wait");
  const parent = scenario === "verified_wait_chain" ? await run(scope, "queued_cancel", source.id) : source;
  await db.update(companies).set({ defaultResponsibleUserId: "fixture-operator", requireBoardApprovalForNewAgents: false }).where(eq(companies.id, scope.companyId));
  await db.update(agents).set({ status: "active", adapterType, adapterConfig: { cwd }, runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, scope.agentId));
  await db.insert(issues).values({ id: scope.issueId, companyId: scope.companyId, title: "Deadline dispatch fixture", status: "in_progress",
    assigneeAgentId: scope.agentId, responsibleUserId: "fixture-operator", assigneeAdapterOverrides: { useProjectWorkspace: false },
    executionPolicy: { resourceLimits: { maxRunSeconds: 1800, maxAutomaticRuns: 10 } } });
  // A local fixture replaces only the paid/external provider boundary. All
  // admission, evidence reads, deadline timers and run persistence are real.
  registerServerAdapter({ type: adapterType,
    execute: async context => {
      await context.onMeta?.({ adapterType, command: "deadline-fixture", cwd, commandArgs: [] });
      return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: "Deadline dispatch completed" } };
    },
    testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
  const { heartbeatService } = await import("../services/heartbeat.js");
  const heartbeat = heartbeatService(db);
  try {
    const current = await heartbeat.invoke(scope.agentId, "on_demand", { issueId: scope.issueId, retryOfRunId: parent.id }, "manual");
    expect(current).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();
    const finished = await heartbeat.getRun(current!.id);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, current!.id));
    if (scenario === "verified_wait_chain") {
      expect(finished?.status).toBe("succeeded");
      expect(events.filter(event => event.eventType === "adapter.invoke")).toHaveLength(1);
      expect(Date.parse((finished!.contextSnapshot!.resourceDeadline as any).deadlineAt)).toBeGreaterThan(Date.now());
      expect((finished!.contextSnapshot!.resourceDeadline as any).maxRunSeconds).toBe(1800);
    } else {
      expect(finished?.errorCode).toBe("resource_run_deadline");
      expect(events.filter(event => event.eventType === "adapter.invoke")).toHaveLength(0);
      expect(((await heartbeat.getRun(source.id))!.contextSnapshot!.resourceDeadline as any).deadlineAt).toBe(oldDeadline);
    }
  } finally { await heartbeat.drainActiveRunExecutions(); unregisterServerAdapter(adapterType); await fs.rm(cwd, { recursive: true, force: true }); }
}, 20_000);
