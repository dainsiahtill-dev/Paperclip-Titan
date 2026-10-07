import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issueComments, issueRecoveryActions, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { recoveryService } from "../services/recovery/service.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("review recovery budget eligibility", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("review-budget-"); db = createDb(database.connectionString); }, 20000);
  afterAll(async () => { await database?.cleanup(); });

  async function seed(reviewKind: "missing" | "human" | "agent", operatorCancelled = reviewKind !== "agent") {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), workRunId = randomUUID(), cancelledRunId = randomUUID(), stageId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Review fixture", issuePrefix: "R" + companyId.slice(0, 7), defaultResponsibleUserId: "local-board", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Original implementer", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {} });
    const executionPolicy = { mode: "normal" as const, commentRequired: true, resourceLimits: { maxAutomaticRuns: 1 },
      stages: reviewKind === "missing" ? [] : [{ id: stageId, type: "review" as const, approvalsNeeded: 1,
        participants: [reviewKind === "agent" ? { id: randomUUID(), type: "agent" as const, agentId } : { id: randomUUID(), type: "user" as const, userId: "local-board" }] }] };
    await db.insert(issues).values({ id: issueId, companyId, title: "Completed implementation awaiting review", status: "in_review", assigneeAgentId: agentId,
      executionPolicy, executionState: reviewKind === "missing" ? null : {
        status: "pending", currentStageId: stageId, currentStageIndex: 0, currentStageType: "review",
        currentParticipant: reviewKind === "agent" ? { type: "agent", agentId, userId: null } : { type: "user", userId: "local-board", agentId: null },
        returnAssignee: { type: "agent", agentId, userId: null }, reviewRequest: null, completedStageIds: [], lastDecisionId: null, lastDecisionOutcome: null,
      } });
    await db.insert(heartbeatRuns).values([
      { id: workRunId, companyId, agentId, status: "succeeded", invocationSource: "assignment", triggerDetail: "system",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: "issue_assigned" }, createdAt: new Date("2026-10-01T00:00:00Z"), startedAt: new Date("2026-10-01T00:00:00Z"), finishedAt: new Date("2026-10-01T00:01:00Z") },
      { id: cancelledRunId, companyId, agentId, status: operatorCancelled ? "cancelled" : "failed", invocationSource: "automation", triggerDetail: "system",
        errorCode: operatorCancelled ? "cancelled" : "adapter_failed", error: operatorCancelled ? "Cancelled by a board operator" : "Review provider failed",
        contextSnapshot: { issueId, taskId: issueId, wakeReason: operatorCancelled ? "issue_commented" : "execution_review_requested" },
        createdAt: new Date("2026-10-01T00:02:00Z"), startedAt: operatorCancelled ? null : new Date("2026-10-01T00:01:45Z"), finishedAt: new Date("2026-10-01T00:02:00Z"),
        resultJson: operatorCancelled ? { cancelledByActorType: "user", cancelledByUserId: "local-board", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } : { conversationContinuation: "continue_conversation_v1" } },
    ]);
    return { companyId, issueId, agentId, executionPolicy, cancelledRunId };
  }

  it.each(["missing", "human"] as const)("does not turn %s review waiting into a quota failure or replay the executor", async kind => {
    const s = await seed(kind);
    const delivery = vi.fn(async () => { throw new Error("Unexpected provider dispatch"); });
    const recovery = recoveryService(db, { enqueueWakeup: delivery });
    await recovery.reconcileStrandedAssignedIssues();
    await recovery.reconcileStrandedAssignedIssues();
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue.status).toBe("in_review");
    expect(issue.executionPolicy).toEqual(s.executionPolicy);
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).toHaveLength(0);
    expect(await db.select().from(issueComments).where(eq(issueComments.issueId, s.issueId))).toHaveLength(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).toHaveLength(2);
    expect(delivery).not.toHaveBeenCalled();
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.cancelledRunId)))[0]).toMatchObject({ status: "cancelled", startedAt: null });
  });

  it("still blocks a real agent review participant when its automatic budget is exhausted", async () => {
    const s = await seed("agent");
    const delivery = vi.fn(async () => { throw new Error("Unexpected provider dispatch"); });
    const result = await recoveryService(db, { enqueueWakeup: delivery }).reconcileStrandedAssignedIssues();
    const [current] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(current.status, JSON.stringify({ result, executionState: current.executionState, policy: current.executionPolicy })).toBe("blocked");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).toHaveLength(1);
    expect(delivery).not.toHaveBeenCalled();
  });
  it("preserves an explicit operator cancellation of a real reviewer without automatic replay", async () => {
    const s = await seed("agent", true);
    const delivery = vi.fn(async () => { throw new Error("Unexpected provider dispatch"); });
    await recoveryService(db, { enqueueWakeup: delivery }).reconcileStrandedAssignedIssues();
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0].status).toBe("in_review");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, s.issueId))).toHaveLength(0);
    expect(delivery).not.toHaveBeenCalled();
  });
});
