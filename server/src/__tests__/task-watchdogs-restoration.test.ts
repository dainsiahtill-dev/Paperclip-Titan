import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, approvals, companies, createDb, heartbeatRuns, issueApprovals, issueComments, issueRelations, issues, issueWatchdogs, issueTreeHolds } from "@paperclipai/db";
import { issueWatchdogAttempts, issueWatchdogRecoveryBatches, issueWatchdogRecoveryOutbox } from "@paperclipai/db/schema/issue_watchdogs";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { taskWatchdogService } from "../services/task-watchdogs.js";
import { issueService } from "../services/issues.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;
describeDb("durable watchdog restoration and atomic recovery API", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-watchdog-restoration-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(async () => {
    await db.delete(issueWatchdogRecoveryOutbox); await db.delete(issueWatchdogRecoveryBatches); await db.delete(issueWatchdogAttempts);
    await db.delete(activityLog); await db.delete(issueComments); await db.delete(issueTreeHolds);
    await db.delete(issueApprovals); await db.delete(approvals); await db.delete(issueRelations);
    await db.delete(issueWatchdogs); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(agents); await db.delete(companies);
  });
  async function seed(leafOverrides: Partial<typeof issues.$inferInsert> = {}, beforeWatchdog?: (input: { companyId: string; agentId: string; rootId: string; leafId: string }) => Promise<void>, maxAttempts: 2 | 3 = 3) {
    const companyId = randomUUID(), agentId = randomUUID(), rootId = randomUUID(), leafId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Isolated recovery", issuePrefix: `W${companyId.slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Watchdog", role: "engineer", status: "active", adapterType: "process", adapterConfig: {} });
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Source", status: "in_progress", assigneeAgentId: agentId, createdAt: new Date(Date.now() - 60_000) },
      { id: leafId, companyId, title: "Stranded leaf", status: "todo", parentId: rootId, assigneeAgentId: agentId, createdAt: new Date(Date.now() - 60_000), ...leafOverrides },
    ]);
    await beforeWatchdog?.({ companyId, agentId, rootId, leafId });
    const svc = taskWatchdogService(db);
    await svc.upsertForIssue(companyId, rootId, { agentId, maxAttempts });
    await svc.reconcileTaskWatchdogs({ companyId });
    const watchdog = (await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.issueId, rootId)))[0]!;
    const runId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, invocationSource: "automation", status: "running", contextSnapshot: {
      issueId: watchdog.watchdogIssueId, taskWatchdog: { watchedIssueId: rootId, stopFingerprint: watchdog.lastObservedFingerprint },
    } });
    const actor = { type: "agent", companyId, agentId, runId };
    const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).actor = actor; next(); });
    app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null })); app.use(errorHandler);
    const batch = (mutations: any[]) => ({ requestId: randomUUID(), watchdogRunId: runId, expectedStopFingerprint: watchdog.lastObservedFingerprint, mutations });
    return { companyId, agentId, rootId, leafId, watchdog, runId, actor, app, batch };
  }
  async function forceVerification(watchdogId: string) {
    await db.update(issueWatchdogs).set({ verificationDueAt: new Date(0) }).where(eq(issueWatchdogs.id, watchdogId));
  }

  it.each([2, 3] as const)("claims restoration and retains a %i-attempt bound across service recreation", async (maxAttempts) => {
    const s = await seed({}, undefined, maxAttempts);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.watchdog.watchdogIssueId!));
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId });
    let row = (await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, s.watchdog.id)))[0]!;
    expect(row.lastReviewedFingerprint).toBeNull();
    expect(row.restorationDisposition).toBe("restoration_claimed");
    expect(row.restorationAttemptCount).toBe(1);
    for (let attempt = 2; attempt <= maxAttempts; attempt++) {
      await forceVerification(row.id);
      expect((await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId })).triggered).toBe(1);
      row = (await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, row.id)))[0]!;
      expect(row.restorationAttemptCount).toBe(attempt);
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, row.watchdogIssueId!));
      await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId });
    }
    await forceVerification(row.id);
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId });
    await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId });
    row = (await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, row.id)))[0]!;
    expect(row.restorationDisposition).toBe("escalated");
    const escalation = await db.select().from(activityLog).where(eq(activityLog.action, "issue.task_watchdog_escalated"));
    expect(escalation).toHaveLength(1);
    expect(escalation[0]!.details).toMatchObject({ owner: "board", attemptCount: maxAttempts });
    expect(await db.select().from(issueWatchdogAttempts)).toHaveLength(maxAttempts);
  });

  it("commits status and explanation once and returns identical receipt on network retry", async () => {
    const s = await seed(); const body = s.batch([
      { kind: "set_status", issueId: s.leafId, status: "in_progress" },
      { kind: "comment", issueId: s.rootId, body: "Restoring leaf execution; same atomic decision." },
    ]);
    const first = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(body);
    expect(first.status).toBe(200); expect(first.body.status).toBe("applied"); expect(first.body.actionIds).toHaveLength(2);
    const retry = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(body);
    expect(retry.status).toBe(200); expect(retry.body).toEqual(first.body);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.rootId))).toHaveLength(1);
    expect(await db.select().from(issueWatchdogRecoveryBatches)).toHaveLength(1);
    expect(await db.select().from(issueWatchdogRecoveryOutbox).where(eq(issueWatchdogRecoveryOutbox.kind, "assignment"))).toHaveLength(1);
    const other = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send({ ...body, requestId: randomUUID() });
    expect(other.status).toBe(409);
  });

  it("records a concurrent live subtree as stale without applying any batch mutations", async () => {
    const s = await seed();
    await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.agentId, invocationSource: "on_demand", status: "running", contextSnapshot: { issueId: s.leafId } });
    const response = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([
      { kind: "set_status", issueId: s.leafId, status: "in_progress" }, { kind: "comment", issueId: s.rootId, body: "Must never commit" },
    ]));
    expect(response.status).toBe(409); expect(response.body.status).toBe("stale");
    expect((await db.select().from(issues).where(eq(issues.id, s.leafId)))[0]!.status).toBe("todo");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.rootId))).toHaveLength(0);
    expect(await db.select().from(issueWatchdogRecoveryBatches)).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.watchdog.watchdogIssueId!))).toEqual(expect.arrayContaining([expect.objectContaining({ body: expect.stringContaining("stale") })]));
  });

  it("rolls back earlier effects when a later normal status guard rejects the batch", async () => {
    const s = await seed({ assigneeAgentId: null });
    const response = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([
      { kind: "comment", issueId: s.rootId, body: "Rollback me" }, { kind: "set_status", issueId: s.leafId, status: "in_progress" },
    ]));
    expect(response.status).toBe(422);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.rootId))).toHaveLength(0);
    expect(await db.select().from(issueWatchdogRecoveryBatches)).toHaveLength(0);
    expect(await db.select().from(activityLog).where(and(eq(activityLog.runId, s.runId), eq(activityLog.entityId, s.rootId)))).toHaveLength(0);
  });

  it("rejects fourth operation and outside-subtree target without effects", async () => {
    const s = await seed(); const url = `/api/issues/${s.rootId}/watchdog/recovery-batches`;
    expect((await request(s.app).post(url).send(s.batch(Array.from({ length: 4 }, () => ({ kind: "comment", issueId: s.rootId, body: "Too many" }))))).status).toBe(400);
    const outsideId = randomUUID(); await db.insert(issues).values({ id: outsideId, companyId: s.companyId, title: "Outside", status: "todo" });
    expect((await request(s.app).post(url).send(s.batch([{ kind: "comment", issueId: outsideId, body: "Out of scope" }]))).status).toBe(403);
    expect(await db.select().from(issueWatchdogRecoveryBatches)).toHaveLength(0);
  });

  it("keeps intermediate-only recovery changes in the same failed restoration lineage", async () => {
    const s = await seed();
    const response = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([
      { kind: "set_status", issueId: s.rootId, status: "todo" },
      { kind: "comment", issueId: s.rootId, body: "Claimed parent recovery, leaf still idle" },
    ]));
    expect(response.status).toBe(200);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.watchdog.watchdogIssueId!));
    await forceVerification(s.watchdog.id);
    expect((await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId })).triggered).toBe(1);
    const [row] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, s.watchdog.id));
    expect(row!.restorationAttemptCount).toBe(2);
    expect(row!.restorationSourceFingerprint).toBe(s.watchdog.lastObservedFingerprint);
    expect(row!.lastReviewedFingerprint).toBeNull();
  });

  it("observes genuine live restoration without spending another attempt", async () => {
    const s = await seed();
    await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([{ kind: "comment", issueId: s.rootId, body: "Restoration claimed; verify actual execution" }])).expect(200);
    await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.agentId, invocationSource: "on_demand", status: "running", contextSnapshot: { issueId: s.leafId } });
    const check = await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId });
    expect(check.triggered).toBe(0); expect(check.live).toBe(1);
    const [attempt] = await db.select().from(issueWatchdogAttempts);
    expect(attempt!.verificationOutcome).toBe("live"); expect(attempt!.verifiedAt).not.toBeNull();
  });

  it("honors explicit pause and suppresses a verified legitimate-stop disposition", async () => {
    const s = await seed();
    await db.insert(issueTreeHolds).values({ companyId: s.companyId, rootIssueId: s.rootId, mode: "pause", status: "active", createdByActorType: "user", createdByUserId: "pause-owner" });
    await request(s.app).post(`/api/issues/${s.rootId}/watchdog/disposition`).send({ requestId: randomUUID(), watchdogRunId: s.runId, expectedStopFingerprint: s.watchdog.lastObservedFingerprint, disposition: "legitimate_stop", evidence: "Board intentionally paused this subtree." }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.watchdog.watchdogIssueId!));
    expect((await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId })).triggered).toBe(0);
    expect((await db.select().from(issueTreeHolds))[0]!.status).toBe("active");
  });

  it.each(["human_owner", "pending_approval", "bounded_monitor", "human_blocker"])("respects %s as a verified waiting path", async (kind) => {
    const s = await seed();
    if (kind === "human_owner") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "human-owner", status: "blocked" }).where(eq(issues.id, s.leafId));
    if (kind === "pending_approval") {
      const [approval] = await db.insert(approvals).values({ companyId: s.companyId, type: "hire_agent", status: "pending", payload: {}, requestedByAgentId: s.agentId }).returning();
      await db.insert(issueApprovals).values({ companyId: s.companyId, issueId: s.leafId, approvalId: approval!.id });
    }
    if (kind === "bounded_monitor") {
      await db.update(issues).set({ monitorNextCheckAt: new Date(Date.now() + 60_000), executionPolicy: { stages: [], monitor: { nextCheckAt: new Date(Date.now() + 60_000).toISOString(), maxAttempts: 2, scheduledBy: "assignee" } } }).where(eq(issues.id, s.leafId));
    }
    if (kind === "human_blocker") {
      const blockerId = randomUUID(); await db.insert(issues).values({ id: blockerId, companyId: s.companyId, title: "Human prerequisite", status: "blocked", assigneeUserId: "human-owner" });
      await db.insert(issueRelations).values({ companyId: s.companyId, issueId: blockerId, relatedIssueId: s.leafId, type: "blocks" });
      await db.update(issues).set({ status: "blocked" }).where(eq(issues.id, s.leafId));
    }
    await request(s.app).post(`/api/issues/${s.rootId}/watchdog/disposition`).send({ requestId: randomUUID(), watchdogRunId: s.runId, expectedStopFingerprint: s.watchdog.lastObservedFingerprint, disposition: "legitimate_stop", evidence: `Durable ${kind} owns the next action.` }).expect(200);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.watchdog.watchdogIssueId!));
    expect((await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId })).triggered).toBe(0);
    if (kind === "pending_approval") expect((await db.select().from(approvals))[0]!.status).toBe("pending");
  });

  it("rejects unsupported cancellation, budget and secret requests before any effects", async () => {
    const s = await seed(); const url = `/api/issues/${s.rootId}/watchdog/recovery-batches`;
    for (const mutation of [{ kind: "set_status", issueId: s.leafId, status: "cancelled" }, { kind: "cancel_run", runId: s.runId }, { kind: "set_budget", amount: 100 }, { kind: "set_secret", value: "synthetic" }]) {
      expect((await request(s.app).post(url).send(s.batch([mutation]))).status).toBe(400);
    }
    expect(await db.select().from(issueWatchdogRecoveryBatches)).toHaveLength(0);
  });

  it("serializes repeated scanners without duplicate attempts or review comments", async () => {
    const s = await seed();
    await Promise.all(Array.from({ length: 3 }, () => taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId })));
    expect(await db.select().from(issueWatchdogAttempts)).toHaveLength(1);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.watchdog.watchdogIssueId!))).toHaveLength(1);
  });

  it("fails closed without deadlock when a normal issue mutation owns the source row", async () => {
    const s = await seed();
    let release!: () => void; let locked!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ready = new Promise<void>((resolve) => { locked = resolve; });
    const ordinary = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, s.rootId)).for("update");
      locked(); await held;
      await issueService(db).update(s.rootId, { status: "todo" }, tx, [], []);
    });
    await ready;
    try {
      const response = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([{ kind: "comment", issueId: s.rootId, body: "No race effects" }]));
      expect(response.status).toBe(409);
    } finally { release(); await ordinary; }
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.rootId))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, s.rootId)))[0]!.status).toBe("todo");
  });

  it("does not deliver obsolete watchdog wake outboxes after the lineage escalated", async () => {
    const s = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issueWatchdogs).set({ restorationDisposition: "escalated", restorationSourceFingerprint: s.watchdog.lastObservedFingerprint, restorationClaimedFingerprint: s.watchdog.lastObservedFingerprint }).where(eq(issueWatchdogs.id, s.watchdog.id));
    const calls: string[] = [];
    await taskWatchdogService(db, { enqueueWakeup: async (_agent, options) => { calls.push(options?.idempotencyKey ?? "unknown"); return { id: randomUUID() }; } }).reconcileTaskWatchdogs({ companyId: s.companyId });
    expect(calls).toHaveLength(0);
  });

  it("starts a new bounded lineage when a human explicitly re-enables an exhausted watchdog", async () => {
    const s = await seed();
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, s.watchdog.watchdogIssueId!));
    await db.update(issueWatchdogs).set({ restorationDisposition: "escalated", restorationAttemptCount: 3 }).where(eq(issueWatchdogs.id, s.watchdog.id));
    const svc = taskWatchdogService(db);
    await svc.disableForIssue(s.companyId, s.rootId, { userId: "human-owner" });
    await svc.upsertForIssue(s.companyId, s.rootId, { agentId: s.agentId, actor: { userId: "human-owner" } });
    expect((await svc.reconcileTaskWatchdogs({ companyId: s.companyId })).triggered).toBe(1);
    const [row] = await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, s.watchdog.id));
    expect(row!.restorationAttemptCount).toBe(1);
    expect(row!.lastObservedFingerprint).not.toBe(s.watchdog.lastObservedFingerprint);
  });

  it("cannot activate a todo issue while a linked formal approval remains pending", async () => {
    const s = await seed({}, async ({ companyId, agentId, leafId }) => {
      const [approval] = await db.insert(approvals).values({ companyId, type: "hire_agent", status: "pending", payload: {}, requestedByAgentId: agentId }).returning();
      await db.insert(issueApprovals).values({ companyId, issueId: leafId, approvalId: approval!.id });
    });
    const response = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([
      { kind: "comment", issueId: s.rootId, body: "Rollback this attempted approval bypass" },
      { kind: "set_status", issueId: s.leafId, status: "in_progress" },
    ]));
    expect(response.status).toBe(403);
    expect((await db.select().from(issues).where(eq(issues.id, s.leafId)))[0]!.status).toBe("todo");
    expect((await db.select().from(approvals))[0]!.status).toBe("pending");
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.rootId))).toHaveLength(0);
  });

  it("never escalates a claimed third attempt while its watchdog run is still live", async () => {
    const s = await seed();
    await db.update(issueWatchdogs).set({ restorationAttemptCount: 3 }).where(eq(issueWatchdogs.id, s.watchdog.id));
    await db.insert(issueWatchdogAttempts).values({ companyId: s.companyId, watchdogId: s.watchdog.id, sourceFingerprint: s.watchdog.lastObservedFingerprint!, observedFingerprint: s.watchdog.lastObservedFingerprint!, attemptNumber: 3, watchdogRunId: s.runId });
    await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([{ kind: "comment", issueId: s.rootId, body: "Third attempt still owns a live review run" }])).expect(200);
    await forceVerification(s.watchdog.id);
    const check = await taskWatchdogService(db).reconcileTaskWatchdogs({ companyId: s.companyId });
    expect(check.live).toBe(1);
    expect((await db.select().from(issueWatchdogs).where(eq(issueWatchdogs.id, s.watchdog.id)))[0]!.restorationDisposition).toBe("restoration_claimed");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId)))[0]!.status).toBe("running");
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "issue.task_watchdog_escalated"))).toHaveLength(0);
  });

  it("keeps forbidden cancellation out of the legacy source PATCH path", async () => {
    const s = await seed();
    const response = await request(s.app).patch(`/api/issues/${s.leafId}`).send({ status: "cancelled" });
    expect(response.status).toBe(403);
    expect((await db.select().from(issues).where(eq(issues.id, s.leafId)))[0]!.status).toBe("todo");
  });

  it.each(["legacy", "native"])("denies restoration while a terminal %s run retains physical provider capacity", async (runtimeMode) => {
    const s = await seed(); const retainedRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: retainedRunId, companyId: s.companyId, agentId: s.agentId, invocationSource: "on_demand", status: "cancelled", runtimeMode,
      capacityGroup: "", capacityReleasedAt: null, contextSnapshot: { issueId: s.leafId } });
    await db.update(issues).set({ executionRunId: retainedRunId, checkoutRunId: retainedRunId }).where(eq(issues.id, s.leafId));
    const response = await request(s.app).post(`/api/issues/${s.rootId}/watchdog/recovery-batches`).send(s.batch([
      { kind: "set_status", issueId: s.leafId, status: "in_progress" }, { kind: "comment", issueId: s.rootId, body: "Must not create duplicate physical work" },
    ]));
    expect(response.status).toBe(409); expect(response.body.status).toBe("stale");
    const [leaf] = await db.select().from(issues).where(eq(issues.id, s.leafId));
    expect(leaf).toMatchObject({ status: "todo", executionRunId: retainedRunId, checkoutRunId: retainedRunId });
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, retainedRunId)))[0]!.capacityReleasedAt).toBeNull();
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.rootId))).toHaveLength(0);
  });
});
