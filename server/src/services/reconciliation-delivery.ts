import { and, eq } from "drizzle-orm";
import { agents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { currentContinuationOrigins } from "./execution-continuation.js";
import { retryScopeFingerprints } from "./execution-retry-disposition.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { readContinuationMaterials } from "./continuation-materials.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function reconciliationIntentFingerprint(
  db: Db,
  issue: typeof issues.$inferSelect,
  agentId: string,
  decision: Record<string, unknown>,
): Promise<string> {
  return nativeSha256({
    version: 1, sourceRunId: decision.runId, companyId: issue.companyId,
    issueId: issue.id, agentId, actionOutcome: decision.actionOutcome,
    transferToAssigneeAgentId: decision.transferToAssigneeAgentId ?? null,
    title: issue.title, description: issue.description, parentId: issue.parentId,
    goalId: issue.goalId, generation: issue.conversationSessionGeneration,
    materials: await readContinuationMaterials(db, issue.companyId, issue.id, true),
    originCommentIds: await currentContinuationOrigins(db, issue.companyId, issue.id, {}),
  });
}

export async function reconciliationDeliveryFingerprint(
  db: Db,
  issue: typeof issues.$inferSelect,
  agent: typeof agents.$inferSelect,
  decision: Record<string, unknown>,
): Promise<string> {
  return nativeSha256({
    version: 1, sourceRunId: decision.runId, companyId: issue.companyId,
    issueId: issue.id, agentId: agent.id, actionOutcome: decision.actionOutcome,
    transferToAssigneeAgentId: decision.transferToAssigneeAgentId ?? null,
    scope: await retryScopeFingerprints(db, issue, agent, true, { omitExecutionWorkspaceLifecycleStatus: true }),
    originCommentIds: await currentContinuationOrigins(db, issue.companyId, issue.id, {}),
  });
}

export async function assertReconciliationBindingScope(db: Db, input: {
  issue: typeof issues.$inferSelect; runId: string; agentId: string;
}): Promise<void> {
  const [run] = await db.select().from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.issue.companyId), eq(heartbeatRuns.id, input.runId),
    eq(heartbeatRuns.agentId, input.agentId),
  )).for("update");
  const [agent] = await db.select().from(agents).where(and(
    eq(agents.companyId, input.issue.companyId), eq(agents.id, input.agentId),
  )).for("share");
  const context = object(run?.contextSnapshot);
  if (!run || !agent || run.status !== "running" || input.issue.assigneeAgentId !== agent.id ||
      context.issueId !== input.issue.id || context.source !== "execution.reconciled" ||
      await reconciliationDeliveryFingerprint(db, input.issue, agent,
        object(context.reconciliationDeliveryDecision)) !== context.reconciliationDeliveryFingerprint) {
    throw new Error("reconciliation_workspace_scope_changed");
  }
}

/** Update only the captured delivery scope for an exact runtime-owned binding.
 * The task lock and before-view hash reject concurrent owner/config/user edits;
 * this never recaptures a historical source or grants another execution. */
export async function retainReconciliationWorkspaceBinding(db: Db, input: {
  companyId: string; issueId: string; runId: string; agentId: string;
  before: Pick<typeof issues.$inferSelect,
    "executionWorkspaceId" | "projectWorkspaceId" | "executionWorkspacePreference" | "executionWorkspaceSettings">;
  after: Pick<typeof issues.$inferSelect,
    "executionWorkspaceId" | "projectWorkspaceId" | "executionWorkspacePreference" | "executionWorkspaceSettings">;
}): Promise<string | null> {
  return db.transaction(async tx => {
    const [issue] = await tx.select().from(issues).where(and(
      eq(issues.companyId, input.companyId), eq(issues.id, input.issueId),
    )).for("update");
    const [run] = await tx.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
      eq(heartbeatRuns.agentId, input.agentId),
    )).for("update");
    const [agent] = await tx.select().from(agents).where(and(
      eq(agents.companyId, input.companyId), eq(agents.id, input.agentId),
    )).for("share");
    const context = object(run?.contextSnapshot);
    const decision = object(context.reconciliationDeliveryDecision);
    const capture = context.reconciliationDeliveryFingerprint;
    if (!issue || !run || !agent || issue.assigneeAgentId !== agent.id ||
        context.issueId !== issue.id || context.source !== "execution.reconciled" ||
        run.status !== "running" || typeof capture !== "string" || decision.runId !== run.retryOfRunId) return null;
    const currentBinding = {
      executionWorkspaceId: issue.executionWorkspaceId, projectWorkspaceId: issue.projectWorkspaceId,
      executionWorkspacePreference: issue.executionWorkspacePreference,
      executionWorkspaceSettings: issue.executionWorkspaceSettings,
    };
    if (nativeSha256(currentBinding) !== nativeSha256(input.after)) return null;
    const before = { ...issue, ...input.before };
    if (await reconciliationDeliveryFingerprint(tx as unknown as Db, before, agent, decision) !== capture) return null;
    const next = await reconciliationDeliveryFingerprint(tx as unknown as Db, issue, agent, decision);
    // Keep the original admission capture, and add a proved effective scope.
    // An absent proof therefore never becomes authority for another replay.
    await tx.update(heartbeatRuns).set({
      contextSnapshot: { ...context, reconciliationDeliveryFingerprint: next,
        reconciliationWorkspaceBinding: {
          version: 1, before: input.before, after: input.after,
          originalFingerprint: capture, effectiveFingerprint: next,
        } },
    }).where(eq(heartbeatRuns.id, run.id));
    return next;
  });
}
