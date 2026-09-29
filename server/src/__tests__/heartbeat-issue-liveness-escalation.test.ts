import { randomUUID } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog,
  agents,
  approvals,
  agentWakeupRequests,
  agentRuntimeState,
  budgetPolicies,
  companies,
  companyMemberships,
  companySkills,
  costEvents,
  createDb,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueComments,
  issueApprovals,
  issueRelations,
  issueRecoveryActions,
  issueTreeHoldMembers,
  issueTreeHolds,
  issues,
  projects,
  projectWorkspaces,
  workspaceOperations,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";

const mockAdapterExecute = vi.hoisted(() =>
  vi.fn(async () => ({
    exitCode: 0,
    signal: null,
    timedOut: false,
    errorMessage: null,
    summary: "Acknowledged liveness escalation.",
    provider: "test",
    model: "test-model",
  })),
);

vi.mock("../telemetry.ts", () => ({
  getTelemetryClient: () => ({ track: vi.fn() }),
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentFirstHeartbeat: vi.fn(),
  };
});

vi.mock("../adapters/index.ts", async () => {
  const actual = await vi.importActual<typeof import("../adapters/index.ts")>("../adapters/index.ts");
  return {
    ...actual,
    getServerAdapter: vi.fn(() => ({
      supportsLocalAgentJwt: false,
      execute: mockAdapterExecute,
    })),
  };
});

