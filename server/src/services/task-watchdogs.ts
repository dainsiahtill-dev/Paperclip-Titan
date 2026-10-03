import { createHash } from "node:crypto";
import { and, asc, desc, eq, gte, inArray, isNotNull, isNull, lte, or, sql } from "drizzle-orm";
import type { Db } from "@paperclipai/db";
import {
  agentWakeupRequests,
  activityLog,
  agents,
  approvals,
  heartbeatRuns,
  issueComments,
  issueDocuments,
  issueApprovals,
  issueRelations,
  issues,
  issueThreadInteractions,
  issueWatchdogs,
  issueWorkProducts,
} from "@paperclipai/db";
import { issueWatchdogAttempts, issueWatchdogRecoveryBatches, issueWatchdogRecoveryOutbox } from "@paperclipai/db/schema/issue_watchdogs";
import type { RecoveryBatch, RecoveryBatchReceipt, RecoveryMutation, RestorationDisposition } from "@paperclipai/shared/types/watchdog";
import { recoveryBatchSchema, watchdogDispositionSchema, type WatchdogDispositionInput } from "@paperclipai/shared/validators/watchdog";
import type { IssueWatchdog, IssueWatchdogSummary } from "@paperclipai/shared";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { parseObject } from "../adapters/utils.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { evaluateAgentInvokabilityFromDb } from "./agent-invokability.js";
import { issueService } from "./issues.js";
import { visibleIssueCondition } from "./issue-visibility.js";
import { TASK_WATCHDOG_ORIGIN_KIND, resolveTaskWatchdogMutationScope, taskWatchdogScopeAllowsIssueMutation } from "./task-watchdog-scope.js";
import { issueTreeControlService } from "./issue-tree-control.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { observeCrossIssueInfluence, crossIssueInfluenceLimitError } from "./cross-issue-influence-limit.js";
import { isNativeRunnerOwnershipHeld } from "./native-runtime/native-runner-ownership.js";

const TASK_WATCHDOG_STOP_FINGERPRINT_PREFIX = "task_watchdog_stop:";
const TASK_WATCHDOG_SUBTREE_MAX_DEPTH = 100;
const TASK_WATCHDOG_LIVE_RUN_STATUSES = ["queued", "running", "scheduled_retry"] as const;
const TASK_WATCHDOG_WAKE_REQUEST_STATUSES = ["queued", "deferred_issue_execution"] as const;
const TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES = ["done", "cancelled"] as const;
const TASK_WATCHDOG_TERMINAL_RUN_STATUSES = ["succeeded", "interrupted", "failed", "cancelled", "timed_out"] as const;
// Grace window after an issue is created/assigned during which its first
// assignment run/wake may have been enqueued but is not yet visible to a
// watchdog evaluation (the eval can race the issue's own assignment run).
// Within this window a non-terminal issue that has never completed a run is
// treated as not-yet-stopped so the evaluation does not produce a
// false-positive stopped-subtree review. The periodic watchdog reconciler
// re-evaluates after the window, so a genuinely idle issue still triggers.
const TASK_WATCHDOG_FIRST_RUN_GRACE_MS = 15_000;
const TASK_WATCHDOG_VERIFICATION_DELAY_MS = 30_000;

type ActorFields = {
  agentId?: string | null;
  userId?: string | null;
  runId?: string | null;
};

export type IssueWatchdogUpsertInput = {
  agentId: string;
  instructions?: string | null;
  maxAttempts?: 2 | 3;
  actor?: ActorFields;
};

type IssueWatchdogRow = typeof issueWatchdogs.$inferSelect;
type IssueRow = typeof issues.$inferSelect;

export type TaskWatchdogClassifierIssue = Pick<
  IssueRow,
  | "id"
  | "companyId"
  | "identifier"
  | "title"
  | "status"
  | "parentId"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "originKind"
  | "updatedAt"
> & {
  // Optional so existing callers/tests that do not care about the first-run
  // grace window keep working; the pending-first-run guard is skipped when
  // it (or `evaluatedAt`) is absent.
  createdAt?: Date | string | null;
  latestCommentAt?: Date | string | null;
  latestDocumentAt?: Date | string | null;
  latestWorkProductAt?: Date | string | null;
  executionPolicy?: unknown;
  executionState?: unknown;
  monitorNextCheckAt?: Date | string | null;
  monitorAttemptCount?: number;
  unblockDescriptor?: unknown;
  pauseHoldId?: string | null;
};

export type TaskWatchdogClassifierPath = {
  companyId: string;
  issueId: string | null;
  agentId?: string | null;
  status: string;
  retainedOwnership?: boolean;
};

export type TaskWatchdogClassifierWaitingPath = {
  companyId: string;
  issueId: string;
  id?: string | null;
  kind?: string | null;
  status: string;
};

export type TaskWatchdogClassifierRelation = {
  companyId: string;
  blockerIssueId: string;
  blockedIssueId: string;
};

export type TaskWatchdogClassifierConfig = Pick<
  IssueWatchdogSummary,
  "companyId" | "issueId" | "lastReviewedFingerprint"
> & {
  lastReviewedStopSnapshot?: TaskWatchdogStopSnapshot | null;
  restorationDisposition?: string | null;
  configurationRevision?: string | null;
};

export type TaskWatchdogStoppedLeaf = {
  issueId: string;
  identifier: string | null;
  title: string;
  status: string;
  assigneeAgentId: string | null;
  assigneeUserId: string | null;
  blockerIssueIds: string[];
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
  updatedAt: string;
  latestCommentAt: string | null;
  latestDocumentAt: string | null;
  latestWorkProductAt: string | null;
};

export type TaskWatchdogMaterialLeaf = Pick<
  TaskWatchdogStoppedLeaf,
  | "issueId"
  | "status"
  | "assigneeAgentId"
  | "assigneeUserId"
  | "blockerIssueIds"
  | "pendingInteractionIds"
  | "pendingApprovalIds"
>;
type TaskWatchdogMaterialNode = TaskWatchdogMaterialLeaf & {
  waitingState?: unknown;
};

export type TaskWatchdogWaitsByIssueId = Record<string, {
  pendingInteractionIds: string[];
  pendingApprovalIds: string[];
}>;

export type TaskWatchdogStopSnapshot = {
  version: 2;
  fingerprint: string;
  materialLeaves: TaskWatchdogMaterialLeaf[];
  materialNodes?: TaskWatchdogMaterialNode[];
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
};

type TaskWatchdogPendingInteractionsByIssueId = Record<string, Array<{
  id: string;
  kind: string | null;
}>>;

export type TaskWatchdogClassifierResult =
  | {
    state: "ownership_held";
    reason: string;
    includedIssueIds: string[];
    ownershipIssueIds: string[];
  }
  | {
    state: "not_applicable";
    reason: string;
    includedIssueIds: string[];
  }
  | {
    state: "live";
    reason: string;
    includedIssueIds: string[];
    liveIssueIds: string[];
  }
  | {
    state: "pending_first_run";
    reason: string;
    includedIssueIds: string[];
    pendingIssueIds: string[];
  }
  | {
    state: "already_reviewed";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  }
  | {
    state: "stopped";
    reason: string;
    includedIssueIds: string[];
    stopFingerprint: string;
    stoppedLeaves: TaskWatchdogStoppedLeaf[];
    stopSnapshot: TaskWatchdogStopSnapshot;
    pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  };

export type TaskWatchdogClassifierInput = {
  watchdog: TaskWatchdogClassifierConfig;
  issues: TaskWatchdogClassifierIssue[];
  activeRuns?: TaskWatchdogClassifierPath[];
  queuedWakeRequests?: TaskWatchdogClassifierPath[];
  blockers?: TaskWatchdogClassifierRelation[];
  pendingInteractions?: TaskWatchdogClassifierWaitingPath[];
  pendingApprovals?: TaskWatchdogClassifierWaitingPath[];
  // Timestamp the evaluation reads its snapshot at. When provided together
  // with a positive `firstRunGraceMs`, the classifier suppresses a
  // stopped-subtree verdict for issues created within the grace window that
  // have never completed a run (their first assignment run/wake may not yet
  // be visible). Omit to disable the guard (legacy behavior).
  evaluatedAt?: Date | string | null;
  firstRunGraceMs?: number | null;
  // Ids of included issues that have at least one run in a terminal status.
  // Such issues are never treated as "pending first run" — they have
  // demonstrably executed, so a stop is genuine rather than a snapshot race.
  completedRunIssueIds?: string[];
};

type TaskWatchdogEvaluation =
  | { state: "triggered"; classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>; watchdogIssueId: string; wakeupRunId: string | null }
  | { state: "watchdog_live" | "watchdog_review_open"; classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>; watchdogIssueId: string }
  | { state: Exclude<TaskWatchdogClassifierResult["state"], "stopped"> | "skipped" | "escalated" | "verification_pending"; reason: string; classification?: TaskWatchdogClassifierResult };

type TaskWatchdogWakeupOptions = {
  source?: "timer" | "assignment" | "on_demand" | "automation";
  triggerDetail?: "manual" | "ping" | "callback" | "system";
  reason?: string | null;
  payload?: Record<string, unknown> | null;
  idempotencyKey?: string | null;
  requestedByActorType?: "user" | "agent" | "system";
  requestedByActorId?: string | null;
  contextSnapshot?: Record<string, unknown>;
};

type TaskWatchdogWakeup = (
  agentId: string,
  opts?: TaskWatchdogWakeupOptions,
) => Promise<{ id: string } | null>;

export type TaskWatchdogServiceDeps = {
  enqueueWakeup?: TaskWatchdogWakeup;
};

function normalizeInstructions(value: string | null | undefined): string | null {
  if (value == null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

export function summarizeIssueWatchdog(row: IssueWatchdogRow): IssueWatchdogSummary {
  return {
    id: row.id,
    companyId: row.companyId,
    issueId: row.issueId,
    watchdogAgentId: row.watchdogAgentId,
    instructions: row.instructions,
    status: row.status as IssueWatchdogSummary["status"],
    watchdogIssueId: row.watchdogIssueId,
    lastObservedFingerprint: row.lastObservedFingerprint,
    lastReviewedFingerprint: row.lastReviewedFingerprint,
    lastTriggeredAt: row.lastTriggeredAt,
    lastCompletedAt: row.lastCompletedAt,
    triggerCount: row.triggerCount,
    maxAttempts: row.restorationMaxAttempts as 2 | 3,
    restorationLineage: row.restorationSourceFingerprint ? {
      version: 1,
      sourceFingerprint: row.restorationSourceFingerprint,
      claimedFingerprint: row.restorationClaimedFingerprint ?? row.restorationSourceFingerprint,
      attemptCount: row.restorationAttemptCount,
      maxAttempts: row.restorationMaxAttempts as 2 | 3,
      disposition: row.restorationDisposition as RestorationDisposition | null,
      verificationDueAt: optionalIso(row.verificationDueAt),
      actionIds: row.restorationActionIds,
    } : null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toIssueWatchdog(row: IssueWatchdogRow): IssueWatchdog {
  return {
    ...summarizeIssueWatchdog(row),
    createdByAgentId: row.createdByAgentId,
    createdByUserId: row.createdByUserId,
    createdByRunId: row.createdByRunId,
    updatedByAgentId: row.updatedByAgentId,
    updatedByUserId: row.updatedByUserId,
    updatedByRunId: row.updatedByRunId,
  };
}

function issueUpdatedAtIso(issue: Pick<TaskWatchdogClassifierIssue, "updatedAt">) {
  return issue.updatedAt instanceof Date
    ? issue.updatedAt.toISOString()
    : new Date(String(issue.updatedAt)).toISOString();
}

function optionalIso(value: Date | string | null | undefined): string | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return new Date(ms).toISOString();
}

function toEpochMs(value: Date | string | null | undefined): number | null {
  if (value == null) return null;
  const ms = value instanceof Date ? value.getTime() : new Date(value).getTime();
  return Number.isFinite(ms) ? ms : null;
}

function pathIssueIds(paths: TaskWatchdogClassifierPath[] | undefined, companyId: string) {
  return new Set(
    (paths ?? [])
      .filter((path) => path.companyId === companyId && typeof path.issueId === "string" && path.issueId.length > 0)
      .map((path) => path.issueId as string),
  );
}

function waitingPathIds(
  paths: TaskWatchdogClassifierWaitingPath[] | undefined,
  companyId: string,
  issueId: string,
) {
  return (paths ?? [])
    .filter((path) => path.companyId === companyId && path.issueId === issueId)
    .map((path) => path.id ?? `${path.status}:${path.issueId}`)
    .sort();
}

function stableStopFingerprint(input: {
  companyId: string;
  watchedIssueId: string;
  materialLeaves: TaskWatchdogMaterialLeaf[];
  materialNodes: TaskWatchdogMaterialNode[];
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
  configurationRevision?: string | null;
}) {
  const payload = JSON.stringify({
    version: 2,
    companyId: input.companyId,
    watchedIssueId: input.watchedIssueId,
    materialLeaves: input.materialLeaves,
    materialNodes: input.materialNodes,
    waitsByIssueId: input.waitsByIssueId,
    configurationRevision: input.configurationRevision ?? null,
  });
  return `task_watchdog_stop:${createHash("sha256").update(payload).digest("hex")}`;
}

function materialLeaf(leaf: TaskWatchdogStoppedLeaf): TaskWatchdogMaterialLeaf {
  return {
    issueId: leaf.issueId,
    status: leaf.status,
    assigneeAgentId: leaf.assigneeAgentId,
    assigneeUserId: leaf.assigneeUserId,
    blockerIssueIds: leaf.blockerIssueIds,
    pendingInteractionIds: leaf.pendingInteractionIds,
    pendingApprovalIds: leaf.pendingApprovalIds,
  };
}

function parseStopSnapshot(value: unknown): TaskWatchdogStopSnapshot | null {
  if (!value || typeof value !== "object") return null;
  const candidate = value as Partial<TaskWatchdogStopSnapshot>;
  if (
    candidate.version !== 2 ||
    typeof candidate.fingerprint !== "string" ||
    !Array.isArray(candidate.materialLeaves) ||
    !candidate.waitsByIssueId ||
    typeof candidate.waitsByIssueId !== "object"
  ) return null;
  return candidate as TaskWatchdogStopSnapshot;
}

// Snapshots loaded from jsonb columns come back with Postgres's normalized key
// order, so equality checks against freshly built snapshots must not depend on
// object key order.
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, val) =>
    val && typeof val === "object" && !Array.isArray(val)
      ? Object.fromEntries(
        Object.entries(val as Record<string, unknown>).sort(([left], [right]) =>
          left < right ? -1 : left > right ? 1 : 0
        ),
      )
      : val);
}

