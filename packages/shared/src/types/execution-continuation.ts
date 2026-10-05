/** Durable, server-owned wait. A configuration toggle is not resume authority. */
export interface ExecutionRetryDisposition {
  version: 1;
  state: "blocked" | "resumed" | "superseded";
  code: "heartbeat_wake_on_demand_disabled" | "execution_profile_changed";
  sourceRunId: string;
  issueId: string | null;
  agentId: string;
  issueRevision: string | null;
  sourceFingerprint: string;
  /** Null/absent on legacy source runs; exact resume requires a captured v1 profile. */
  executionProfileFingerprint?: string | null;
  workspaceFingerprint: string;
  scopeFingerprint: string;
  requiresExplicitResume: true;
  recoveryActionId: string | null;
  resumedByUserId?: string;
  successorRunId?: string;
  supersessionRequestId?: string;
}

/** A fresh board decision, separately from retrying the original budget/scope. */
export interface RetrySupersessionRequest {
  requestId: string;
  expectedIssueRevision: string;
  expectedAssigneeAgentId: string;
  residualObjective: string;
  maxRunSeconds: number;
}

/** Observed facts only; no engineering stage is certified from a model summary. */
export interface ExecutionCheckpointEnvelope {
  version: 1;
  sourceRunId: string;
  sourceFingerprint: string;
  issueRevision: string;
  agentId: string;
  /** Null/absent on legacy source runs; exact resume requires a captured v1 profile. */
  executionProfileFingerprint?: string | null;
  workspaceFingerprint: string;
  scopeFingerprint: string;
  artifactFingerprint: string;
  stage: "residual";
  stageCertification: "unverified";
  pendingStages: Array<"implementation" | "verification" | "report">;
  nextAction: "inspect_existing_work_then_complete_pending_stages";
  materials: Array<{ kind: "document" | "attachment"; id: string; sha256: string; revision?: number }>;
  completedActionRefs: Array<{ runId: string; receiptId: string; operationId: string }>;
  commandEvidence: Array<{ operationId: string; runId: string; commandSha256: string; exitCode: number; logSha256: string | null; finishedAt: string }>;
  remainingBudget: {
    reset: false;
    additionalWallTime?: { requestId: string; maxRunSeconds: number; certification: "operator_authorized" };
    certification: "observed" | "unverified";
    sourceDeadlineAt: string | null;
    remainingWallTimeMs: number | null;
    policies: Array<{ issueId: string; limits: Record<string, number | null | undefined>; totalTokens: number;
      unknownUsageCount: number; automaticRuns: number; remainingTokens: number | null; remainingAutomaticRuns: number | null }>;
    blockedCode: string | null;
  };
}

/** Server-authored context. Each message retains its author and trust boundary. */
export interface ExecutionContinuationEnvelope {
  version: 1;
  companyId: string;
  issueId: string;
  trigger: {
    reason: string;
    interactionId: string | null;
    sourceRunId: string | null;
  };
  originCommentIds: string[];
  objective: string;
  messages: Array<{
    id: string;
    authorType: string;
    authorId: string | null;
    /** Run-authored Local CLI comments retain user attribution but are not human direction. */
    createdByRunId?: string | null;
    body: string;
    createdAt: string;
    updatedAt: string;
    deleted: boolean;
    sourceTrust: unknown;
  }>;
  interactionOutcomes: Array<{
    id: string;
    kind: string;
    status: string;
    result: unknown;
  }>;
  /** Only valid when resuming the provider session associated with this run. */
  resumeDelta?: {
    baseRunId: string;
    messages: ExecutionContinuationEnvelope["messages"];
  };
  recoveryOutcomes?: Array<{ recoveryActionId: string; decision: unknown }>;
  completedWork: string | null;
  checkpoint?: ExecutionCheckpointEnvelope;
  /** Start a new turn from history; never replay prior tool calls automatically. */
  interruptedRunId?: string;
  /** Completed mutations are context, never instructions to replay them. */
  completedActions?: Array<{
    runId: string;
    receiptId: string;
    operationId: string;
    result: unknown;
  }>;
  unresolvedInteractionIds: string[];
  coverage: {
    kind: "full_task_history" | "task_history_delta";
    baseRunId?: string;
    throughCommentId: string | null;
    summaryThroughCommentId: null;
  };
}