import { heartbeatService } from "../services/heartbeat.ts";
import { attentionService } from "../services/attention.ts";
import { issueService } from "../services/issues.ts";
import { runningProcesses } from "../adapters/index.ts";
import {
  buildIssueBlockersResolvedWakeStateKey,
  buildIssueBlockersResolvedWakeStateKeyWithoutCycle,
  buildIssueChildrenReadyWakeStateKey,
} from "../services/issue-dependency-wakeups.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres issue liveness escalation tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat resolved dependency wake reconciliation", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-issue-liveness-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterEach(async () => {
    // Dependency reconciliation heals missing wakes by enqueuing an
    // on-demand wake, which dispatches a heartbeat run fire-and-forget (see
    // startNextQueuedRunForAgent → executeRun in the heartbeat service). That
    // background run keeps writing rows (workspace_operations, heartbeat_run_events)
    // after the awaited call resolves. Deterministically await those in-flight
    // executions before clearing tables — otherwise an escaping heartbeat_run_events
    // insert can land between the events delete and the heartbeat_runs delete and
    // trip the run_events → runs foreign key.
    await heartbeatService(db).drainActiveRunExecutions();
    vi.clearAllMocks();
    runningProcesses.clear();
    await db.delete(activityLog);
    await db.delete(heartbeatRunEvents);
    await db.delete(costEvents);
    await db.delete(workspaceOperations);
    await db.delete(issueComments);
    await db.delete(issueTreeHoldMembers);
    await db.delete(issueTreeHolds);
    await db.delete(issueRelations);
    await db.delete(issueRecoveryActions);
    await db.delete(issueApprovals);
    await db.delete(approvals);
    await db.delete(issues);
    await db.delete(executionWorkspaces);
    await db.delete(projectWorkspaces);
    await db.delete(projects);
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companyMemberships);
    await db.delete(companySkills);
    await db.delete(companies);
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  async function seedBlockedChain(opts: {
    outsideLookback?: boolean;
    blockerStatus?: string;
    blockerAssigneeAgentId?: "coder" | "manager" | null;
  } = {}) {
    const companyId = randomUUID();
    const managerId = randomUUID();
    const coderId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values([
      {
        id: managerId,
        companyId,
        name: "CTO",
        role: "cto",
        status: "idle",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
      {
        id: coderId,
        companyId,
        name: "Coder",
        role: "engineer",
        status: "idle",
        reportsTo: managerId,
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: false } },
        permissions: {},
      },
    ]);

    const issueTimestamp = opts.outsideLookback === true
      ? new Date(Date.now() - 25 * 60 * 60 * 1000)
      : new Date(Date.now() - 60 * 60 * 1000);
    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        title: "Blocked parent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: coderId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
      {
        id: blockerIssueId,
        companyId,
        title: "Missing unblock owner",
        status: opts.blockerStatus ?? "todo",
        priority: "medium",
        assigneeAgentId: opts.blockerAssigneeAgentId === "coder"
          ? coderId
          : opts.blockerAssigneeAgentId === "manager"
            ? managerId
            : null,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
        createdAt: issueTimestamp,
        updatedAt: issueTimestamp,
      },
    ]);

    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    return { companyId, managerId, coderId, blockedIssueId, blockerIssueId };
  }

  async function seedResolvedDependencyBackstopFixture(opts: {
    workspaceState?: "none" | "not_finalized" | "finalized";
    assignee?: "agent" | null;
  } = {}) {
    const workspaceState = opts.workspaceState ?? "none";
    const companyId = randomUUID();
    const agentId = randomUUID();
    const ownerUserId = randomUUID();
    const blockedIssueId = randomUUID();
    const blockerIssueId = randomUUID();
    const projectId = randomUUID();
    const projectWorkspaceId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(companyMemberships).values({
      companyId,
      principalType: "user",
      principalId: ownerUserId,
      membershipRole: "owner",
      status: "active",
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Priya",
      role: "engineer",
      status: "idle",
      adapterType: "test_adapter",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });

    if (workspaceState !== "none") {
      await db.insert(projects).values({
        id: projectId,
        companyId,
        name: "Synthetic dependency project",
        status: "in_progress",
      });
      await db.insert(projectWorkspaces).values({
        id: projectWorkspaceId,
        companyId,
        projectId,
        name: "Synthetic workspace",
        sourceType: "git_worktree",
      });
      await db.insert(executionWorkspaces).values({
        id: executionWorkspaceId,
        companyId,
        projectId,
        projectWorkspaceId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "Synthetic execution workspace",
        providerType: "git_worktree",
      });
    }

    await db.insert(issues).values([
      {
        id: blockedIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic blocked dependent",
        status: "blocked",
        priority: "medium",
        assigneeAgentId: opts.assignee === null ? null : agentId,
        issueNumber: 1,
        identifier: `${issuePrefix}-1`,
      },
      {
        id: blockerIssueId,
        companyId,
        projectId: workspaceState === "none" ? null : projectId,
        title: "Synthetic completed blocker",
        status: "done",
        priority: "medium",
        executionWorkspaceId: workspaceState === "none" ? null : executionWorkspaceId,
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      },
    ]);
    await db.insert(issueRelations).values({
      companyId,
      issueId: blockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    if (workspaceState === "not_finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "adapter_execute",
        status: "succeeded",
        startedAt: new Date(Date.now() - 60_000),
      });
    } else if (workspaceState === "finalized") {
      await db.insert(workspaceOperations).values({
        companyId,
        executionWorkspaceId,
        issueId: blockerIssueId,
        phase: "workspace_finalize",
        status: "succeeded",
        startedAt: new Date(),
      });
    }

    return { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId };
  }

  it("runs exactly one bounded review-path recovery before surfacing a stalled decision", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const issuePrefix = `R${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    await db.insert(companies).values({
      id: companyId,
      name: "Review Recovery Co",
      issuePrefix,
      defaultResponsibleUserId: "responsible-user",
      requireBoardApprovalForNewAgents: false,
    });
    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Review Agent",
      role: "engineer",
      status: "idle",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
      permissions: {},
    });
    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "PAP-14994 fingerprint",
      status: "in_review",
      priority: "medium",
      assigneeAgentId: agentId,
      responsibleUserId: "responsible-user",
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    const heartbeat = heartbeatService(db);
    const followUpRun = await heartbeat.wakeup(agentId, {
      source: "automation",
      triggerDetail: "system",
      reason: "issue_commented",
      payload: {
        issueId,
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
      requestedByActorType: "user",
      requestedByActorId: "responsible-user",
      contextSnapshot: {
        issueId,
        taskId: issueId,
        wakeReason: "issue_commented",
        interactionId: "superseded-confirmation",
        reviewPathLost: true,
        reviewPathConsumedRef: "superseded-confirmation",
      },
    });
    expect(followUpRun).not.toBeNull();
    await heartbeat.drainActiveRunExecutions();

    const recoveryWakes = await db
      .select()
      .from(agentWakeupRequests)
      .where(and(
        eq(agentWakeupRequests.companyId, companyId),
        eq(agentWakeupRequests.reason, "issue_review_path_lost"),
      ));
    expect(recoveryWakes).toHaveLength(1);
    expect(recoveryWakes[0]).toMatchObject({
      status: "completed",
      payload: expect.objectContaining({
        issueId,
        reviewPathConsumedRef: "superseded-confirmation",
        reviewPathRecoveryAttempt: 1,
        maxReviewPathRecoveryAttempts: 1,
      }),
    });

    const attention = await issueService(db)
      .listReviewAttention(companyId, [{ id: issueId, companyId, status: "in_review" }]);
    expect(attention.get(issueId)).toMatchObject({ state: "stalled", paths: [] });

    const feed = await attentionService(db).list(companyId, { userId: "responsible-user" });
    expect(feed.items.find((item) => item.subject.id === issueId)).toMatchObject({
      sourceKind: "review",
      decisionVerbs: expect.arrayContaining([
        expect.objectContaining({ id: "choose_review_path", label: "Choose review path" }),
      ]),
    });
  });

  it("keeps resolved dependency wake reconciliation active", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      entityId: blockedIssueId,
      details: expect.objectContaining({ source: "issue_graph_liveness.backstop" }),
    });
  });

  it("does not reconcile a dependency wake while a board-owned unblock wait remains", async () => {
    const { companyId, blockedIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db.update(issues).set({
      unblockDescriptor: { owner: "board", action: "Await external resource" },
    }).where(eq(issues.id, blockedIssueId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toEqual([]);
  });

  it("does not reconcile a dependency wake while linked approval is pending", async () => {
    const { companyId, blockedIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const approvalId = randomUUID();
    await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: {} });
    await db.insert(issueApprovals).values({ companyId, issueId: blockedIssueId, approvalId });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    const wakes = await db.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toEqual([]);
  });

  it("skips a queued dependency wake if an independent wait appears before claim", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", payload: { issueId: blockedIssueId },
      status: "queued", runId,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId], blockedTransitionAt: null,
      }),
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: "issue_blockers_resolved" },
    });
    await db.update(issues).set({
      unblockDescriptor: { owner: "board", action: "Await external resource" },
    }).where(eq(issues.id, blockedIssueId));
    mockAdapterExecute.mockClear();

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toEqual({ status: "cancelled", errorCode: "issue_dependency_wake_stale" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("rechecks a dependency wake under the claim lock after a new wait arrives", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", payload: { issueId: blockedIssueId }, status: "queued", runId,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId], blockedTransitionAt: null,
      }),
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: "issue_blockers_resolved" },
    });
    mockAdapterExecute.mockClear();
    const heartbeat = heartbeatService(db, {
      beforeChatControlRecoveryCheck: async ({ stage }) => {
        if (stage === "claim") await db.update(issues).set({
          unblockDescriptor: { owner: "board", action: "New external wait" },
        }).where(eq(issues.id, blockedIssueId));
      },
    });

    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toEqual({ status: "cancelled", errorCode: "issue_dependency_wake_stale" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it("rejects a queued dependency wake from an earlier blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", payload: { issueId: blockedIssueId }, status: "queued", runId,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId], blockedTransitionAt: null,
      }),
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: "issue_blockers_resolved" },
    });
    await db.update(issues).set({ blockedTransitionAt: new Date("2026-09-29T12:00:00.000Z") })
      .where(eq(issues.id, blockedIssueId));
    mockAdapterExecute.mockClear();

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [run] = await db.select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(run).toEqual({ status: "cancelled", errorCode: "issue_dependency_wake_stale" });
    expect(mockAdapterExecute).not.toHaveBeenCalled();
  });

  it.each([
    ["issue_children_completed", "issue_blockers_resolved"],
    ["issue_blockers_resolved", "issue_children_completed"],
  ] as const)("keeps queued %s identity when %s arrives for the same issue", async (firstReason, incomingReason) => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockerKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId], blockedTransitionAt: null,
    });
    const childKey = `issue_children_completed:${blockedIssueId}:${blockerIssueId}`;
    const firstKey = firstReason === "issue_blockers_resolved" ? blockerKey : childKey;
    const incomingKey = incomingReason === "issue_blockers_resolved" ? blockerKey : childKey;
    const occupiedRunId = randomUUID();
    const originalRunId = randomUUID();
    const originalWakeId = randomUUID();
    await db.insert(heartbeatRuns).values({
      id: occupiedRunId, companyId, agentId, invocationSource: "automation", status: "running",
      contextSnapshot: { taskKey: "other-work" },
    });
    await db.insert(agentWakeupRequests).values({
      id: originalWakeId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: firstReason, payload: { issueId: blockedIssueId }, status: "queued",
      runId: originalRunId, idempotencyKey: firstKey,
    });
    await db.insert(heartbeatRuns).values({
      id: originalRunId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId: originalWakeId,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: firstReason },
    });

    const newRun = await heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: incomingReason,
      idempotencyKey: incomingKey, payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: incomingReason },
    });

    expect(newRun?.id).not.toBe(originalRunId);
    const [original] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, originalRunId));
    expect(original?.contextSnapshot).toMatchObject({ wakeReason: firstReason });
    const [newWake] = await db.select({ idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests).where(eq(agentWakeupRequests.runId, newRun!.id));
    expect(newWake?.idempotencyKey).toBe(incomingKey);

    if (incomingReason === "issue_blockers_resolved") {
      mockAdapterExecute.mockImplementationOnce(async () => {
        await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
        return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
          summary: "Completed the current dependency-ready work.", provider: "test", model: "test-model" };
      });
      await db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, occupiedRunId));
      const heartbeat = heartbeatService(db);
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
      const [oldRun] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, originalRunId));
      const [validRun] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, newRun!.id));
      expect(oldRun?.status).toBe("cancelled");
      expect(validRun?.status).toBe("succeeded");
      expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
    }
  });

  it("coalesces a queued dependency wake only when its reason and cycle key match", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const wakeupRequestId = randomUUID();
    const runId = randomUUID();
    const key = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId], blockedTransitionAt: null,
    });
    await db.insert(heartbeatRuns).values({
      companyId, agentId, invocationSource: "automation", status: "running",
      contextSnapshot: { taskKey: "other-work" },
    });
    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId, companyId, agentId, source: "automation", triggerDetail: "system",
      reason: "issue_blockers_resolved", payload: { issueId: blockedIssueId },
      status: "queued", runId, idempotencyKey: key,
    });
    await db.insert(heartbeatRuns).values({
      id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
      status: "queued", wakeupRequestId,
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: "issue_blockers_resolved" },
    });

    const run = await heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_blockers_resolved",
      idempotencyKey: key, payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
      contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: "issue_blockers_resolved" },
    });

    expect(run?.id).toBe(runId);
    const [original] = await db.select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    expect(original?.contextSnapshot).toMatchObject({ wakeReason: "issue_blockers_resolved" });
  });

  it("executes only one of two queued wakes for the same terminal child state", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, blockedIssueId));
    await db.update(issues).set({ parentId: blockedIssueId }).where(eq(issues.id, blockerIssueId));
    const [child] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, blockerIssueId));
    const key = buildIssueChildrenReadyWakeStateKey({
      parentIssueId: blockedIssueId, blockerIssueIds: [], blockedTransitionAt: null,
      children: [{ id: blockerIssueId, status: "done", updatedAt: child!.updatedAt }],
    });
    const runIds = [randomUUID(), randomUUID()];
    for (let index = 0; index < runIds.length; index += 1) {
      const wakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId, source: "automation", triggerDetail: "system",
        reason: "issue_children_completed", payload: { issueId: blockedIssueId, completedChildIssueId: blockerIssueId },
        status: "queued", runId: runIds[index], idempotencyKey: key,
      });
      await db.insert(heartbeatRuns).values({
        id: runIds[index], companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        status: "queued", wakeupRequestId: wakeId,
        contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: "issue_children_completed" },
        createdAt: new Date(Date.now() + index),
      });
    }
    mockAdapterExecute.mockClear();
    mockAdapterExecute.mockImplementation(async () => {
      await db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorAgentId: agentId, authorType: "agent",
        createdByRunId: runIds[0], body: "Reviewed the terminal child state.",
      });
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Reviewed the terminal child state.", provider: "test", model: "test-model" };
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const rows = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, companyId), inArray(heartbeatRuns.id, runIds)));
    expect(rows.filter((row) => row.status === "succeeded")).toHaveLength(1);
    expect(rows.filter((row) => row.status === "cancelled")).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("supersedes a queued child-ready wake when its child becomes a formal blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db.delete(issueRelations).where(eq(issueRelations.relatedIssueId, blockedIssueId));
    await db.update(issues).set({ parentId: blockedIssueId }).where(eq(issues.id, blockerIssueId));
    const [child] = await db.select({ updatedAt: issues.updatedAt }).from(issues).where(eq(issues.id, blockerIssueId));
    const childKey = buildIssueChildrenReadyWakeStateKey({
      parentIssueId: blockedIssueId, blockerIssueIds: [], blockedTransitionAt: null,
      children: [{ id: blockerIssueId, status: "done", updatedAt: child!.updatedAt }],
    });
    const dependencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId, blockerIssueIds: [blockerIssueId], blockedTransitionAt: null,
    });
    const childRunId = randomUUID();
    const dependencyRunId = randomUUID();
    for (const [runId, reason, key] of [
      [childRunId, "issue_children_completed", childKey],
      [dependencyRunId, "issue_blockers_resolved", dependencyKey],
    ] as const) {
      const wakeId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeId, companyId, agentId, source: "automation", triggerDetail: "system",
        reason, payload: { issueId: blockedIssueId, resolvedBlockerIssueId: blockerIssueId },
        status: "queued", runId, idempotencyKey: key,
      });
      await db.insert(heartbeatRuns).values({
        id: runId, companyId, agentId, invocationSource: "automation", triggerDetail: "system",
        status: "queued", wakeupRequestId: wakeId,
        contextSnapshot: { issueId: blockedIssueId, taskId: blockedIssueId, wakeReason: reason },
      });
      if (reason === "issue_children_completed") {
        await db.insert(issueRelations).values({
          companyId, issueId: blockerIssueId, relatedIssueId: blockedIssueId, type: "blocks",
        });
      }
    }
    mockAdapterExecute.mockClear();
    mockAdapterExecute.mockImplementation(async () => {
      await db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorAgentId: agentId, authorType: "agent",
        createdByRunId: dependencyRunId, body: "Handled the current blocker-ready state.",
      });
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Handled the current blocker-ready state.", provider: "test", model: "test-model" };
    });

    const heartbeat = heartbeatService(db);
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const [childRun] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, childRunId));
    const [dependencyRun] = await db.select({ status: heartbeatRuns.status }).from(heartbeatRuns).where(eq(heartbeatRuns.id, dependencyRunId));
    expect(childRun?.status).toBe("cancelled");
    expect(dependencyRun?.status).toBe("succeeded");
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("heals a blocked dependent whose done blocker has no workspace finalize obligation", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);

    expect(wake?.reason).toBe("issue_blockers_resolved");
    expect(wake?.idempotencyKey).toBe(
      buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    );
    expect(["queued", "claimed", "completed"]).toContain(wake?.status);

    const events = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted")));
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ entityId: blockedIssueId });
  });

  it("reconciles a resolved blocked dependency after the assignee-null window closes", async () => {
    const { agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none", assignee: null });
    const heartbeat = heartbeatService(db);

    const beforeAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeAssignment.healed).toBe(0);
    expect(beforeAssignment.checked).toBe(0);

    await db
      .update(issues)
      .set({ assigneeAgentId: agentId, updatedAt: new Date() })
      .where(eq(issues.id, blockedIssueId));

    const afterAssignment = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterAssignment.healed).toBe(1);
    expect(afterAssignment.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  async function seedExecutionWait(status: "active" | "resolved" = "resolved") {
    const fixture = await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const [action] = await db.insert(issueRecoveryActions).values({
      companyId: fixture.companyId, sourceIssueId: fixture.blockedIssueId,
      kind: "active_run_watchdog", ownerType: "board", returnOwnerAgentId: fixture.agentId,
      cause: "legacy_execution_requires_reconciliation", status,
      evidence: status === "resolved" ? { automaticRecovery: { replay: "blocked" } } : {},
      fingerprint: randomUUID(), nextAction: "Check the stopped execution before resuming.",
    }).returning();
    return { ...fixture, action: action! };
  }

  it.each(["active", "resolved"] as const)("keeps repeated wakes behind a %s execution hold run-free, then resumes once", async (status) => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait(status);
    const heartbeat = heartbeatService(db);
    // Different producers and wake keys must not create new attempts or notices.
    await Promise.all(Array.from({ length: 6 }, (_, i) => heartbeat.wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      idempotencyKey: `producer-${i}`, payload: { issueId: blockedIssueId },
      contextSnapshot: { issueId: blockedIssueId },
    })));
    for (let i = 0; i < 3; i++) {
      // Recreate the service to prove the wait is durable across scheduler restarts.
      expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(0);
    }
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(1);
    expect(waits[0]).toMatchObject({
      status: "skipped", runId: null, reason: "execution_reconciliation_required", coalescedCount: 8,
      payload: { issueId: blockedIssueId, executionWait: { recoveryActionId: action.id } },
    });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    expect(mockAdapterExecute).not.toHaveBeenCalled();
    expect(await db.select().from(activityLog).where(and(
      eq(activityLog.companyId, companyId), eq(activityLog.action, "issue.blockers_resolved_wake_emitted"),
    ))).toHaveLength(0);

    mockAdapterExecute.mockImplementationOnce(async () => {
      await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockedIssueId));
      return { exitCode: 0, signal: null, timedOut: false, errorMessage: null,
        summary: "Finished the dependency-ready task.", provider: "test", model: "test-model" };
    });
    await db.update(issueRecoveryActions).set({ status: "resolved", evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(1);
    expect((await heartbeat.reconcileResolvedDependencyWakes()).healed).toBe(0);
    await heartbeat.drainActiveRunExecutions();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(mockAdapterExecute).toHaveBeenCalledTimes(1);
  });

  it("rechecks every gate after an execution hold clears", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, action } = await seedExecutionWait();
    const wake = () => heartbeatService(db).wakeup(agentId, {
      source: "automation", triggerDetail: "system", reason: "issue_continuation_needed",
      requestedByActorType: "system", requestedByActorId: "wait-regression",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    await wake();
    await db.update(issues).set({ status: "todo" }).where(eq(issues.id, blockerIssueId));
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    await wake();
    await wake();
    const waits = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(waits).toHaveLength(2);
    expect(waits.find((row) => row.reason === "issue_dependencies_blocked")?.coalescedCount).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issues).set({ status: "done" }).where(eq(issues.id, blockerIssueId));
    expect((await heartbeatService(db).reconcileResolvedDependencyWakes()).healed).toBe(1);
  });

  it("preserves distinct comments through a hold and adopts them on the next eligible wake", async () => {
    const { companyId, agentId, blockedIssueId, action } = await seedExecutionWait();
    const heartbeat = heartbeatService(db);
    const commentIds: string[] = [];
    for (let i = 0; i < 2; i++) {
      const [comment] = await db.insert(issueComments).values({
        companyId, issueId: blockedIssueId, authorUserId: "board-user", body: `Follow-up ${i}`,
      }).returning();
      commentIds.push(comment!.id);
      expect(await heartbeat.wakeup(agentId, {
        source: "on_demand", triggerDetail: "manual", reason: "issue_commented",
        requestedByActorType: "user", requestedByActorId: "board-user",
        payload: { issueId: blockedIssueId, commentId: comment!.id },
        contextSnapshot: { issueId: blockedIssueId, wakeReason: "issue_commented", wakeCommentId: comment!.id },
      })).toBeNull();
    }
    const deferred = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(deferred).toHaveLength(2);
    expect(deferred.every((row) => row.status === "deferred_issue_execution" && row.runId === null)).toBe(true);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(0);
    await db.update(issueRecoveryActions).set({ evidence: {} }).where(eq(issueRecoveryActions.id, action.id));
    const resumed = await heartbeat.wakeup(agentId, {
      source: "on_demand", triggerDetail: "manual", reason: "issue_resumed",
      requestedByActorType: "user", requestedByActorId: "board-user",
      payload: { issueId: blockedIssueId }, contextSnapshot: { issueId: blockedIssueId },
    });
    expect(resumed?.contextSnapshot?.wakeCommentIds).toEqual(commentIds);
    const receipts = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId));
    expect(receipts.filter((row) => row.status === "coalesced")).toHaveLength(2);
  });

  it("retries a resolved dependency wake when the prior wake was skipped as stale", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    // The route-time wake writes the level-triggered state key. A skip records a
    // `skipped` row with that key. `skipped` is not an in-flight status, so the
    // backstop must still re-emit for the same ready state.
    const idempotencyKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
    });
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "skipped",
      finishedAt: new Date(),
      error: "Cancelled because issue assignee changed before the queued run could start",
      idempotencyKey,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.existingWakeSkipped).toBe(0);

    const wakes = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")))
      .orderBy(agentWakeupRequests.requestedAt);

    expect(wakes).toHaveLength(2);
    expect(wakes.map((wake) => wake.status)).toContain("skipped");
    expect(wakes.every((wake) => wake.idempotencyKey === idempotencyKey)).toBe(true);
    expect(wakes.some((wake) => ["queued", "claimed", "completed"].includes(wake.status))).toBe(true);
  });

  it("waits for workspace finalize before healing a resolved blocked dependent", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId, executionWorkspaceId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "not_finalized" });
    const heartbeat = heartbeatService(db);

    const beforeFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(beforeFinalize.healed).toBe(0);
    expect(beforeFinalize.notReadySkipped).toBe(1);

    const wakesBeforeFinalize = await db
      .select()
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId));
    expect(wakesBeforeFinalize).toHaveLength(0);

    await db.insert(workspaceOperations).values({
      companyId,
      executionWorkspaceId,
      issueId: blockerIssueId,
      phase: "workspace_finalize",
      status: "succeeded",
      startedAt: new Date(),
    });

    const afterFinalize = await heartbeat.reconcileResolvedDependencyWakes();

    expect(afterFinalize.healed).toBe(1);
    expect(afterFinalize.issueIds).toEqual([blockedIssueId]);

    const wake = await db
      .select({
        reason: agentWakeupRequests.reason,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.agentId, agentId))
      .orderBy(agentWakeupRequests.requestedAt)
      .then((rows) => rows[0] ?? null);
    expect(wake).toMatchObject({
      reason: "issue_blockers_resolved",
      idempotencyKey: buildIssueBlockersResolvedWakeStateKey({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });
  });

  it("does not duplicate an existing dependency wake keyed to any resolved blocker", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Second completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    const blockerIdNotUsedByBackstop = readiness.blockerIssueIds.find((id) => id !== blockerIssueId);
    if (!blockerIdNotUsedByBackstop) {
      throw new Error("Expected a second blocker id in dependency readiness");
    }
    expect(blockerIdNotUsedByBackstop).toBe(secondBlockerIssueId);
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIdNotUsedByBackstop,
      },
      status: "queued",
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);

    const wakes = await db
      .select({
        id: agentWakeupRequests.id,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.reason, "issue_blockers_resolved")));
    expect(wakes).toHaveLength(1);
    expect(wakes[0]?.idempotencyKey).toBe(
      `issue_blockers_resolved:${blockedIssueId}:${blockerIdNotUsedByBackstop}`,
    );
  });

  it("heals a multi-blocker dependent when only a completed wake for an earlier blocker exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const secondBlockerIssueId = randomUUID();
    await db.insert(issues).values({
      id: secondBlockerIssueId,
      companyId,
      title: "Earlier completed blocker",
      status: "done",
      priority: "medium",
      issueNumber: 3,
      identifier: "R-MULTI-3",
    });
    await db.insert(issueRelations).values({
      companyId,
      issueId: secondBlockerIssueId,
      relatedIssueId: blockedIssueId,
      type: "blocks",
    });

    // An earlier partial resolution left a `completed` per-edge wake. The bug was
    // that this stale wake suppressed the wake for the current ready state. The
    // level-triggered dedup keys on the full blocker set, so this completed wake
    // no longer strands the dependent.
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: secondBlockerIssueId,
      },
      status: "completed",
      finishedAt: new Date(),
      idempotencyKey: `issue_blockers_resolved:${blockedIssueId}:${secondBlockerIssueId}`,
    });

    const readiness = await issueService(db).getDependencyReadiness(blockedIssueId);
    expect(readiness.isDependencyReady).toBe(true);

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const stateKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: readiness.blockerIssueIds,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    // A second reconciliation pass finds the state-key wake and stays bounded:
    // it heals nothing more and never enqueues a second wake for the same state.
    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const stateKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, stateKey)));
    expect(stateKeyWakes).toHaveLength(1);
  });

  it("heals a blocked dependent after a terminal reset when a previous-cycle old-key wake exists", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const previousCycleWakeAt = new Date("2026-07-01T12:00:00.000Z");
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: previousCycleWakeAt,
      requestedAt: previousCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(1);
    expect(result.issueIds).toEqual([blockedIssueId]);
    expect(result.existingWakeSkipped).toBe(0);

    const cycleKey = buildIssueBlockersResolvedWakeStateKey({
      dependentIssueId: blockedIssueId,
      blockerIssueIds: [blockerIssueId],
      blockedTransitionAt,
    });
    const healedWake = await db
      .select({ status: agentWakeupRequests.status, idempotencyKey: agentWakeupRequests.idempotencyKey })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)))
      .then((rows) => rows[0] ?? null);
    expect(healedWake).not.toBeNull();
    expect(["queued", "claimed", "completed"]).toContain(healedWake?.status);

    const secondPass = await heartbeatService(db).reconcileResolvedDependencyWakes();
    expect(secondPass.healed).toBe(0);

    const cycleKeyWakes = await db
      .select({ id: agentWakeupRequests.id })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.idempotencyKey, cycleKey)));
    expect(cycleKeyWakes).toHaveLength(1);
  });

  it("does not re-heal when a completed old-key wake is from the current blocked cycle", async () => {
    const { companyId, agentId, blockedIssueId, blockerIssueId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    const blockedTransitionAt = new Date("2026-08-01T12:00:00.000Z");
    const sameCycleWakeAt = new Date("2026-08-01T12:00:01.000Z");
    await db
      .update(issues)
      .set({ blockedTransitionAt, updatedAt: blockedTransitionAt })
      .where(eq(issues.id, blockedIssueId));
    await db.insert(agentWakeupRequests).values({
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: "issue_blockers_resolved",
      payload: {
        issueId: blockedIssueId,
        resolvedBlockerIssueId: blockerIssueId,
        blockerIssueIds: [blockerIssueId],
      },
      status: "completed",
      finishedAt: sameCycleWakeAt,
      requestedAt: sameCycleWakeAt,
      idempotencyKey: buildIssueBlockersResolvedWakeStateKeyWithoutCycle({
        dependentIssueId: blockedIssueId,
        blockerIssueIds: [blockerIssueId],
      }),
    });

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.existingWakeSkipped).toBe(1);
  });

  it("counts null dependency wake returns as deferred instead of enqueue failures", async () => {
    const { companyId, agentId } =
      await seedResolvedDependencyBackstopFixture({ workspaceState: "none" });
    await db
      .update(agents)
      .set({
        runtimeConfig: { heartbeat: { wakeOnDemand: false, maxConcurrentRuns: 1 } },
      })
      .where(eq(agents.id, agentId));

    const result = await heartbeatService(db).reconcileResolvedDependencyWakes();

    expect(result.healed).toBe(0);
    expect(result.deferredOrFailed).toBe(1);
    expect(result.enqueueFailed).toBe(0);

    const skippedWake = await db
      .select({
        status: agentWakeupRequests.status,
        reason: agentWakeupRequests.reason,
      })
      .from(agentWakeupRequests)
      .where(and(eq(agentWakeupRequests.companyId, companyId), eq(agentWakeupRequests.agentId, agentId)))
      .then((rows) => rows[0] ?? null);
    expect(skippedWake).toMatchObject({
      status: "skipped",
      reason: "heartbeat.wakeOnDemand.disabled",
    });
  });

});