function isShrinkOfReviewedSnapshot(
  current: TaskWatchdogStopSnapshot,
  reviewed: TaskWatchdogStopSnapshot | null | undefined,
) {
  if (!reviewed || canonicalJson(current.waitsByIssueId) !== canonicalJson(reviewed.waitsByIssueId)) return false;
  if (current.materialNodes && reviewed.materialNodes) {
    const previousNodes = new Map(reviewed.materialNodes.map((node) => [node.issueId, node]));
    if (!current.materialNodes.every((node) => canonicalJson(previousNodes.get(node.issueId)) === canonicalJson(node))) return false;
  }
  const reviewedLeaves = new Map(reviewed.materialLeaves.map((leaf) => [leaf.issueId, leaf]));
  return current.materialLeaves.every((leaf) => {
    const previous = reviewedLeaves.get(leaf.issueId);
    return previous != null && canonicalJson(previous) === canonicalJson(leaf);
  });
}

export function classifyTaskWatchdogSubtree(input: TaskWatchdogClassifierInput): TaskWatchdogClassifierResult {
  const issuesById = new Map(input.issues.map((issue) => [issue.id, issue]));
  const root = issuesById.get(input.watchdog.issueId);
  if (!root || root.companyId !== input.watchdog.companyId) {
    return { state: "not_applicable", reason: "Watched issue is missing.", includedIssueIds: [] };
  }
  if (root.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
    return {
      state: "not_applicable",
      reason: "Task watchdog origin issues cannot themselves be watched.",
      includedIssueIds: [],
    };
  }

  const childrenByParentId = new Map<string, TaskWatchdogClassifierIssue[]>();
  for (const issue of input.issues) {
    if (issue.companyId !== input.watchdog.companyId || !issue.parentId) continue;
    const list = childrenByParentId.get(issue.parentId) ?? [];
    list.push(issue);
    childrenByParentId.set(issue.parentId, list);
  }
  for (const children of childrenByParentId.values()) {
    children.sort((left, right) => left.id.localeCompare(right.id));
  }

  const included: TaskWatchdogClassifierIssue[] = [];
  const visit = (issue: TaskWatchdogClassifierIssue) => {
    if (issue.originKind === TASK_WATCHDOG_ORIGIN_KIND) return;
    included.push(issue);
    for (const child of childrenByParentId.get(issue.id) ?? []) {
      visit(child);
    }
  };
  visit(root);
  if (included.length === 0) {
    return { state: "not_applicable", reason: "Watched subtree has no non-watchdog issues.", includedIssueIds: [] };
  }

  const includedIds = included.map((issue) => issue.id);
  const includedIdSet = new Set(includedIds);
  const ownershipIssueIds = [...new Set((input.activeRuns ?? []).filter((path) =>
    path.companyId === input.watchdog.companyId && path.retainedOwnership && path.issueId && includedIdSet.has(path.issueId),
  ).map((path) => path.issueId!))].sort();
  if (ownershipIssueIds.length) return {
    state: "ownership_held", reason: "Provider execution ownership remains held without confirmed physical stop; restoration must not clear execution locks or launch duplicate work.",
    includedIssueIds: includedIds, ownershipIssueIds,
  };
  const liveIssueIds = [
    ...pathIssueIds(input.activeRuns, input.watchdog.companyId),
    ...pathIssueIds(input.queuedWakeRequests, input.watchdog.companyId),
  ].filter((issueId) => includedIdSet.has(issueId));
  const uniqueLiveIssueIds = [...new Set(liveIssueIds)].sort();
  if (uniqueLiveIssueIds.length > 0) {
    return {
      state: "live",
      reason: "At least one issue in the watched subtree has a live run, queued wake, or scheduled retry.",
      includedIssueIds: includedIds,
      liveIssueIds: uniqueLiveIssueIds,
    };
  }

  // Pending-first-run guard: a watchdog evaluation triggered as part of issue
  // (or watchdog) creation can read its snapshot before the issue's own
  // assignment run/wake is committed/visible, making an actively-starting
  // subtree look idle. Suppress the stopped verdict for non-terminal issues
  // created within the first-run grace window that have never completed a run.
  const evaluatedAtMs = toEpochMs(input.evaluatedAt);
  const graceMs = input.firstRunGraceMs ?? 0;
  if (evaluatedAtMs != null && graceMs > 0) {
    const completedRunIssueIds = new Set(input.completedRunIssueIds ?? []);
    const pendingIssueIds = included
      .filter((issue) => {
        if (isTerminalIssueStatus(issue.status)) return false;
        if (completedRunIssueIds.has(issue.id)) return false;
        const createdAtMs = toEpochMs(issue.createdAt);
        if (createdAtMs == null) return false;
        return evaluatedAtMs - createdAtMs < graceMs;
      })
      .map((issue) => issue.id)
      .sort();
    if (pendingIssueIds.length > 0) {
      return {
        state: "pending_first_run",
        reason:
          "A watched issue was created within the first-run grace window and has not yet completed a run; deferring evaluation until its first assignment run/wake is observable.",
        includedIssueIds: includedIds,
        pendingIssueIds,
      };
    }
  }

  const includedChildrenByParentId = new Map<string, string[]>();
  for (const issue of included) {
    if (!issue.parentId || !includedIdSet.has(issue.parentId)) continue;
    const list = includedChildrenByParentId.get(issue.parentId) ?? [];
    list.push(issue.id);
    includedChildrenByParentId.set(issue.parentId, list);
  }
  const blockersByIssueId = new Map<string, string[]>();
  for (const relation of input.blockers ?? []) {
    if (relation.companyId !== input.watchdog.companyId) continue;
    if (!includedIdSet.has(relation.blockedIssueId)) continue;
    const list = blockersByIssueId.get(relation.blockedIssueId) ?? [];
    list.push(relation.blockerIssueId);
    blockersByIssueId.set(relation.blockedIssueId, list);
  }

  const nonTerminalIssues = included
    .filter((issue) => !isTerminalIssueStatus(issue.status))
    .sort((left, right) => left.id.localeCompare(right.id));
  const waitsByIssueId = Object.fromEntries(nonTerminalIssues
    .map((issue) => [issue.id, {
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
    }] as const)
    .filter(([, waits]) => waits.pendingInteractionIds.length > 0 || waits.pendingApprovalIds.length > 0));
  const pendingInteractionsByIssueId = Object.fromEntries(nonTerminalIssues
    .map((issue) => [issue.id, (input.pendingInteractions ?? [])
      .filter((path) => path.companyId === input.watchdog.companyId && path.issueId === issue.id)
      .map((path) => ({ id: path.id ?? `${path.status}:${path.issueId}`, kind: path.kind ?? null }))
      .sort((left, right) => left.id.localeCompare(right.id))] as const)
    .filter(([, waits]) => waits.length > 0));

  const leaves = included
    .filter((issue) => (includedChildrenByParentId.get(issue.id) ?? []).length === 0)
    .filter((issue) => !isTerminalIssueStatus(issue.status))
    .sort((left, right) => left.id.localeCompare(right.id))
    .map((issue) => ({
      issueId: issue.id,
      identifier: issue.identifier,
      title: issue.title,
      status: issue.status,
      assigneeAgentId: issue.assigneeAgentId,
      assigneeUserId: issue.assigneeUserId,
      blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
      pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
      pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
      updatedAt: issueUpdatedAtIso(issue),
      latestCommentAt: optionalIso(issue.latestCommentAt),
      latestDocumentAt: optionalIso(issue.latestDocumentAt),
      latestWorkProductAt: optionalIso(issue.latestWorkProductAt),
    }));
  const materialLeaves = leaves.map(materialLeaf);
  const materialNodes = nonTerminalIssues.map((issue) => ({
    issueId: issue.id, status: issue.status, assigneeAgentId: issue.assigneeAgentId,
    assigneeUserId: issue.assigneeUserId,
    blockerIssueIds: [...new Set(blockersByIssueId.get(issue.id) ?? [])].sort(),
    pendingInteractionIds: waitingPathIds(input.pendingInteractions, input.watchdog.companyId, issue.id),
    pendingApprovalIds: waitingPathIds(input.pendingApprovals, input.watchdog.companyId, issue.id),
    waitingState: {
      pauseHoldId: issue.pauseHoldId ?? null,
      executionPolicy: issue.executionPolicy ?? null,
      executionState: issue.executionState ?? null,
      monitorNextCheckAt: optionalIso(issue.monitorNextCheckAt),
      unblockDescriptor: issue.unblockDescriptor ?? null,
    },
  }));
  const stopFingerprint = stableStopFingerprint({
    companyId: input.watchdog.companyId,
    watchedIssueId: input.watchdog.issueId,
    materialLeaves,
    materialNodes,
    waitsByIssueId,
    configurationRevision: input.watchdog.configurationRevision,
  });
  const currentStopSnapshot: TaskWatchdogStopSnapshot = {
    version: 2,
    fingerprint: stopFingerprint,
    materialLeaves,
    materialNodes,
    waitsByIssueId,
  };

  if (
    input.watchdog.restorationDisposition !== "restoration_claimed" && (
    input.watchdog.lastReviewedFingerprint === stopFingerprint ||
    isShrinkOfReviewedSnapshot(currentStopSnapshot, input.watchdog.lastReviewedStopSnapshot)
    )
  ) {
    return {
      state: "already_reviewed",
      reason: "The current stopped subtree fingerprint was already reviewed by the watchdog.",
      includedIssueIds: includedIds,
      stopFingerprint,
      stoppedLeaves: leaves,
      stopSnapshot: currentStopSnapshot,
      pendingInteractionsByIssueId,
    };
  }

  return {
    state: "stopped",
    reason: "No issue in the watched subtree has a live execution path.",
    includedIssueIds: includedIds,
    stopFingerprint,
    stoppedLeaves: leaves,
    stopSnapshot: currentStopSnapshot,
    pendingInteractionsByIssueId,
  };
}

async function assertWatchedIssue(dbOrTx: any, companyId: string, issueId: string) {
  const issue = await dbOrTx
    .select({ id: issues.id, companyId: issues.companyId })
    .from(issues)
    .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)))
    .then((rows: Array<{ id: string; companyId: string }>) => rows[0] ?? null);
  if (!issue) throw notFound("Issue not found");
  return issue;
}

async function assertWatchdogAgentInvokable(dbOrTx: any, companyId: string, agentId: string) {
  const agent = await dbOrTx
    .select({
      id: agents.id,
      companyId: agents.companyId,
      name: agents.name,
      reportsTo: agents.reportsTo,
      status: agents.status,
    })
    .from(agents)
    .where(eq(agents.id, agentId))
    .then((rows: Array<{
      id: string;
      companyId: string;
      name: string;
      reportsTo: string | null;
      status: string;
    }>) => rows[0] ?? null);
  if (!agent || agent.companyId !== companyId) {
    throw notFound("Watchdog agent not found");
  }
  const invokability = await evaluateAgentInvokabilityFromDb(dbOrTx as Db, agent);
  if (!invokability.invokable) {
    throw conflict("Cannot assign watchdog to an agent that is not invokable", invokability);
  }
  return agent;
}

function readNonEmptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function postgresFailureCode(error: unknown): string | null {
  const seen = new Set<unknown>();
  let candidate: unknown = error;
  while (candidate && typeof candidate === "object" && !seen.has(candidate)) {
    seen.add(candidate);
    const failure = candidate as { code?: unknown; cause?: unknown };
    if (typeof failure.code === "string") return failure.code;
    candidate = failure.cause;
  }
  return null;
}

function issueIdFromRunContext(contextSnapshot: unknown) {
  const context = parseObject(contextSnapshot);
  return readNonEmptyString(context.issueId) ?? readNonEmptyString(context.taskId);
}

function issueIdFromWakePayload(payload: unknown) {
  const parsed = parseObject(payload);
  const nested = parseObject(parsed._paperclipWakeContext);
  return readNonEmptyString(parsed.issueId) ??
    readNonEmptyString(parsed.taskId) ??
    readNonEmptyString(nested.issueId) ??
    readNonEmptyString(nested.taskId);
}

function normalizeStopFingerprint(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed?.startsWith(TASK_WATCHDOG_STOP_FINGERPRINT_PREFIX) ? trimmed : null;
}

function stopFingerprintFromText(value: string | null | undefined) {
  const match = value?.match(/task_watchdog_stop:[a-f0-9]+/i);
  return normalizeStopFingerprint(match?.[0] ?? null);
}

