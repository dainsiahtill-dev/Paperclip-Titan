import { and, asc, eq, inArray, isNotNull } from "drizzle-orm";
import { agents, heartbeatRuns, issues, workspaceOperations, type Db } from "@paperclipai/db";
import type { ExecutionCheckpointEnvelope, ExecutionContinuationEnvelope } from "@paperclipai/shared";
import { readContinuationMaterials } from "./continuation-materials.js";
import { getIssueResourceBlock } from "./issue-resource-limits.js";
import { readVerifiedRetryDisposition, retryScopeFingerprints, retrySourceFingerprint } from "./execution-retry-disposition.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

export async function buildExecutionCheckpoint(db: Db, input: { source: typeof heartbeatRuns.$inferSelect;
  issue: typeof issues.$inferSelect; agentId: string; completedActions: NonNullable<ExecutionContinuationEnvelope["completedActions"]>;
  authorizedScope?: { workspaceFingerprint: string; scopeFingerprint: string; requestId: string; maxRunSeconds: number; executionProfileFingerprint: string } }): Promise<ExecutionCheckpointEnvelope> {
  const { source, issue } = input;
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, issue.companyId), eq(agents.id, input.agentId)));
  if (!agent) throw new Error("continuation_task_ownership_changed");
  const scope = await retryScopeFingerprints(db, issue, agent);
  const disposition = await readVerifiedRetryDisposition(db, source);
  const expectedScope = input.authorizedScope ?? disposition;
  if (expectedScope && (!expectedScope.executionProfileFingerprint || expectedScope.executionProfileFingerprint !== scope.executionProfileFingerprint))
    throw new Error("continuation_execution_profile_changed");
  if (expectedScope && (expectedScope.workspaceFingerprint !== scope.workspaceFingerprint || expectedScope.scopeFingerprint !== scope.scopeFingerprint ||
    (!input.authorizedScope && disposition?.sourceFingerprint !== retrySourceFingerprint(source))))
    throw new Error("continuation_checkpoint_scope_changed");
  const materials = await readContinuationMaterials(db, issue.companyId, issue.id);
  const operations = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.companyId, issue.companyId),
    eq(workspaceOperations.issueId, issue.id), eq(workspaceOperations.heartbeatRunId, source.id),
    inArray(workspaceOperations.status, ["succeeded", "failed"]), isNotNull(workspaceOperations.command),
    isNotNull(workspaceOperations.exitCode), isNotNull(workspaceOperations.finishedAt))).orderBy(asc(workspaceOperations.id));
  const policies: ExecutionCheckpointEnvelope["remainingBudget"]["policies"] = [];
  const block = await getIssueResourceBlock(db, { companyId: issue.companyId, issueId: issue.id, onObservedPolicy: ({ issueId, limits, usage }) => {
    policies.push({ issueId, limits, totalTokens: usage.totalTokens, unknownUsageCount: usage.unknownUsageCount, automaticRuns: usage.automaticRuns,
      remainingTokens: limits.maxTokensPerIssue && !usage.unknownUsageCount ? Math.max(0, limits.maxTokensPerIssue - usage.totalTokens) : null,
      remainingAutomaticRuns: limits.maxAutomaticRuns ? Math.max(0, limits.maxAutomaticRuns - usage.automaticRuns) : null });
  } });
  const deadline = source.contextSnapshot?.resourceDeadline as { deadlineAt?: unknown } | undefined;
  const sourceDeadlineAt = typeof deadline?.deadlineAt === "string" && Number.isFinite(Date.parse(deadline.deadlineAt)) ? deadline.deadlineAt : null;
  return { version: 1, sourceRunId: source.id, sourceFingerprint: retrySourceFingerprint(source), issueRevision: issue.updatedAt.toISOString(),
    agentId: agent.id, ...scope, executionProfileFingerprint: expectedScope?.executionProfileFingerprint ?? undefined, artifactFingerprint: nativeSha256(materials), materials,
    // API effects and command exits preserve completed work. Neither certifies engineering acceptance or stage completion.
    stage: "residual", stageCertification: "unverified", pendingStages: ["implementation", "verification", "report"],
    nextAction: "inspect_existing_work_then_complete_pending_stages",
    completedActionRefs: input.completedActions.map(({ runId, receiptId, operationId }) => ({ runId, receiptId, operationId })),
    commandEvidence: operations.map(row => ({ operationId: row.id, runId: source.id, commandSha256: nativeSha256(row.command),
      exitCode: row.exitCode!, logSha256: row.logSha256, finishedAt: row.finishedAt!.toISOString() })),
    remainingBudget: { reset: false, certification: policies.length && policies.every(policy => policy.unknownUsageCount === 0) ? "observed" : "unverified",
      ...(input.authorizedScope ? { additionalWallTime: { requestId: input.authorizedScope.requestId,
        maxRunSeconds: input.authorizedScope.maxRunSeconds, certification: "operator_authorized" as const } } : {}),
      sourceDeadlineAt, remainingWallTimeMs: sourceDeadlineAt ? Math.max(0, Date.parse(sourceDeadlineAt) - Date.now()) : null,
      policies, blockedCode: block?.code ?? null } };
}
