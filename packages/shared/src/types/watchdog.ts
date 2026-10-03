export type RestorationDisposition = "legitimate_stop" | "restoration_claimed" | "escalated";

export interface RestorationLineage {
  version: 1;
  sourceFingerprint: string;
  claimedFingerprint: string;
  attemptCount: number;
  maxAttempts: 2 | 3;
  disposition: RestorationDisposition | null;
  verificationDueAt: string | null;
  actionIds: readonly string[];
}

export type RecoveryMutation =
  | { kind: "set_status"; issueId: string; status: "todo" | "in_progress" | "in_review" | "blocked" }
  | { kind: "comment"; issueId: string; body: string }
  | { kind: "set_blockers"; issueId: string; blockerIssueIds: readonly string[] };

export interface RecoveryBatch {
  requestId: string;
  watchdogRunId: string;
  expectedStopFingerprint: string;
  mutations: readonly RecoveryMutation[];
}

export interface RecoveryBatchReceipt {
  id: string;
  requestId: string;
  watchdogRunId: string;
  status: "applied" | "stale";
  actionIds: string[];
  reason: string | null;
}