function reviewedFingerprintForWatchdogIssue(issue: Pick<IssueRow, "originFingerprint" | "description">) {
  return normalizeStopFingerprint(issue.originFingerprint) ?? stopFingerprintFromText(issue.description);
}

function taskWatchdogWakeIdempotencyKey(watchdogId: string, stopFingerprint: string) {
  return `task_watchdog:${watchdogId}:${stopFingerprint}`;
}

function watchdogRunObservationCondition() {
  // capacityReleasedAt is owned by native/legacy verified-stop release paths.
  // A watchdog reads that proof; it never releases a reservation itself.
  return or(inArray(heartbeatRuns.status, [...TASK_WATCHDOG_LIVE_RUN_STATUSES]),
    and(isNotNull(heartbeatRuns.capacityGroup), isNull(heartbeatRuns.capacityReleasedAt)));
}

function watchdogRunRetainsOwnership(run: {
  status: string; capacityGroup: string | null; capacityReleasedAt: Date | null;
  runtimeMode: string; nativePhase: string | null; errorCode: string | null;
}) {
  return isNativeRunnerOwnershipHeld(run) ||
    (!TASK_WATCHDOG_LIVE_RUN_STATUSES.includes(run.status as typeof TASK_WATCHDOG_LIVE_RUN_STATUSES[number]) && run.capacityGroup !== null && run.capacityReleasedAt === null);
}

function buildStoppedFingerprintComment(input: {
  sourceIssue: Pick<IssueRow, "identifier" | "id">;
  stopFingerprint: string;
  stoppedLeaves: TaskWatchdogStoppedLeaf[];
  pendingInteractionsByIssueId: TaskWatchdogPendingInteractionsByIssueId;
  resumed: boolean;
}) {
  const shortId = (id: string) => id.length > 8 ? `${id.slice(0, 8)}…` : id;
  const leafLines = input.stoppedLeaves.slice(0, 12).map((leaf) => {
    const interactionKinds = new Map(
      (input.pendingInteractionsByIssueId[leaf.issueId] ?? []).map((wait) => [wait.id, wait.kind]),
    );
    const waits = [
      ...leaf.pendingInteractionIds.map((id) => `${interactionKinds.get(id) ?? "interaction"} ${shortId(id)}`),
      ...leaf.pendingApprovalIds.map((id) => `approval ${shortId(id)}`),
    ];
    return `- ${leaf.identifier ?? leaf.issueId}: ${leaf.status}${waits.length > 0 ? ` (pending ${waits.join(", ")})` : ""}`;
  });
  const more = input.stoppedLeaves.length > leafLines.length
    ? `\n- ...and ${input.stoppedLeaves.length - leafLines.length} more stopped leaves`
    : "";
  return [
    input.resumed ? "Task watchdog resumed for stopped subtree." : "Task watchdog started for stopped subtree.",
    "",
    `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
    `Stopped fingerprint: \`${input.stopFingerprint}\``,
    "",
    "Stopped leaves:",
    ...(leafLines.length > 0 ? leafLines : ["- No leaf issues found."]),
    more,
  ].filter((line) => line !== "").join("\n");
}

function stoppedFingerprintMetadata(input: {
  sourceIssueId: string;
  stopFingerprint: string;
  waitsByIssueId: TaskWatchdogWaitsByIssueId;
  resumed: boolean;
}) {
  const pendingWaitCount = Object.values(input.waitsByIssueId).reduce(
    (count, waits) => count + waits.pendingInteractionIds.length + waits.pendingApprovalIds.length,
    0,
  );
  return {
    version: 1 as const,
    sections: [
      {
        title: "Task Watchdog",
        rows: [
          { type: "text" as const, label: "Watched issue", text: input.sourceIssueId },
          { type: "text" as const, label: "Stopped fingerprint", text: input.stopFingerprint },
          { type: "text" as const, label: "Pending waits", text: String(pendingWaitCount) },
          { type: "text" as const, label: "Resume intent", text: input.resumed ? "true" : "false" },
        ],
      },
    ],
  };
}

function watchdogWakeContext(input: {
  watchdog: IssueWatchdogRow;
  watchdogIssue: IssueRow;
  sourceIssue: IssueRow;
  classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
}) {
  return {
    issueId: input.watchdogIssue.id,
    taskId: input.watchdogIssue.id,
    wakeReason: "task_watchdog_stopped_subtree",
    source: TASK_WATCHDOG_ORIGIN_KIND,
    taskWatchdog: {
      watchedIssueId: input.sourceIssue.id,
      watchedIssueIdentifier: input.sourceIssue.identifier,
      watchedIssueTitle: input.sourceIssue.title,
      stopFingerprint: input.classification.stopFingerprint,
      pendingInteractions: input.classification.pendingInteractionsByIssueId,
      pendingApprovals: Object.fromEntries(Object.entries(input.classification.stopSnapshot.waitsByIssueId)
        .filter(([, waits]) => waits.pendingApprovalIds.length > 0)
        .map(([issueId, waits]) => [issueId, waits.pendingApprovalIds])),
      restorationLineage: {
        version: 1,
        sourceFingerprint: input.watchdog.restorationSourceFingerprint ?? input.classification.stopFingerprint,
        attemptCount: input.watchdog.restorationAttemptCount,
        maxAttempts: input.watchdog.restorationMaxAttempts,
      },
      capabilities: {
        targetScope: {
          watchedIssueId: input.sourceIssue.id,
          watchedIssueIdentifier: input.sourceIssue.identifier,
          watchdogIssueId: input.watchdogIssue.id,
          includeNonWatchdogDescendants: true,
          excludedOriginKinds: [TASK_WATCHDOG_ORIGIN_KIND],
        },
        operations: [
          "comment_on_watched_subtree_issues",
          "transition_watched_subtree_issue_status",
          "reassign_watched_subtree_issues",
          "create_child_issues_under_non_watchdog_watched_subtree",
          "create_product_bug_followups_outside_watched_subtree",
          "resolve_issue_thread_interactions_through_ordinary_audience_policy",
          "update_reusable_watchdog_issue",
          "atomic_recovery_batch_max_3",
          "record_structured_restoration_disposition",
        ],
        recovery: {
          version: 1,
          batchEndpoint: `/api/issues/${input.sourceIssue.id}/watchdog/recovery-batches`,
          dispositionEndpoint: `/api/issues/${input.sourceIssue.id}/watchdog/disposition`,
          maxMutations: 3,
          singleShotPerRun: true,
        },
        deniedOperations: [
          "create_visible_probe_issues_or_throwaway_tasks",
          "create_product_bug_followups_as_source_tree_children",
          "mutate_task_watchdog_descendants",
          "mutate_outside_watched_subtree",
          "resolve_human_only_interactions_or_security_sensitive_approvals",
          "create_nested_task_watchdogs",
          "cancel_active_runs",
          "change_resource_limits_or_execution_governance",
        ],
      },
    },
    watchdogId: input.watchdog.id,
    watchedIssueId: input.sourceIssue.id,
    watchedIssueIdentifier: input.sourceIssue.identifier,
    stopFingerprint: input.classification.stopFingerprint,
    stoppedLeaves: input.classification.stoppedLeaves,
    customInstructions: input.watchdog.instructions,
    resumeIntent: true,
    followUpRequested: true,
  };
}

function isTerminalIssueStatus(status: string) {
  return TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES.includes(
    status as (typeof TASK_WATCHDOG_TERMINAL_ISSUE_STATUSES)[number],
  );
}

function isWatchdogReviewDisposition(issue: Pick<
  IssueRow,
  "status" | "assigneeUserId" | "executionState" | "monitorNextCheckAt"
>, hasPendingReviewPath: boolean) {
  if (issue.status === "done" || issue.status === "blocked") return true;
  if (issue.status !== "in_review") return false;
  return Boolean(issue.assigneeUserId || issue.executionState || issue.monitorNextCheckAt || hasPendingReviewPath);
}

function isUniqueConstraintConflict(error: unknown, constraintName: string) {
  const queue: unknown[] = [error];
  const messages: string[] = [];
  let hasUniqueCode = false;
  let hasConstraint = false;
  for (const candidate of queue) {
    if (!candidate || typeof candidate !== "object") continue;
    const typed = candidate as {
      code?: string;
      constraint?: string;
      constraint_name?: string;
      cause?: unknown;
      message?: string;
    };
    if (typed.code === "23505") hasUniqueCode = true;
    if (typed.constraint === constraintName || typed.constraint_name === constraintName) hasConstraint = true;
    if (typed.message) messages.push(typed.message);
    if (typed.cause) queue.push(typed.cause);
  }
  const message = messages.join("\n");
  return (hasUniqueCode || message.includes("duplicate key value violates unique constraint")) &&
    (hasConstraint || message.includes(constraintName));
}

function isActiveTaskWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issues_active_task_watchdog_uq");
}

function isIssueWatchdogUniqueConflict(error: unknown) {
  return isUniqueConstraintConflict(error, "issue_watchdogs_company_issue_uq");
}

async function updateIssueWatchdogRow(
  dbOrTx: any,
  existing: IssueWatchdogRow,
  input: IssueWatchdogUpsertInput,
  now: Date,
) {
  const configurationChanged = existing.status !== "active" || existing.watchdogAgentId !== input.agentId ||
    existing.instructions !== normalizeInstructions(input.instructions) || (input.maxAttempts != null && input.maxAttempts !== existing.restorationMaxAttempts);
  const [updated] = await dbOrTx
    .update(issueWatchdogs)
    .set({
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      restorationMaxAttempts: input.maxAttempts ?? existing.restorationMaxAttempts,
      ...(configurationChanged ? {
        configurationVersion: sql`${issueWatchdogs.configurationVersion} + 1`,
        lastReviewedFingerprint: null, lastReviewedStopSnapshot: null,
        restorationDisposition: null, restorationSourceFingerprint: null,
        restorationClaimedFingerprint: null, restorationAttemptCount: 0, verificationDueAt: null,
      } : {}),
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      updatedAt: now,
    })
    .where(eq(issueWatchdogs.id, existing.id))
    .returning();
  return updated;
}

export async function upsertIssueWatchdogForIssue(
  dbOrTx: any,
  companyId: string,
  issueId: string,
  input: IssueWatchdogUpsertInput,
): Promise<{ watchdog: IssueWatchdog; created: boolean }> {
  await assertWatchedIssue(dbOrTx, companyId, issueId);
  await assertWatchdogAgentInvokable(dbOrTx, companyId, input.agentId);

  const now = new Date();
  const existing = await dbOrTx
    .select()
    .from(issueWatchdogs)
    .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
    .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);

  if (existing) {
    const updated = await updateIssueWatchdogRow(dbOrTx, existing, input, now);
    return { watchdog: toIssueWatchdog(updated), created: false };
  }

  const insertResult: { row: IssueWatchdogRow; created: boolean } = await dbOrTx
    .insert(issueWatchdogs)
    .values({
      companyId,
      issueId,
      watchdogAgentId: input.agentId,
      instructions: normalizeInstructions(input.instructions),
      status: "active",
      restorationMaxAttempts: input.maxAttempts ?? 3,
      createdByAgentId: input.actor?.agentId ?? null,
      createdByUserId: input.actor?.userId ?? null,
      createdByRunId: input.actor?.runId ?? null,
      updatedByAgentId: input.actor?.agentId ?? null,
      updatedByUserId: input.actor?.userId ?? null,
      updatedByRunId: input.actor?.runId ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .then((rows: IssueWatchdogRow[]) => ({ row: rows[0], created: true }))
    .catch(async (error: unknown) => {
      if (!isIssueWatchdogUniqueConflict(error)) throw error;
      const winner = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows: IssueWatchdogRow[]) => rows[0] ?? null);
      if (!winner) throw error;
      const updated = await updateIssueWatchdogRow(dbOrTx, winner, input, now);
      return { row: updated, created: false };
    });
  return { watchdog: toIssueWatchdog(insertResult.row), created: insertResult.created };
}

export function taskWatchdogService(db: Db, deps: TaskWatchdogServiceDeps = {}, inTransaction = false) {
  const issuesSvc = issueService(db);

  async function persistOutbox(watchdog: IssueWatchdogRow, issueId: string, kind: string, idempotencyKey: string, payload: Record<string, unknown>) {
    await db.insert(issueWatchdogRecoveryOutbox).values({ companyId: watchdog.companyId, watchdogId: watchdog.id, issueId, kind, idempotencyKey, payload }).onConflictDoNothing();
  }

  async function recordActivity(watchdog: IssueWatchdogRow, input: Parameters<typeof logActivity>[1]) {
    const publications: ActivityPublication[] = [];
    const activity = await logActivity(db, input, publications);
    for (const publication of publications) {
      await persistOutbox(watchdog, watchdog.watchdogIssueId ?? watchdog.issueId, "activity", `task_watchdog:activity:${activity.id}`, { publication });
    }
    return activity;
  }

  async function drainRecoveryOutbox(companyId?: string | null) {
    const pending = await db.select().from(issueWatchdogRecoveryOutbox).where(and(
      eq(issueWatchdogRecoveryOutbox.status, "pending"),
      or(isNull(issueWatchdogRecoveryOutbox.leaseExpiresAt), lte(issueWatchdogRecoveryOutbox.leaseExpiresAt, new Date())),
      ...(companyId ? [eq(issueWatchdogRecoveryOutbox.companyId, companyId)] : []),
    )).orderBy(asc(issueWatchdogRecoveryOutbox.createdAt)).limit(100);
    for (const row of pending) {
      if (row.kind !== "activity" && !deps.enqueueWakeup) continue;
      const leaseExpiresAt = new Date(Date.now() + 60_000);
      const [claim] = await db.update(issueWatchdogRecoveryOutbox).set({ leaseExpiresAt }).where(and(
        eq(issueWatchdogRecoveryOutbox.id, row.id), eq(issueWatchdogRecoveryOutbox.status, "pending"),
        or(isNull(issueWatchdogRecoveryOutbox.leaseExpiresAt), lte(issueWatchdogRecoveryOutbox.leaseExpiresAt, new Date())),
      )).returning();
      if (!claim) continue;
      try {
        let acceptedWakeId: string | null = null;
        if (row.kind === "activity") {
          publishActivity(row.payload.publication as unknown as ActivityPublication);
        } else {
          const agentId = readNonEmptyString(row.payload.agentId);
          if (!agentId) throw new Error("Watchdog outbox is missing its agent");
          if (row.kind === "watchdog") {
            const [current] = await db.select().from(issueWatchdogs).where(and(eq(issueWatchdogs.companyId, row.companyId), eq(issueWatchdogs.id, row.watchdogId)));
            const context = parseObject(row.payload.context), watchdogContext = parseObject(context.taskWatchdog), lineage = parseObject(watchdogContext.restorationLineage);
            let reason: string | null = null;
            if (!current || current.status !== "active" || current.watchdogAgentId !== agentId) reason = "watchdog_configuration_changed";
            else if (current.restorationDisposition === "escalated") reason = "lineage_escalated";
            else if (current.restorationAttemptCount !== lineage.attemptCount || current.restorationSourceFingerprint !== lineage.sourceFingerprint) reason = "attempt_superseded";
            else {
              const classified = classifyTaskWatchdogSubtree(await collectClassifierInput(row.companyId, current));
              if (["live", "ownership_held", "already_reviewed", "not_applicable"].includes(classified.state)) reason = `source_${classified.state}`;
            }
            if (reason) {
              await db.update(issueWatchdogRecoveryOutbox).set({ status: "suppressed", deliveryReason: reason, settledAt: new Date(), leaseExpiresAt: null }).where(and(eq(issueWatchdogRecoveryOutbox.id, row.id), eq(issueWatchdogRecoveryOutbox.leaseExpiresAt, leaseExpiresAt)));
              continue;
            }
          }
          const wake = await deps.enqueueWakeup!(agentId, {
            source: "automation", triggerDetail: "system",
            reason: row.kind === "watchdog" ? "task_watchdog_stopped_subtree" : "issue_assigned",
            payload: row.payload.context as Record<string, unknown>,
            contextSnapshot: row.payload.context as Record<string, unknown>,
            idempotencyKey: row.idempotencyKey,
            requestedByActorType: "system", requestedByActorId: null,
          });
          if (!wake) throw new Error("Watchdog wake was not accepted; durable outbox retained");
          acceptedWakeId = wake.id;
        }
        await db.update(issueWatchdogRecoveryOutbox).set({ status: row.kind === "activity" ? "published" : "enqueued", acceptedWakeId, deliveredAt: new Date(), settledAt: new Date(), leaseExpiresAt: null }).where(and(eq(issueWatchdogRecoveryOutbox.id, row.id), eq(issueWatchdogRecoveryOutbox.leaseExpiresAt, leaseExpiresAt)));
      } catch {
        await db.update(issueWatchdogRecoveryOutbox).set({ leaseExpiresAt: null }).where(and(eq(issueWatchdogRecoveryOutbox.id, row.id), eq(issueWatchdogRecoveryOutbox.leaseExpiresAt, leaseExpiresAt)));
      }
    }
  }

  async function currentAttempt(watchdog: IssueWatchdogRow) {
    if (!watchdog.restorationSourceFingerprint || !watchdog.restorationAttemptCount) return null;
    return db.select().from(issueWatchdogAttempts).where(and(
      eq(issueWatchdogAttempts.companyId, watchdog.companyId), eq(issueWatchdogAttempts.watchdogId, watchdog.id),
      eq(issueWatchdogAttempts.sourceFingerprint, watchdog.restorationSourceFingerprint), eq(issueWatchdogAttempts.attemptNumber, watchdog.restorationAttemptCount),
    )).then((rows) => rows[0] ?? null);
  }

  async function legitimateStoppedPath(input: TaskWatchdogClassifierInput, classification: TaskWatchdogClassifierResult) {
    if (!("stopFingerprint" in classification)) return false;
    const included = input.issues.filter((issue) => classification.includedIssueIds.includes(issue.id));
    if (included.every((issue) => isTerminalIssueStatus(issue.status))) return true;
    const frontier = classification.stoppedLeaves.length ? classification.stoppedLeaves.map((leaf) => leaf.issueId)
      : included.filter((issue) => !isTerminalIssueStatus(issue.status)).map((issue) => issue.id);
    const byId = new Map(included.map((issue) => [issue.id, issue]));
    for (const leafId of frontier) {
      let id: string | null = leafId; const seen = new Set<string>(); let waiting = false;
      while (id && !seen.has(id)) {
        seen.add(id); const issue = byId.get(id); if (!issue) break;
        const policy = normalizeIssueExecutionPolicy(issue.executionPolicy);
        const state = parseIssueExecutionState(issue.executionState);
        const monitorAt = toEpochMs(issue.monitorNextCheckAt ?? policy?.monitor?.nextCheckAt);
        const timeout = toEpochMs(policy?.monitor?.timeoutAt);
        const boundedMonitor = monitorAt != null && monitorAt > Date.now() && Boolean(issue.assigneeAgentId)
          && (timeout != null || policy?.monitor?.maxAttempts != null) && (timeout == null || timeout > Date.now())
          && (policy?.monitor?.maxAttempts == null || (issue.monitorAttemptCount ?? 0) < policy.monitor.maxAttempts);
        const descriptor = parseObject(issue.unblockDescriptor); const owner = descriptor.owner;
        if (issue.pauseHoldId || issue.assigneeUserId || state?.status === "pending" || boundedMonitor
          || owner === "board" || (owner && typeof owner === "object" && "userId" in owner)
          || classification.stopSnapshot.waitsByIssueId[id]?.pendingApprovalIds.length
          || classification.stopSnapshot.waitsByIssueId[id]?.pendingInteractionIds.length) { waiting = true; break; }
        // A first-class dependency on a human-owned issue is a real waiting
        // path. An idle agent-owned blocker is not evidence of restoration.
        const blockerIds = (input.blockers ?? []).filter((edge) => edge.blockedIssueId === id).map((edge) => edge.blockerIssueId);
        if (blockerIds.length) {
          const humanBlockers = await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.watchdog.companyId), inArray(issues.id, blockerIds), sql`${issues.assigneeUserId} is not null`, sql`${issues.status} not in ('done')`));
          if (humanBlockers.length) { waiting = true; break; }
        }
        id = issue.parentId;
      }
      if (!waiting) return false;
    }
    return frontier.length > 0;
  }

  async function saveDisposition(watchdog: IssueWatchdogRow, disposition: "legitimate_stop" | "restoration_claimed", input: {
    fingerprint: string; runId?: string | null; actionIds?: string[]; evidence: string; claimedFingerprint?: string; snapshot?: TaskWatchdogStopSnapshot | null;
  }) {
    const now = new Date();
    const due = disposition === "restoration_claimed" ? new Date(now.getTime() + TASK_WATCHDOG_VERIFICATION_DELAY_MS) : null;
    const actionIds = input.actionIds ?? watchdog.restorationActionIds;
    const [updated] = await db.update(issueWatchdogs).set({
      restorationDisposition: disposition, restorationClaimedFingerprint: input.claimedFingerprint ?? input.fingerprint,
      restorationRunId: input.runId ?? watchdog.restorationRunId, restorationActionIds: actionIds,
      verificationDueAt: due, lastCompletedAt: now, updatedAt: now,
      lastReviewedFingerprint: disposition === "legitimate_stop" ? input.fingerprint : null,
      lastReviewedStopSnapshot: disposition === "legitimate_stop" ? input.snapshot ?? null : null,
    }).where(eq(issueWatchdogs.id, watchdog.id)).returning();
    const attempt = await currentAttempt(watchdog);
    if (attempt) await db.update(issueWatchdogAttempts).set({ disposition, claimedFingerprint: input.claimedFingerprint ?? input.fingerprint, watchdogRunId: input.runId ?? attempt.watchdogRunId, actionIds, evidence: input.evidence, verificationDueAt: due }).where(eq(issueWatchdogAttempts.id, attempt.id));
    await recordActivity(updated ?? watchdog, {
      companyId: watchdog.companyId, actorType: input.runId ? "agent" : "system", actorId: input.runId ? watchdog.watchdogAgentId : "system",
      agentId: watchdog.watchdogAgentId, runId: input.runId ?? null,
      action: disposition === "legitimate_stop" ? "issue.task_watchdog_fingerprint_reviewed" : "issue.task_watchdog_restoration_claimed",
      entityType: "issue", entityId: watchdog.issueId,
      details: { watchdogId: watchdog.id, sourceIssueId: watchdog.issueId, watchdogIssueId: watchdog.watchdogIssueId, stopFingerprint: input.fingerprint, disposition, attemptCount: watchdog.restorationAttemptCount, actionIds },
    });
    return updated ?? watchdog;
  }

  async function escalate(watchdog: IssueWatchdogRow, classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>) {
    if (watchdog.restorationDisposition === "escalated") return;
    const history = await db.select().from(issueWatchdogAttempts).where(and(eq(issueWatchdogAttempts.companyId, watchdog.companyId), eq(issueWatchdogAttempts.watchdogId, watchdog.id), eq(issueWatchdogAttempts.sourceFingerprint, watchdog.restorationSourceFingerprint!))).orderBy(asc(issueWatchdogAttempts.attemptNumber));
    const owner = watchdog.updatedByUserId ?? watchdog.createdByUserId ?? "board";
    await db.update(issueWatchdogs).set({ restorationDisposition: "escalated", verificationDueAt: null, restorationClaimedFingerprint: classification.stopFingerprint, updatedAt: new Date() }).where(eq(issueWatchdogs.id, watchdog.id));
    if (watchdog.watchdogIssueId) {
      await issuesSvc.addComment(watchdog.watchdogIssueId, `Restoration failed after ${watchdog.restorationAttemptCount} bounded attempts. Escalated to ${owner}. Automatic retries stopped.\n\n${history.map((attempt) => `Attempt ${attempt.attemptNumber}: ${attempt.evidence ?? "No restoration evidence recorded"}; actions: ${attempt.actionIds.join(", ") || "none"}; verification: ${attempt.verificationOutcome ?? "stopped"}`).join("\n")}`, {}, { authorType: "system" }, db);
      await db.update(issues).set({ status: "in_review", assigneeAgentId: null, assigneeUserId: owner === "board" ? null : owner, updatedAt: new Date() }).where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.watchdogIssueId)));
    }
    await recordActivity(watchdog, { companyId: watchdog.companyId, actorType: "system", actorId: "system", action: "issue.task_watchdog_escalated", entityType: "issue", entityId: watchdog.issueId,
      details: { watchdogId: watchdog.id, watchdogIssueId: watchdog.watchdogIssueId, sourceIssueId: watchdog.issueId, owner, attemptCount: watchdog.restorationAttemptCount, sourceFingerprint: watchdog.restorationSourceFingerprint, history: history.map((attempt) => ({ attemptNumber: attempt.attemptNumber, runId: attempt.watchdogRunId, actionIds: attempt.actionIds, evidence: attempt.evidence, verificationOutcome: attempt.verificationOutcome })) },
    });
  }

  async function loadWatchdogSubtreeIssues(companyId: string, watchedIssueId: string) {
    const rows = await db.execute(sql`
      WITH RECURSIVE watched_issues AS (
        SELECT
          id,
          company_id,
          identifier,
          title,
          status,
          parent_id,
          assignee_agent_id,
          assignee_user_id,
          origin_kind,
          updated_at,
          created_at,
          0 AS depth
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${watchedIssueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT
          child.id,
          child.company_id,
          child.identifier,
          child.title,
          child.status,
          child.parent_id,
          child.assignee_agent_id,
          child.assignee_user_id,
          child.origin_kind,
          child.updated_at,
          child.created_at,
          watched_issues.depth + 1
        FROM issues child
        JOIN watched_issues ON child.parent_id = watched_issues.id
        WHERE child.company_id = ${companyId}
          AND child.hidden_at IS NULL
          AND child.harness_kind IS NULL
          AND child.origin_kind <> ${TASK_WATCHDOG_ORIGIN_KIND}
          AND watched_issues.depth < ${TASK_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT
        id,
        company_id AS "companyId",
        identifier,
        title,
        status,
        parent_id AS "parentId",
        assignee_agent_id AS "assigneeAgentId",
        assignee_user_id AS "assigneeUserId",
        origin_kind AS "originKind",
        updated_at AS "updatedAt",
        created_at AS "createdAt"
      FROM watched_issues
    `);

    return (Array.isArray(rows) ? rows : []) as TaskWatchdogClassifierIssue[];
  }

  async function collectClassifierInput(companyId: string, watchdog: IssueWatchdogRow) {
    const issueRows = await loadWatchdogSubtreeIssues(companyId, watchdog.issueId);
    const subtreeIssueIds = issueRows.map((issue) => issue.id);
    if (subtreeIssueIds.length === 0) {
      return {
        watchdog: summarizeIssueWatchdog(watchdog),
        issues: [],
        activeRuns: [],
        queuedWakeRequests: [],
        blockers: [],
        pendingInteractions: [],
        pendingApprovals: [],
        evaluatedAt: new Date(),
        firstRunGraceMs: TASK_WATCHDOG_FIRST_RUN_GRACE_MS,
        completedRunIssueIds: [],
      } satisfies TaskWatchdogClassifierInput;
    }

    const [
      activeRunRows,
      activeIssueRunRows,
      wakeRows,
      blockerRows,
      interactionRows,
      approvalRows,
      commentActivityRows,
      documentActivityRows,
      workProductActivityRows,
    ] = await Promise.all([
      db
        .select({
          companyId: heartbeatRuns.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          contextSnapshot: heartbeatRuns.contextSnapshot,
          nativeIssueId: heartbeatRuns.nativeIssueId,
          capacityGroup: heartbeatRuns.capacityGroup,
          capacityReleasedAt: heartbeatRuns.capacityReleasedAt,
          runtimeMode: heartbeatRuns.runtimeMode, nativePhase: heartbeatRuns.nativePhase, errorCode: heartbeatRuns.errorCode,
        })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          watchdogRunObservationCondition(),
          or(
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, subtreeIssueIds),
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, subtreeIssueIds),
            inArray(heartbeatRuns.nativeIssueId, subtreeIssueIds),
          ),
        )),
      db
        .select({
          companyId: issues.companyId,
          agentId: heartbeatRuns.agentId,
          status: heartbeatRuns.status,
          issueId: issues.id,
          capacityGroup: heartbeatRuns.capacityGroup,
          capacityReleasedAt: heartbeatRuns.capacityReleasedAt,
          runtimeMode: heartbeatRuns.runtimeMode, nativePhase: heartbeatRuns.nativePhase, errorCode: heartbeatRuns.errorCode,
        })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          eq(heartbeatRuns.companyId, companyId),
          inArray(issues.id, subtreeIssueIds),
          visibleIssueCondition(),
          watchdogRunObservationCondition(),
        )),
      db
        .select({
          companyId: agentWakeupRequests.companyId,
          agentId: agentWakeupRequests.agentId,
          status: agentWakeupRequests.status,
          payload: agentWakeupRequests.payload,
        })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          or(
            inArray(sql`${agentWakeupRequests.payload}->>'issueId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->>'taskId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId'`, subtreeIssueIds),
            inArray(sql`${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId'`, subtreeIssueIds),
          ),
        )),
      db
        .select({
          companyId: issueRelations.companyId,
          blockerIssueId: issueRelations.issueId,
          blockedIssueId: issueRelations.relatedIssueId,
        })
        .from(issueRelations)
        .where(and(
          eq(issueRelations.companyId, companyId),
          eq(issueRelations.type, "blocks"),
          inArray(issueRelations.relatedIssueId, subtreeIssueIds),
        )),
      db
        .select({
          companyId: issueThreadInteractions.companyId,
          issueId: issueThreadInteractions.issueId,
          id: issueThreadInteractions.id,
          kind: issueThreadInteractions.kind,
          status: issueThreadInteractions.status,
        })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          inArray(issueThreadInteractions.issueId, subtreeIssueIds),
          eq(issueThreadInteractions.status, "pending"),
        )),
      db
        .select({
          companyId: issueApprovals.companyId,
          issueId: issueApprovals.issueId,
          id: approvals.id,
          status: approvals.status,
        })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          inArray(issueApprovals.issueId, subtreeIssueIds),
          inArray(approvals.status, ["pending", "revision_requested"]),
        )),
      db
        .select({
          issueId: issueComments.issueId,
          latestAt: sql<Date | null>`MAX(${issueComments.updatedAt})`,
        })
        .from(issueComments)
        .where(and(
          eq(issueComments.companyId, companyId),
          inArray(issueComments.issueId, subtreeIssueIds),
          isNull(issueComments.deletedAt),
        ))
        .groupBy(issueComments.issueId),
      db
        .select({
          issueId: issueDocuments.issueId,
          latestAt: sql<Date | null>`MAX(${issueDocuments.updatedAt})`,
        })
        .from(issueDocuments)
        .where(and(
          eq(issueDocuments.companyId, companyId),
          inArray(issueDocuments.issueId, subtreeIssueIds),
        ))
        .groupBy(issueDocuments.issueId),
      db
        .select({
          issueId: issueWorkProducts.issueId,
          latestAt: sql<Date | null>`MAX(${issueWorkProducts.updatedAt})`,
        })
        .from(issueWorkProducts)
        .where(and(
          eq(issueWorkProducts.companyId, companyId),
          inArray(issueWorkProducts.issueId, subtreeIssueIds),
        ))
        .groupBy(issueWorkProducts.issueId),
    ]);
    const latestCommentByIssueId = new Map(commentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestDocumentByIssueId = new Map(documentActivityRows.map((row) => [row.issueId, row.latestAt]));
    const latestWorkProductByIssueId = new Map(workProductActivityRows.map((row) => [row.issueId, row.latestAt]));

    const durableIssueRows = await db.select().from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, subtreeIssueIds)));
    const durableById = new Map(durableIssueRows.map((issue) => [issue.id, issue]));
    const tree = issueTreeControlService(db);
    const pauseHoldById = new Map(await Promise.all(subtreeIssueIds.map(async (id) => [id, (await tree.getActivePauseHoldGate(companyId, id))?.holdId ?? null] as const)));
    const evaluatedAt = new Date();
    const evaluatedAtMs = evaluatedAt.getTime();
    // Only the issues created within the first-run grace window can be racing
    // their own assignment run; scope the (potentially expensive) terminal-run
    // lookup to those few issues so the common path stays a no-op.
    const freshIssueIds = issueRows
      .filter((row) => {
        if (isTerminalIssueStatus(row.status)) return false;
        const createdAtMs = toEpochMs(row.createdAt);
        return createdAtMs != null && evaluatedAtMs - createdAtMs < TASK_WATCHDOG_FIRST_RUN_GRACE_MS;
      })
      .map((row) => row.id);
    const completedRunIssueIds = await collectCompletedRunIssueIds(companyId, freshIssueIds);

    return {
      watchdog: {
        ...summarizeIssueWatchdog(watchdog),
        lastReviewedStopSnapshot: parseStopSnapshot(watchdog.lastReviewedStopSnapshot),
        restorationDisposition: watchdog.restorationDisposition,
        configurationRevision: createHash("sha256").update(canonicalJson({ version: watchdog.configurationVersion, agentId: watchdog.watchdogAgentId, instructions: watchdog.instructions, maxAttempts: watchdog.restorationMaxAttempts })).digest("hex"),
      },
      issues: issueRows.map((issue) => ({
        ...issue,
        executionPolicy: durableById.get(issue.id)?.executionPolicy,
        executionState: durableById.get(issue.id)?.executionState,
        monitorNextCheckAt: durableById.get(issue.id)?.monitorNextCheckAt,
        monitorAttemptCount: durableById.get(issue.id)?.monitorAttemptCount ?? 0,
        unblockDescriptor: durableById.get(issue.id)?.unblockDescriptor,
        pauseHoldId: pauseHoldById.get(issue.id),
        latestCommentAt: latestCommentByIssueId.get(issue.id) ?? null,
        latestDocumentAt: latestDocumentByIssueId.get(issue.id) ?? null,
        latestWorkProductAt: latestWorkProductByIssueId.get(issue.id) ?? null,
      })),
      activeRuns: activeRunRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromRunContext(row.contextSnapshot) ?? row.nativeIssueId,
        retainedOwnership: watchdogRunRetainsOwnership(row),
      })).concat(activeIssueRunRows.map((row) => ({ ...row, retainedOwnership: watchdogRunRetainsOwnership(row) }))),
      queuedWakeRequests: wakeRows.map((row) => ({
        companyId: row.companyId,
        agentId: row.agentId,
        status: row.status,
        issueId: issueIdFromWakePayload(row.payload),
      })),
      blockers: blockerRows,
      pendingInteractions: interactionRows,
      pendingApprovals: approvalRows,
      evaluatedAt,
      firstRunGraceMs: TASK_WATCHDOG_FIRST_RUN_GRACE_MS,
      completedRunIssueIds,
    } satisfies TaskWatchdogClassifierInput;
  }

  // Returns the subset of `issueIds` that already have at least one run in a
  // terminal status. Such issues have demonstrably executed, so a stopped
  // subtree is genuine and must not be masked by the pending-first-run guard.
  async function collectCompletedRunIssueIds(companyId: string, issueIds: string[]) {
    if (issueIds.length === 0) return [];
    const candidates = new Set(issueIds);
    const [contextRuns, executionRuns] = await Promise.all([
      db
        .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_TERMINAL_RUN_STATUSES]),
          or(
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'issueId'`, issueIds),
            inArray(sql`${heartbeatRuns.contextSnapshot}->>'taskId'`, issueIds),
          ),
        )),
      db
        .select({ issueId: issues.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          inArray(issues.id, issueIds),
          inArray(heartbeatRuns.status, [...TASK_WATCHDOG_TERMINAL_RUN_STATUSES]),
        )),
    ]);
    const completed = new Set<string>();
    for (const row of contextRuns) {
      const issueId = issueIdFromRunContext(row.contextSnapshot);
      if (issueId && candidates.has(issueId)) completed.add(issueId);
    }
    for (const row of executionRuns) {
      completed.add(row.issueId);
    }
    return [...completed];
  }

  async function findTaskWatchdogIssue(companyId: string, watchedIssueId: string) {
    return db
      .select()
      .from(issues)
      .where(and(
        eq(issues.companyId, companyId),
        eq(issues.originKind, TASK_WATCHDOG_ORIGIN_KIND),
        eq(issues.originId, watchedIssueId),
        visibleIssueCondition(),
      ))
      .orderBy(asc(issues.createdAt), asc(issues.id))
      .limit(1)
      .then((rows) => rows[0] ?? null);
  }

  async function hasLivePathForIssue(companyId: string, issueId: string) {
    const [run, issueRun, wake] = await Promise.all([
      db
        .select({ id: heartbeatRuns.id })
        .from(heartbeatRuns)
        .where(and(
          eq(heartbeatRuns.companyId, companyId),
          watchdogRunObservationCondition(),
          sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${issueId}
            OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${issueId}
            OR ${heartbeatRuns.nativeIssueId} = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: heartbeatRuns.id })
        .from(issues)
        .innerJoin(heartbeatRuns, eq(issues.executionRunId, heartbeatRuns.id))
        .where(and(
          eq(issues.companyId, companyId),
          eq(heartbeatRuns.companyId, companyId),
          eq(issues.id, issueId),
          watchdogRunObservationCondition(),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: agentWakeupRequests.id })
        .from(agentWakeupRequests)
        .where(and(
          eq(agentWakeupRequests.companyId, companyId),
          inArray(agentWakeupRequests.status, [...TASK_WATCHDOG_WAKE_REQUEST_STATUSES]),
          sql`(${agentWakeupRequests.payload}->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->>'taskId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'issueId' = ${issueId}
            OR ${agentWakeupRequests.payload}->'_paperclipWakeContext'->>'taskId' = ${issueId})`,
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(run || issueRun || wake);
  }

  async function sameFingerprintWatchdogReviewIsStillOpen(
    watchdogIssue: IssueRow | null,
    stopFingerprint: string,
  ) {
    if (!watchdogIssue) return false;
    if (watchdogIssue.originFingerprint !== stopFingerprint) return false;
    if (isTerminalIssueStatus(watchdogIssue.status) || watchdogIssue.status === "backlog") return false;
    if (watchdogIssue.status === "in_review") {
      const hasPendingReviewPath = await watchdogIssueHasPendingReviewPath(watchdogIssue.companyId, watchdogIssue.id);
      return isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath);
    }
    return true;
  }

  async function watchdogIssueNeedsFreshWake(watchdogIssue: IssueRow) {
    if (watchdogIssue.status !== "in_review") return false;
    const hasPendingReviewPath = await watchdogIssueHasPendingReviewPath(watchdogIssue.companyId, watchdogIssue.id);
    return !isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath);
  }

  async function watchdogIssueHasPendingReviewPath(companyId: string, issueId: string) {
    const [interaction, approval] = await Promise.all([
      db
        .select({ id: issueThreadInteractions.id })
        .from(issueThreadInteractions)
        .where(and(
          eq(issueThreadInteractions.companyId, companyId),
          eq(issueThreadInteractions.issueId, issueId),
          eq(issueThreadInteractions.status, "pending"),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
      db
        .select({ id: approvals.id })
        .from(issueApprovals)
        .innerJoin(approvals, eq(issueApprovals.approvalId, approvals.id))
        .where(and(
          eq(issueApprovals.companyId, companyId),
          eq(issueApprovals.issueId, issueId),
          inArray(approvals.status, ["pending", "revision_requested"]),
        ))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);
    return Boolean(interaction || approval);
  }

  async function markTerminalWatchdogIssueReviewed(watchdog: IssueWatchdogRow, opts: { runId?: string | null } = {}) {
    if (!watchdog.watchdogIssueId || !watchdog.lastObservedFingerprint) return watchdog;
    const watchdogIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.watchdogIssueId)))
      .then((rows) => rows[0] ?? null);
    if (!watchdogIssue) return watchdog;
    // Status is a review container, never proof that deliverable work resumed.
    // Infer legacy completions conservatively; explicit dispositions and batch
    // actions already own their durable attempt and must not be overwritten.
    const attempt = await currentAttempt(watchdog);
    if (attempt?.disposition || watchdog.restorationDisposition === "escalated") return watchdog;
    const hasPendingReviewPath = watchdogIssue.status === "in_review"
      ? await watchdogIssueHasPendingReviewPath(watchdog.companyId, watchdogIssue.id)
      : false;
    if (!isWatchdogReviewDisposition(watchdogIssue, hasPendingReviewPath)) return watchdog;
    const reviewedFingerprint = reviewedFingerprintForWatchdogIssue(watchdogIssue);
    if (!reviewedFingerprint) return watchdog;
    if (watchdog.restorationDisposition === "legitimate_stop" && watchdog.lastReviewedFingerprint === reviewedFingerprint) return watchdog;
    const input = await collectClassifierInput(watchdog.companyId, { ...watchdog, lastReviewedFingerprint: null, lastReviewedStopSnapshot: null });
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state === "ownership_held") return watchdog;
    const legitimate = await legitimateStoppedPath(input, classification);
    // A legacy review has no transaction-bound action receipt. A newer stop
    // cannot be attributed to that old review merely because it completed.
    const claimedFingerprint = reviewedFingerprint;
    const [reviewRun] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, watchdog.companyId), eq(heartbeatRuns.agentId, watchdog.watchdogAgentId),
      sql`(${heartbeatRuns.contextSnapshot}->>'issueId' = ${watchdogIssue.id} OR ${heartbeatRuns.contextSnapshot}->>'taskId' = ${watchdogIssue.id})`,
      sql`(${heartbeatRuns.contextSnapshot}->'taskWatchdog'->>'stopFingerprint' = ${reviewedFingerprint} OR ${heartbeatRuns.contextSnapshot}->>'stopFingerprint' = ${reviewedFingerprint})`,
      ...(watchdog.lastTriggeredAt ? [gte(heartbeatRuns.createdAt, watchdog.lastTriggeredAt)] : []),
    )).orderBy(desc(heartbeatRuns.createdAt)).limit(1);
    const actions = reviewRun && classification.includedIssueIds.length
      ? await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, watchdog.companyId), eq(activityLog.runId, reviewRun.id), eq(activityLog.entityType, "issue"), inArray(activityLog.entityId, classification.includedIssueIds))) : [];
    return saveDisposition(watchdog, legitimate ? "legitimate_stop" : "restoration_claimed", {
      fingerprint: legitimate && "stopFingerprint" in classification ? classification.stopFingerprint : reviewedFingerprint, claimedFingerprint, runId: reviewRun?.id ?? null, actionIds: actions.map((action) => action.id),
      evidence: legitimate ? "Legacy review disposition verified a durable terminal or waiting path." : "Legacy watchdog completion claimed restoration; source execution must still be verified.",
      snapshot: "stopSnapshot" in classification ? classification.stopSnapshot : null,
    });
  }

  async function ensureReusableWatchdogIssue(input: {
    watchdog: IssueWatchdogRow;
    sourceIssue: IssueRow;
    classification: Extract<TaskWatchdogClassifierResult, { state: "stopped" }>;
    runId?: string | null;
  }) {
    const existing = input.watchdog.watchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, input.watchdog.companyId),
          eq(issues.id, input.watchdog.watchdogIssueId),
          visibleIssueCondition(),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    const fallback = existing ?? await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);

    if (fallback) {
      const shouldReopen = isTerminalIssueStatus(fallback.status) ||
        fallback.status === "backlog" ||
        await watchdogIssueNeedsFreshWake(fallback);
      const watchdogIssue = shouldReopen
        ? await issuesSvc.update(fallback.id, {
          status: "todo",
          assigneeAgentId: input.watchdog.watchdogAgentId,
          parentId: input.sourceIssue.id,
          projectId: input.sourceIssue.projectId,
          goalId: input.sourceIssue.goalId,
          billingCode: input.sourceIssue.billingCode,
          originFingerprint: input.classification.stopFingerprint,
        }) ?? fallback
        : fallback;
      if (!shouldReopen && watchdogIssue.originFingerprint !== input.classification.stopFingerprint) {
        await db
          .update(issues)
          .set({ originFingerprint: input.classification.stopFingerprint, updatedAt: new Date() })
          .where(and(eq(issues.companyId, input.watchdog.companyId), eq(issues.id, watchdogIssue.id)));
        watchdogIssue.originFingerprint = input.classification.stopFingerprint;
      }
      await issuesSvc.addComment(
        watchdogIssue.id,
        buildStoppedFingerprintComment({
          sourceIssue: input.sourceIssue,
          stopFingerprint: input.classification.stopFingerprint,
          stoppedLeaves: input.classification.stoppedLeaves,
          pendingInteractionsByIssueId: input.classification.pendingInteractionsByIssueId,
          resumed: true,
        }),
        { runId: input.runId ?? null },
        {
          authorType: "system",
          metadata: stoppedFingerprintMetadata({
            sourceIssueId: input.sourceIssue.id,
            stopFingerprint: input.classification.stopFingerprint,
            waitsByIssueId: input.classification.stopSnapshot.waitsByIssueId,
            resumed: true,
          }),
        },
      );
      return watchdogIssue;
    }

    const created = await issuesSvc.create(input.sourceIssue.companyId, {
        title: `Watchdog review for ${input.sourceIssue.identifier ?? input.sourceIssue.title}`,
        description: [
          "Task watchdog review issue.",
          "",
          `Watched issue: ${input.sourceIssue.identifier ?? input.sourceIssue.id}`,
          `Stopped fingerprint: ${input.classification.stopFingerprint}`,
          "",
          "The watchdog agent should verify the stopped subtree and either confirm the disposition or restore a valid live path.",
        ].join("\n"),
        status: "todo",
        priority: input.sourceIssue.priority,
        parentId: input.sourceIssue.id,
        projectId: input.sourceIssue.projectId,
        goalId: input.sourceIssue.goalId,
        assigneeAgentId: input.watchdog.watchdogAgentId,
        originKind: TASK_WATCHDOG_ORIGIN_KIND,
        originId: input.sourceIssue.id,
        originFingerprint: input.classification.stopFingerprint,
        billingCode: input.sourceIssue.billingCode,
        inheritExecutionWorkspaceFromIssueId: input.sourceIssue.id,
      })
      .catch(async (error: unknown) => {
        if (!isActiveTaskWatchdogUniqueConflict(error)) throw error;
        const winner = await findTaskWatchdogIssue(input.watchdog.companyId, input.sourceIssue.id);
        if (!winner) throw error;
        return winner;
      });
    await issuesSvc.addComment(
      created.id,
      buildStoppedFingerprintComment({
        sourceIssue: input.sourceIssue,
        stopFingerprint: input.classification.stopFingerprint,
        stoppedLeaves: input.classification.stoppedLeaves,
        pendingInteractionsByIssueId: input.classification.pendingInteractionsByIssueId,
        resumed: false,
      }),
      { runId: input.runId ?? null },
      {
        authorType: "system",
        metadata: stoppedFingerprintMetadata({
          sourceIssueId: input.sourceIssue.id,
          stopFingerprint: input.classification.stopFingerprint,
          waitsByIssueId: input.classification.stopSnapshot.waitsByIssueId,
          resumed: false,
        }),
      },
    );
    return created;
  }

  async function evaluateWatchdog(row: IssueWatchdogRow, opts: { runId?: string | null } = {}): Promise<TaskWatchdogEvaluation> {
    if (!inTransaction) {
      const result = await db.transaction(async (tx) => {
        const [locked] = await tx.select().from(issueWatchdogs).where(and(eq(issueWatchdogs.id, row.id), eq(issueWatchdogs.companyId, row.companyId), eq(issueWatchdogs.status, "active"))).for("update");
        return locked ? taskWatchdogService(tx as unknown as Db, deps, true).evaluateWatchdog(locked, opts) : { state: "skipped" as const, reason: "watchdog_disabled" };
      });
      await drainRecoveryOutbox(row.companyId);
      return result;
    }
    const watchdog = await markTerminalWatchdogIssueReviewed(row, opts);
    const sourceIssue = await db
      .select()
      .from(issues)
      .where(and(eq(issues.companyId, watchdog.companyId), eq(issues.id, watchdog.issueId), visibleIssueCondition()))
      .then((rows) => rows[0] ?? null);
    if (!sourceIssue || sourceIssue.originKind === TASK_WATCHDOG_ORIGIN_KIND) {
      return { state: "skipped" as const, reason: "watched_issue_not_applicable" };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state === "ownership_held") return { state: "ownership_held", reason: classification.reason, classification };
    const attempt = await currentAttempt(watchdog);
    if (watchdog.restorationDisposition === "restoration_claimed") {
      const legitimate = await legitimateStoppedPath(input, classification);
      if (classification.state === "live" || legitimate) {
        if (attempt) await db.update(issueWatchdogAttempts).set({ verificationOutcome: classification.state === "live" ? "live" : "waiting", verifiedAt: new Date() }).where(eq(issueWatchdogAttempts.id, attempt.id));
        if (legitimate && "stopFingerprint" in classification) {
          await saveDisposition(watchdog, "legitimate_stop", { fingerprint: classification.stopFingerprint, snapshot: classification.stopSnapshot, evidence: "Restoration verification observed a durable waiting or terminal path." });
        } else {
          await db.update(issueWatchdogs).set({ restorationDisposition: null, verificationDueAt: null, updatedAt: new Date() }).where(eq(issueWatchdogs.id, watchdog.id));
        }
        return { state: "live" as const, reason: "restoration_verified", classification };
      }
      const sameClaim = "stopFingerprint" in classification && (classification.stopFingerprint === watchdog.restorationSourceFingerprint || classification.stopFingerprint === watchdog.restorationClaimedFingerprint);
      if (classification.state === "stopped" && sameClaim && watchdog.watchdogIssueId && await hasLivePathForIssue(watchdog.companyId, watchdog.watchdogIssueId)) {
        return { state: "watchdog_live" as const, watchdogIssueId: watchdog.watchdogIssueId, classification };
      }
      if (sameClaim && watchdog.verificationDueAt && watchdog.verificationDueAt > new Date()) return { state: "verification_pending" as const, reason: "bounded_verification_not_due", classification };
      if (attempt) await db.update(issueWatchdogAttempts).set({ verificationOutcome: "stopped", verifiedAt: new Date() }).where(eq(issueWatchdogAttempts.id, attempt.id));
    }
    if (classification.state !== "stopped") {
      return { state: classification.state, reason: classification.reason, classification };
    }

    const sameLineage = classification.stopFingerprint === watchdog.restorationSourceFingerprint || classification.stopFingerprint === watchdog.restorationClaimedFingerprint;
    if (watchdog.restorationDisposition === "escalated" && sameLineage) return { state: "escalated" as const, reason: "restoration_lineage_exhausted", classification };
    if (sameLineage && watchdog.restorationDisposition === "restoration_claimed" && watchdog.restorationAttemptCount >= watchdog.restorationMaxAttempts) {
      await escalate(watchdog, classification);
      return { state: "escalated" as const, reason: "restoration_lineage_exhausted", classification };
    }

    const existingWatchdogIssueId = watchdog.watchdogIssueId ?? (await findTaskWatchdogIssue(
      watchdog.companyId,
      sourceIssue.id,
    ))?.id ?? null;
    if (existingWatchdogIssueId && await hasLivePathForIssue(watchdog.companyId, existingWatchdogIssueId)) {
      await db
        .update(issueWatchdogs)
        .set({
          watchdogIssueId: existingWatchdogIssueId,
          lastObservedFingerprint: classification.stopFingerprint,
          lastObservedStopSnapshot: classification.stopSnapshot,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, watchdog.id));
      return { state: "watchdog_live" as const, classification, watchdogIssueId: existingWatchdogIssueId };
    }
    const existingWatchdogIssue = existingWatchdogIssueId
      ? await db
        .select()
        .from(issues)
        .where(and(
          eq(issues.companyId, watchdog.companyId),
          eq(issues.id, existingWatchdogIssueId),
          visibleIssueCondition(),
        ))
        .then((rows) => rows[0] ?? null)
      : null;
    if (await sameFingerprintWatchdogReviewIsStillOpen(existingWatchdogIssue, classification.stopFingerprint)) {
      if (
        watchdog.watchdogIssueId !== existingWatchdogIssue!.id ||
        watchdog.lastObservedFingerprint !== classification.stopFingerprint ||
        canonicalJson(parseStopSnapshot(watchdog.lastObservedStopSnapshot)) !== canonicalJson(classification.stopSnapshot)
      ) {
        await db
          .update(issueWatchdogs)
          .set({
            watchdogIssueId: existingWatchdogIssue!.id,
            lastObservedFingerprint: classification.stopFingerprint,
            lastObservedStopSnapshot: classification.stopSnapshot,
            updatedAt: new Date(),
          })
          .where(eq(issueWatchdogs.id, watchdog.id));
      }
      return {
        state: "watchdog_review_open" as const,
        classification,
        watchdogIssueId: existingWatchdogIssue!.id,
      };
    }

    const watchdogIssue = await ensureReusableWatchdogIssue({
      watchdog,
      sourceIssue,
      classification,
      runId: opts.runId ?? null,
    });
    const now = new Date();
    const sourceFingerprint = sameLineage ? watchdog.restorationSourceFingerprint! : classification.stopFingerprint;
    const previousAttempts = await db.select().from(issueWatchdogAttempts).where(and(eq(issueWatchdogAttempts.companyId, watchdog.companyId), eq(issueWatchdogAttempts.watchdogId, watchdog.id), eq(issueWatchdogAttempts.sourceFingerprint, sourceFingerprint))).orderBy(desc(issueWatchdogAttempts.attemptNumber)).limit(1);
    const attemptNumber = (sameLineage ? watchdog.restorationAttemptCount : previousAttempts[0]?.attemptNumber ?? 0) + 1;
    if (attemptNumber > watchdog.restorationMaxAttempts) { await escalate({ ...watchdog, restorationSourceFingerprint: sourceFingerprint, restorationAttemptCount: watchdog.restorationMaxAttempts }, classification); return { state: "escalated" as const, reason: "restoration_lineage_exhausted", classification }; }
    await db.insert(issueWatchdogAttempts).values({ companyId: watchdog.companyId, watchdogId: watchdog.id, sourceFingerprint, observedFingerprint: classification.stopFingerprint, attemptNumber });
    await db
      .update(issueWatchdogs)
      .set({
        watchdogIssueId: watchdogIssue.id,
        lastObservedFingerprint: classification.stopFingerprint,
        lastObservedStopSnapshot: classification.stopSnapshot,
        lastTriggeredAt: now,
        triggerCount: sql`${issueWatchdogs.triggerCount} + 1`,
        restorationSourceFingerprint: sourceFingerprint,
        restorationClaimedFingerprint: classification.stopFingerprint,
        restorationAttemptCount: attemptNumber,
        restorationDisposition: null,
        verificationDueAt: null,
        restorationActionIds: [],
        restorationRunId: null,
        updatedAt: now,
      })
      .where(eq(issueWatchdogs.id, watchdog.id));

    await recordActivity(watchdog, {
      companyId: sourceIssue.companyId,
      actorType: "system",
      actorId: "system",
      agentId: watchdog.watchdogAgentId,
      runId: opts.runId ?? null,
      action: "issue.task_watchdog_triggered",
      entityType: "issue",
      entityId: sourceIssue.id,
      details: {
        source: "task_watchdogs.evaluate",
        watchdogId: watchdog.id,
        watchdogIssueId: watchdogIssue.id,
        stopFingerprint: classification.stopFingerprint,
        stopSnapshot: classification.stopSnapshot,
        stoppedLeaves: classification.stoppedLeaves,
      },
    });

    const context = watchdogWakeContext({
      watchdog,
      watchdogIssue,
      sourceIssue,
      classification,
    });
    context.taskWatchdog.restorationLineage = { version: 1, sourceFingerprint, attemptCount: attemptNumber, maxAttempts: watchdog.restorationMaxAttempts };
    await persistOutbox(watchdog, watchdogIssue.id, "watchdog", `${taskWatchdogWakeIdempotencyKey(watchdog.id, sourceFingerprint)}:attempt:${attemptNumber}`, { agentId: watchdog.watchdogAgentId, context });

    return {
      state: "triggered" as const,
      classification,
      watchdogIssueId: watchdogIssue.id,
      wakeupRunId: null,
    };
  }

  async function listActiveWatchdogsForCompany(companyId?: string | null) {
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.status, "active"),
        ...(companyId ? [eq(issueWatchdogs.companyId, companyId)] : []),
      ));
  }

  async function activeWatchdogsForIssueAndAncestors(companyId: string, issueId: string) {
    const ancestorRows = await db.execute(sql`
      WITH RECURSIVE ancestors(id, parent_id, depth) AS (
        SELECT id, parent_id, 0
        FROM issues
        WHERE company_id = ${companyId}
          AND id = ${issueId}
          AND hidden_at IS NULL
          AND harness_kind IS NULL
        UNION ALL
        SELECT parent.id, parent.parent_id, ancestors.depth + 1
        FROM issues parent
        JOIN ancestors ON parent.id = ancestors.parent_id
        WHERE parent.company_id = ${companyId}
          AND parent.hidden_at IS NULL
          AND parent.harness_kind IS NULL
          AND ancestors.depth < ${TASK_WATCHDOG_SUBTREE_MAX_DEPTH - 1}
      )
      SELECT id FROM ancestors
    `);
    const ancestorIds = (Array.isArray(ancestorRows) ? ancestorRows : [])
      .map((row) => typeof row === "object" && row !== null ? (row as Record<string, unknown>).id : null)
      .filter((id): id is string => typeof id === "string");
    if (ancestorIds.length === 0) return [];
    return db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.companyId, companyId),
        eq(issueWatchdogs.status, "active"),
        inArray(issueWatchdogs.issueId, ancestorIds),
      ));
  }

  async function revalidateMutationScope(scope: {
    kind: "watchdog";
    watchdogId: string;
    companyId: string;
    watchedIssueId: string;
    stopFingerprint: string | null;
  }) {
    if (!scope.stopFingerprint) {
      return {
        allowed: false as const,
        reason: "Task-watchdog run context is missing the stopped fingerprint required for mutation revalidation.",
      };
    }

    const watchdog = await db
      .select()
      .from(issueWatchdogs)
      .where(and(
        eq(issueWatchdogs.id, scope.watchdogId),
        eq(issueWatchdogs.companyId, scope.companyId),
        eq(issueWatchdogs.issueId, scope.watchedIssueId),
        eq(issueWatchdogs.status, "active"),
      ))
      .then((rows) => rows[0] ?? null);
    if (!watchdog) {
      return {
        allowed: false as const,
        reason: "Task-watchdog run context is not backed by an active persisted watchdog.",
      };
    }

    const input = await collectClassifierInput(watchdog.companyId, watchdog);
    const classification = classifyTaskWatchdogSubtree(input);
    if (classification.state === "stopped" && classification.stopFingerprint === scope.stopFingerprint) {
      return { allowed: true as const, classification };
    }

    return {
      allowed: false as const,
      reason: classification.state === "stopped"
        ? "Task-watchdog review is stale because the watched subtree stop fingerprint changed; refresh the source state before mutating it."
        : "Task-watchdog review is stale because the watched subtree now has a live, waiting, already-reviewed, or not-applicable path; refresh the source state before mutating it.",
      classification,
    };
  }

  type RecoveryActor = Parameters<typeof resolveTaskWatchdogMutationScope>[1];
  type RecoveryAuthorization = (input: { db: Db; issue: IssueRow; mutation: RecoveryMutation }) => Promise<void>;
  const batchReceipt = (row: typeof issueWatchdogRecoveryBatches.$inferSelect): RecoveryBatchReceipt => ({ id: row.id, requestId: row.requestId, watchdogRunId: row.watchdogRunId, status: row.status as "applied" | "stale", actionIds: row.actionIds, reason: row.reason });

  async function applyRecoveryBatch(watchedIssueId: string, actor: RecoveryActor, raw: RecoveryBatch, authorize?: RecoveryAuthorization) {
    const batch = recoveryBatchSchema.parse(raw);
    if (actor.type !== "agent" || actor.runId !== batch.watchdogRunId) throw forbidden("Recovery batches require their authenticated watchdog run");
    const digest = createHash("sha256").update(canonicalJson(batch)).digest("hex");
    const result = await db.transaction(async (tx) => {
      // A heartbeat can refer to an issue only in JSON. Issue row locks alone
      // cannot fence that insertion. Hold a short shared table lock on liveness
      // and gate inputs until the three-or-fewer effects commit. No model/tool
      // invocation or publication runs while these locks are held.
      await tx.execute(sql`SET LOCAL lock_timeout = '2s'`);
      await tx.execute(sql`SET LOCAL statement_timeout = '5s'`);
      const guard = await tx.execute(sql`SELECT pg_try_advisory_xact_lock(hashtext('paperclip.task_watchdog_recovery_batch')) AS acquired`);
      if (!(guard as unknown as Array<{ acquired: boolean }>)[0]?.acquired) throw conflict("Another recovery batch is committing; retry after refreshing source state");
      await tx.execute(sql`LOCK TABLE heartbeat_runs, agent_wakeup_requests, issue_relations, issue_thread_interactions, issue_approvals, approvals, issue_tree_holds, issue_recovery_actions IN SHARE MODE NOWAIT`);
      const scope = await resolveTaskWatchdogMutationScope(tx as unknown as Db, actor);
      if (scope.kind !== "watchdog" || scope.watchedIssueId !== watchedIssueId || scope.stopFingerprint !== batch.expectedStopFingerprint) throw forbidden("Recovery batch does not match the persisted watchdog capability");
      const [watchdog] = await tx.select().from(issueWatchdogs).where(and(eq(issueWatchdogs.companyId, scope.companyId), eq(issueWatchdogs.id, scope.watchdogId), eq(issueWatchdogs.status, "active"))).for("update", { noWait: true });
      if (!watchdog) throw forbidden("Active watchdog configuration required");
      const [previous] = await tx.select().from(issueWatchdogRecoveryBatches).where(and(eq(issueWatchdogRecoveryBatches.companyId, scope.companyId), eq(issueWatchdogRecoveryBatches.watchdogId, watchdog.id), or(eq(issueWatchdogRecoveryBatches.watchdogRunId, batch.watchdogRunId), eq(issueWatchdogRecoveryBatches.requestId, batch.requestId))));
      if (previous) {
        if (previous.requestId !== batch.requestId || previous.requestDigest !== digest || previous.watchdogRunId !== batch.watchdogRunId) throw conflict("Watchdog recovery batch is single-shot; request ID already used");
        return batchReceipt(previous);
      }
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, batch.watchdogRunId), eq(heartbeatRuns.companyId, scope.companyId), eq(heartbeatRuns.agentId, actor.agentId!))).for("update", { noWait: true });
      if (!run || run.status !== "running") throw conflict("Recovery mutations require a currently running watchdog run");
      await assertWatchdogAgentInvokable(tx, scope.companyId, actor.agentId!);
      const transactional = taskWatchdogService(tx as unknown as Db, {}, true);
      const svc = issueService(tx as unknown as Db);
      const input = await transactional.collectClassifierInput(scope.companyId, watchdog);
      await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, scope.companyId), inArray(issues.id, [...input.issues.map((issue) => issue.id), ...(watchdog.watchdogIssueId ? [watchdog.watchdogIssueId] : [])]))).orderBy(asc(issues.id)).for("update", { noWait: true });
      // Validate every target before either applying or recording a stale
      // request. A stale request never grants visibility to an unrelated row.
      for (const mutation of batch.mutations) {
        const [target] = await tx.select().from(issues).where(and(eq(issues.companyId, scope.companyId), eq(issues.id, mutation.issueId), visibleIssueCondition()));
        if (!target || (await taskWatchdogScopeAllowsIssueMutation(tx as unknown as Db, scope, target, { allowWatchdogIssue: false })).kind !== "watchdog") throw forbidden("Recovery mutation target is outside the watched subtree");
        if (mutation.kind === "set_blockers" && mutation.blockerIssueIds.length) {
          const uniqueIds = [...new Set(mutation.blockerIssueIds)];
          const blockers = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, scope.companyId), inArray(issues.id, uniqueIds), visibleIssueCondition()));
          if (blockers.length !== uniqueIds.length) throw forbidden("Recovery blockers must belong to the watched company");
        }
        await authorize?.({ db: tx as unknown as Db, issue: target, mutation });
      }
      // Reload after issue locks: any prior durable issue writer must finish
      // first. Check source freshness exactly once for the entire batch.
      const validation = await transactional.revalidateMutationScope(scope);
      if (!validation.allowed) {
        const [stale] = await tx.insert(issueWatchdogRecoveryBatches).values({ companyId: scope.companyId, watchdogId: watchdog.id, watchdogRunId: run.id, requestId: batch.requestId, requestDigest: digest, observedFingerprint: batch.expectedStopFingerprint, status: "stale", reason: validation.reason }).returning();
        if (watchdog.watchdogIssueId) await svc.addComment(watchdog.watchdogIssueId, `Recovery batch ${batch.requestId} rejected as stale. ${validation.reason}`, { agentId: actor.agentId!, runId: run.id }, undefined, tx);
        await transactional.recordActivity(watchdog, { companyId: scope.companyId, actorType: "agent", actorId: actor.agentId!, agentId: actor.agentId, runId: run.id, action: "issue.task_watchdog_recovery_batch_stale", entityType: "issue", entityId: watchdog.issueId, details: { watchdogId: watchdog.id, sourceIssueId: watchdog.issueId, watchdogIssueId: watchdog.watchdogIssueId, stopFingerprint: batch.expectedStopFingerprint, requestId: batch.requestId, reason: validation.reason } });
        return batchReceipt(stale!);
      }
      const actionIds: string[] = [];
      const publications: ActivityPublication[] = [];
      for (const mutation of batch.mutations) {
        const [target] = await tx.select().from(issues).where(and(eq(issues.companyId, scope.companyId), eq(issues.id, mutation.issueId)));
        if (!target) throw notFound("Recovery target disappeared");
        const influence = await observeCrossIssueInfluence(tx as unknown as Db, { companyId: scope.companyId, runId: run.id, agentId: actor.agentId!, targetIssueId: target.id, kind: mutation.kind === "comment" ? "comment" : "update" });
        if (influence && !influence.allowed) throw forbidden(crossIssueInfluenceLimitError(influence).error);
        let effectId: string = target.id;
        if (mutation.kind === "comment") {
          const comment = await svc.addComment(target.id, mutation.body, { agentId: actor.agentId!, runId: run.id }, { authorizationReason: "task_watchdog_recovery_batch" }, tx);
          effectId = comment.id;
        } else {
          if (await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(scope.companyId, target.id)) throw conflict("Recovery cannot release an explicit human pause");
          const state = parseIssueExecutionState(target.executionState);
          const policy = normalizeIssueExecutionPolicy(target.executionPolicy);
          if (state?.status === "pending") throw forbidden("Recovery cannot bypass a pending execution-policy participant");
          if (target.assigneeUserId) throw forbidden("Recovery cannot automatically change human-owned waiting work");
          let update: Parameters<typeof svc.update>[1];
          if (mutation.kind === "set_status") {
            if (isTerminalIssueStatus(target.status)) throw conflict("Closed issues require the existing explicit restore flow with resume evidence");
            const pendingWaits = validation.classification.stopSnapshot.waitsByIssueId[target.id];
            if (pendingWaits?.pendingApprovalIds.length && mutation.status !== target.status) throw forbidden("Recovery cannot bypass a pending formal approval");
            if (target.status === "blocked" && mutation.status !== "blocked") {
              const readiness = await svc.getDependencyReadiness(target.id);
              if (readiness.unresolvedBlockerCount || pendingWaits || target.unblockDescriptor) throw conflict("Recovery cannot clear an unresolved blocker or human waiting path");
            }
            const transition = applyIssueExecutionPolicyTransition({ issue: target, policy, previousPolicy: policy, requestedStatus: mutation.status, requestedAssigneePatch: {}, actor: { agentId: actor.agentId!, userId: null }, allowBoardOverride: false });
            if (transition.decision) throw forbidden("Recovery cannot resolve an execution-policy decision");
            if (mutation.status === "blocked" && target.status !== "blocked" && !(await svc.getDependencyReadiness(target.id)).unresolvedBlockerCount && !pendingWaits && !target.unblockDescriptor) throw unprocessable("Entering blocked requires unresolved blockers, a pending interaction/approval, or unblockDescriptor");
            if (mutation.status === "in_review" && target.status !== "in_review" && !pendingWaits && !transition.patch.executionState && !target.monitorNextCheckAt) throw unprocessable("Entering review requires a real reviewer, approval, interaction, or bounded monitor");
            update = { status: mutation.status, ...transition.patch, actorAgentId: actor.agentId, companyGuard: scope.companyId };
          } else {
            const oldBlockers = (await svc.getRelationSummaries(target.id)).blockedBy.map((blocker) => blocker.id);
            const removed = oldBlockers.filter((id) => !mutation.blockerIssueIds.includes(id));
            if (removed.length) {
              const [humanBlocker] = await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, scope.companyId), inArray(issues.id, removed), sql`${issues.assigneeUserId} is not null`, sql`${issues.status} <> 'done'`));
              if (humanBlocker) throw forbidden("Recovery cannot remove an unresolved human-owned blocker");
            }
            update = { blockedByIssueIds: [...mutation.blockerIssueIds], actorAgentId: actor.agentId, companyGuard: scope.companyId };
          }
          const updated = await svc.update(target.id, update, tx, publications, []);
          if (!updated) throw notFound("Recovery target disappeared");
          if (updated.assigneeAgentId && ["todo", "in_progress"].includes(updated.status)) await transactional.persistOutbox(watchdog, target.id, "assignment", `task_watchdog_batch:${batch.requestId}:assignment:${target.id}`, { agentId: updated.assigneeAgentId, context: { issueId: target.id, taskId: target.id, source: "task_watchdog_recovery_batch", watchdogId: watchdog.id, resumeIntent: true } });
        }
        const action = await transactional.recordActivity(watchdog, { companyId: scope.companyId, actorType: "agent", actorId: actor.agentId!, agentId: actor.agentId, runId: run.id, action: mutation.kind === "comment" ? "issue.comment_added" : "issue.updated", entityType: "issue", entityId: target.id, details: { source: "task_watchdog_recovery_batch", watchdogId: watchdog.id, sourceIssueId: watchdog.issueId, watchdogIssueId: watchdog.watchdogIssueId, stopFingerprint: batch.expectedStopFingerprint, requestId: batch.requestId, mutationKind: mutation.kind, effectId } });
        actionIds.push(action.id);
      }
      for (const publication of publications) await transactional.persistOutbox(watchdog, watchdog.watchdogIssueId!, "activity", `task_watchdog_batch:${batch.requestId}:activity:${publications.indexOf(publication)}`, { publication });
      const after = classifyTaskWatchdogSubtree(await transactional.collectClassifierInput(scope.companyId, { ...watchdog, restorationDisposition: "restoration_claimed" }));
      await transactional.saveDisposition(watchdog, "restoration_claimed", { fingerprint: batch.expectedStopFingerprint, claimedFingerprint: "stopFingerprint" in after ? after.stopFingerprint : batch.expectedStopFingerprint, runId: run.id, actionIds, evidence: `Atomic recovery batch ${batch.requestId} committed ${batch.mutations.length} authorized mutations.` });
      const [receipt] = await tx.insert(issueWatchdogRecoveryBatches).values({ companyId: scope.companyId, watchdogId: watchdog.id, watchdogRunId: run.id, requestId: batch.requestId, requestDigest: digest, observedFingerprint: batch.expectedStopFingerprint, status: "applied", actionIds }).returning();
      return batchReceipt(receipt!);
    }).catch((error: unknown) => {
      if (["55P03", "40P01", "40001"].includes(postgresFailureCode(error) ?? "")) throw conflict("Recovery batch encountered concurrent task state; refresh the subtree and retry the same request ID", { code: "task_watchdog_batch_concurrent_mutation" });
      throw error;
    });
    await drainRecoveryOutbox(actor.companyId);
    return result;
  }

  async function recordDisposition(watchedIssueId: string, actor: RecoveryActor, raw: WatchdogDispositionInput) {
    const input = watchdogDispositionSchema.parse(raw);
    if (actor.type !== "agent" || actor.runId !== input.watchdogRunId) throw forbidden("Disposition requires its authenticated watchdog run");
    const result = await db.transaction(async (tx) => {
      const scope = await resolveTaskWatchdogMutationScope(tx as unknown as Db, actor);
      if (scope.kind !== "watchdog" || scope.watchedIssueId !== watchedIssueId || scope.stopFingerprint !== input.expectedStopFingerprint) throw forbidden("Disposition does not match the persisted watchdog capability");
      const [watchdog] = await tx.select().from(issueWatchdogs).where(and(eq(issueWatchdogs.companyId, scope.companyId), eq(issueWatchdogs.id, scope.watchdogId))).for("update");
      const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.watchdogRunId), eq(heartbeatRuns.agentId, actor.agentId!))).for("update");
      if (!watchdog || !run || run.status !== "running") throw conflict("Disposition requires an active watchdog run");
      await assertWatchdogAgentInvokable(tx, scope.companyId, actor.agentId!);
      const svc = taskWatchdogService(tx as unknown as Db, {}, true);
      const attempt = await svc.currentAttempt(watchdog);
      const digest = createHash("sha256").update(canonicalJson(input)).digest("hex");
      if (!attempt) throw conflict("Disposition requires its durable watchdog attempt");
      if (attempt.dispositionRequestId) {
        if (attempt.dispositionRequestId !== input.requestId || attempt.dispositionRequestDigest !== digest) throw conflict("Watchdog disposition request already recorded");
        return toIssueWatchdog(watchdog);
      }
      const classificationInput = await svc.collectClassifierInput(scope.companyId, { ...watchdog, lastReviewedFingerprint: null, lastReviewedStopSnapshot: null });
      const classification = classifyTaskWatchdogSubtree(classificationInput);
      if (input.disposition === "legitimate_stop" && !(await svc.legitimateStoppedPath(classificationInput, classification))) throw unprocessable("A legitimate-stop disposition needs a durable terminal or waiting path");
      const actionRows = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, scope.companyId), eq(activityLog.runId, run.id), sql`${activityLog.details}->>'watchdogId' = ${watchdog.id}`));
      const updated = await svc.saveDisposition(watchdog, input.disposition, { fingerprint: "stopFingerprint" in classification ? classification.stopFingerprint : input.expectedStopFingerprint, claimedFingerprint: "stopFingerprint" in classification ? classification.stopFingerprint : input.expectedStopFingerprint, runId: run.id, actionIds: actionRows.map((action) => action.id), evidence: input.evidence, snapshot: "stopSnapshot" in classification ? classification.stopSnapshot : null });
      await tx.update(issueWatchdogAttempts).set({ dispositionRequestId: input.requestId, dispositionRequestDigest: digest }).where(eq(issueWatchdogAttempts.id, attempt.id));
      return toIssueWatchdog(updated);
    });
    await drainRecoveryOutbox(actor.companyId);
    return result;
  }

  return {
    evaluateWatchdog,
    collectClassifierInput,
    recordActivity,
    persistOutbox,
    saveDisposition,
    currentAttempt,
    legitimateStoppedPath,
    applyRecoveryBatch,
    recordDisposition,
    drainRecoveryOutbox,
    getActiveForIssue: async (companyId: string, issueId: string): Promise<IssueWatchdog | null> => {
      const row = await db
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          eq(issueWatchdogs.issueId, issueId),
          eq(issueWatchdogs.status, "active"),
        ))
        .then((rows) => rows[0] ?? null);
      return row ? toIssueWatchdog(row) : null;
    },

    listActiveSummariesForIssues: async (
      companyId: string,
      issueIds: string[],
      dbOrTx: any = db,
    ): Promise<Map<string, IssueWatchdogSummary>> => {
      if (issueIds.length === 0) return new Map();
      const rows = await dbOrTx
        .select()
        .from(issueWatchdogs)
        .where(and(
          eq(issueWatchdogs.companyId, companyId),
          inArray(issueWatchdogs.issueId, [...new Set(issueIds)]),
          eq(issueWatchdogs.status, "active"),
        ));
      return new Map(rows.map((row: IssueWatchdogRow) => [row.issueId, summarizeIssueWatchdog(row)]));
    },

    upsertForIssue: async (
      companyId: string,
      issueId: string,
      input: IssueWatchdogUpsertInput,
    ): Promise<{ watchdog: IssueWatchdog; created: boolean }> => {
      return upsertIssueWatchdogForIssue(db, companyId, issueId, input);
    },

    disableForIssue: async (
      companyId: string,
      issueId: string,
      actor: ActorFields = {},
    ): Promise<IssueWatchdog | null> => {
      await assertWatchedIssue(db, companyId, issueId);
      const existing = await db
        .select()
        .from(issueWatchdogs)
        .where(and(eq(issueWatchdogs.companyId, companyId), eq(issueWatchdogs.issueId, issueId)))
        .then((rows) => rows[0] ?? null);
      if (!existing || existing.status === "disabled") return null;
      const [updated] = await db
        .update(issueWatchdogs)
        .set({
          status: "disabled",
          updatedByAgentId: actor.agentId ?? null,
          updatedByUserId: actor.userId ?? null,
          updatedByRunId: actor.runId ?? null,
          updatedAt: new Date(),
        })
        .where(eq(issueWatchdogs.id, existing.id))
        .returning();
      return toIssueWatchdog(updated);
    },

    reconcileTaskWatchdogs: async (opts: {
      companyId?: string | null;
      runId?: string | null;
      issueCreatedAtGte?: Date | null;
    } = {}) => {
      await drainRecoveryOutbox(opts.companyId);
      let rows = await listActiveWatchdogsForCompany(opts.companyId ?? null);
      if (opts.issueCreatedAtGte) {
        const watchdogIssueIds = [...new Set(rows.map((row) => row.issueId))];
        const eligibleIssueIds = new Set(
          watchdogIssueIds.length === 0
            ? []
            : (await db
                .select({ id: issues.id })
                .from(issues)
                .where(and(
                  inArray(issues.id, watchdogIssueIds),
                  gte(issues.createdAt, opts.issueCreatedAtGte),
                )))
                .map((issue) => issue.id),
        );
        rows = rows.filter((row) => eligibleIssueIds.has(row.issueId));
      }
      const result = {
        checked: 0,
        triggered: 0,
        live: 0,
        pendingFirstRun: 0,
        alreadyReviewed: 0,
        ownershipHeld: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (
          evaluated.state === "live" ||
          evaluated.state === "watchdog_live" ||
          evaluated.state === "watchdog_review_open"
        ) {
          result.live += 1;
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (evaluated.state === "already_reviewed") {
          result.alreadyReviewed += 1;
        } else if (evaluated.state === "ownership_held") {
          result.ownershipHeld += 1;
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    reconcileForIssueAndAncestors: async (
      companyId: string,
      issueId: string,
      opts: { runId?: string | null } = {},
    ) => {
      const rows = await activeWatchdogsForIssueAndAncestors(companyId, issueId);
      const result = {
        checked: 0,
        triggered: 0,
        pendingFirstRun: 0,
        ownershipHeld: 0,
        skipped: 0,
        watchdogIssueIds: [] as string[],
      };
      for (const row of rows) {
        result.checked += 1;
        const evaluated = await evaluateWatchdog(row, { runId: opts.runId ?? null });
        if (evaluated.state === "triggered") {
          result.triggered += 1;
          result.watchdogIssueIds.push(evaluated.watchdogIssueId);
        } else if (evaluated.state === "pending_first_run") {
          result.pendingFirstRun += 1;
        } else if (evaluated.state === "ownership_held") {
          result.ownershipHeld += 1;
        } else if (
          evaluated.state === "watchdog_review_open" ||
          evaluated.state === "watchdog_live" ||
          evaluated.state === "live"
        ) {
          // Existing review work is already open for this stopped state.
        } else {
          result.skipped += 1;
        }
      }
      return result;
    },

    revalidateMutationScope,
  };
}
