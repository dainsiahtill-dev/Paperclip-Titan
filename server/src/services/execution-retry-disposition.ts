import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { agents, environmentLeases, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, projectWorkspaces, type Db } from "@paperclipai/db";
import type { ExecutionRetryDisposition } from "@paperclipai/shared";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { conflict } from "../errors.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity } from "./activity-log.js";
import { readContinuationMaterials } from "./continuation-materials.js";

const dispositionSchema = z.object({
  version: z.literal(1), state: z.enum(["blocked", "resumed"]),
  code: z.literal("heartbeat_wake_on_demand_disabled"), sourceRunId: z.string().uuid(),
  issueId: z.string().uuid().nullable(), agentId: z.string().uuid(), issueRevision: z.string().nullable(),
  sourceFingerprint: z.string(), workspaceFingerprint: z.string(), scopeFingerprint: z.string(),
  requiresExplicitResume: z.literal(true), recoveryActionId: z.string().uuid().nullable(),
  resumedByUserId: z.string().optional(), successorRunId: z.string().uuid().optional(),
});
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function readRetryDisposition(result: unknown): ExecutionRetryDisposition | null {
  const parsed = dispositionSchema.safeParse(object(result).retryDisposition);
  return parsed.success ? parsed.data : null;
}
/** A provider-shaped JSON value cannot mint a server suppression or resume decision. */
export async function readVerifiedRetryDisposition(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "resultJson">) {
  const disposition = readRetryDisposition(run.resultJson);
  if (!disposition || disposition.sourceRunId !== run.id || disposition.agentId !== run.agentId) return null;
  const { resumedByUserId: _, successorRunId: __, ...original } = disposition;
  const [receipt] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.agentId, run.agentId),
    eq(heartbeatRunEvents.eventType, "lifecycle"), eq(heartbeatRunEvents.stream, "system"),
    isNull(heartbeatRunEvents.sourceEventId), isNull(heartbeatRunEvents.sourceInstanceId), isNull(heartbeatRunEvents.sourceSeq),
    sql`${heartbeatRunEvents.payload} @> ${JSON.stringify({ retrySuppression: { ...original, state: "blocked" } })}::jsonb`,
  )).limit(1);
  return receipt ? disposition : null;
}
export function retrySourceFingerprint(run: typeof heartbeatRuns.$inferSelect) {
  const { retryDisposition: _, ...result } = object(run.resultJson);
  return nativeSha256({ id: run.id, companyId: run.companyId, agentId: run.agentId, status: run.status,
    error: run.error, errorCode: run.errorCode, context: run.contextSnapshot, result, logSha256: run.logSha256,
    scheduledRetryAttempt: run.scheduledRetryAttempt, usage: run.usageJson });
}
export async function retryScopeFingerprints(db: Db, issue: typeof issues.$inferSelect | null, agent: typeof agents.$inferSelect) {
  const projectRows = issue?.projectId ? await db.select().from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, agent.companyId), eq(projectWorkspaces.projectId, issue.projectId)))
    .orderBy(asc(projectWorkspaces.id)) : [];
  const execution = issue?.executionWorkspaceId ? await db.select().from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, agent.companyId), eq(executionWorkspaces.id, issue.executionWorkspaceId))) : [];
  const workspaceFingerprint = nativeSha256({ projectId: issue?.projectId ?? null,
    projectWorkspaceId: issue?.projectWorkspaceId ?? null, executionWorkspaceId: issue?.executionWorkspaceId ?? null,
    preference: issue?.executionWorkspacePreference ?? null, settings: issue?.executionWorkspaceSettings ?? null,
    projectRows: projectRows.map(({ id, cwd, repoUrl, repoRef, defaultRef, sourceType, remoteProvider, remoteWorkspaceRef, metadata }) =>
      ({ id, cwd, repoUrl, repoRef, defaultRef, sourceType, remoteProvider, remoteWorkspaceRef, metadata })),
    execution: execution.map(({ id, cwd, repoUrl, baseRef, branchName, providerType, providerRef, mode, strategyType, status }) =>
      ({ id, cwd, repoUrl, baseRef, branchName, providerType, providerRef, mode, strategyType, status })),
    adapterType: agent.adapterType, adapterConfig: agent.adapterConfig });
  const scopeFingerprint = nativeSha256({ companyId: agent.companyId, issueId: issue?.id ?? null, agentId: agent.id,
    title: issue?.title ?? null, description: issue?.description ?? null, parentId: issue?.parentId ?? null,
    goalId: issue?.goalId ?? null, executionPolicy: issue?.executionPolicy ?? null,
    overrides: issue?.assigneeAdapterOverrides ?? null, sessionGeneration: issue?.conversationSessionGeneration ?? null,
    materials: issue ? await readContinuationMaterials(db, agent.companyId, issue.id) : [] });
  return { workspaceFingerprint, scopeFingerprint };
}

/** Issue then source locks serialize suppression with ordinary retry admission. */
export async function persistRetrySuppression(db: Db, run: typeof heartbeatRuns.$inferSelect, reason: string) {
  const issueId = run.nativeIssueId ?? (typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null);
  return db.transaction(async tx => {
    const lockedDb = tx as unknown as Db;
    let issue = issueId ? await tx.select().from(issues).where(and(eq(issues.companyId, run.companyId), eq(issues.id, issueId)))
      .for("update").then(rows => rows[0] ?? null) : null;
    const [source] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update");
    if (!source || source.agentId !== run.agentId) throw new Error("retry_suppression_source_changed");
    const prior = await readVerifiedRetryDisposition(lockedDb, source);
    if (prior) return prior;
    const [successor] = await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.retryOfRunId, source.id))).limit(1);
    if (successor || !["failed", "timed_out", "interrupted", "cancelled"].includes(source.status)) return null;
    const [agent] = await tx.select().from(agents).where(and(eq(agents.companyId, run.companyId), eq(agents.id, run.agentId)));
    if (!agent) throw new Error("retry_suppression_agent_missing");
    let recoveryActionId: string | null = null;
    if (issue && issue.assigneeAgentId === source.agentId && !issue.hiddenAt && !["done", "cancelled"].includes(issue.status)
      && (!issue.executionRunId || issue.executionRunId === source.id)) {
      const [active] = await tx.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, source.companyId),
        eq(issueRecoveryActions.sourceIssueId, issue.id), inArray(issueRecoveryActions.status, ["active", "escalated"]))).limit(1);
      // Another incident owns its next action. Retain it verbatim.
      if (!active) {
        const [action] = await tx.insert(issueRecoveryActions).values({ companyId: source.companyId, sourceIssueId: issue.id,
          kind: "stranded_assigned_issue", ownerType: "board", cause: "retry_suppressed", fingerprint: source.id,
          returnOwnerAgentId: source.agentId, evidence: { sourceRunId: source.id, requiresExplicitResume: true },
          nextAction: "Enable on-demand wakes, then explicitly retry this exact source run after reviewing its remaining work.",
          wakePolicy: { automatic: false } }).returning();
        recoveryActionId = action.id;
        [issue] = await tx.update(issues).set({ status: "blocked", statusVersion: sql`${issues.statusVersion} + 1`,
          blockedTransitionAt: new Date(), updatedAt: new Date() }).where(and(eq(issues.companyId, source.companyId), eq(issues.id, issue.id))).returning();
      }
    }
    const disposition: ExecutionRetryDisposition = { version: 1, state: "blocked", code: "heartbeat_wake_on_demand_disabled",
      sourceRunId: source.id, agentId: source.agentId, issueId, issueRevision: issue?.updatedAt.toISOString() ?? null,
      sourceFingerprint: retrySourceFingerprint(source), ...await retryScopeFingerprints(lockedDb, issue, agent),
      requiresExplicitResume: true, recoveryActionId };
    await tx.update(heartbeatRuns).set({ resultJson: { ...object(source.resultJson), retryDisposition: disposition }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, source.id)));
    await appendHeartbeatRunEvent(lockedDb, { companyId: source.companyId, agentId: source.agentId, runId: source.id,
      eventType: "lifecycle", stream: "system", level: "warn", message: reason, payload: { retrySuppression: disposition } });
    await persistActivity(lockedDb, { companyId: source.companyId, actorType: "system", actorId: "heartbeat",
      action: "issue.retry_suppressed", entityType: "heartbeat_run", entityId: source.id, issueId,
      details: { sourceRunId: source.id, recoveryActionId, code: disposition.code } });
    return disposition;
  });
}

/** Called only inside the existing company-scoped issue admission transaction. */
export async function validateSuppressedRetryResume(db: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string;
  actorType?: string | null; actorId?: string | null; reason: string | null;
}) {
  const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId))).for("update");
  const disposition = source ? await readVerifiedRetryDisposition(db, source) : null;
  if (!disposition) return null;
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  if (input.actorType !== "user" || !input.actorId || input.reason !== "retry_failed_run" ||
    !source || source.agentId !== input.agentId || disposition.sourceRunId !== source.id || disposition.issueId !== input.issueId ||
    !issue || issue.hiddenAt || issue.assigneeAgentId !== input.agentId || ["done", "cancelled"].includes(issue.status) || !agent)
    throw conflict("The suppressed retry no longer belongs to this current task and owner.", { code: "retry_resume_scope_changed" });
  if (disposition.state === "resumed") return { source, disposition };
  const scope = await retryScopeFingerprints(db, issue, agent);
  if (disposition.issueRevision !== issue.updatedAt.toISOString() || disposition.sourceFingerprint !== retrySourceFingerprint(source) ||
    disposition.workspaceFingerprint !== scope.workspaceFingerprint || disposition.scopeFingerprint !== scope.scopeFingerprint)
    throw conflict("The source or task scope changed. Review and authorize a new remaining-work decision before resuming.", { code: "retry_resume_scope_changed" });
  if (object(object(agent.runtimeConfig).heartbeat).wakeOnDemand === false)
    throw conflict("Enable on-demand wakes before explicitly retrying this source run.", { code: disposition.code });
  if (adapterExecutionControls.has(source.id) || await getConversationOwnershipBlocker(db, input.companyId, input.issueId))
    throw conflict("The previous physical execution has not stopped.", { code: "retry_resume_owner_active" });
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, source.id)));
  if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed") ||
    (source.startedAt && !source.processPid && !source.processGroupId))
    throw conflict("The previous execution requires verified stop and cleanup evidence.", { code: "retry_resume_stop_unverified" });
  const activeAction = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), inArray(issueRecoveryActions.status, ["active", "escalated"]))).for("update");
  if (activeAction.some(action => action.id !== disposition.recoveryActionId))
    throw conflict("Another recovery incident owns this task's next action.", { code: "retry_resume_other_incident" });
  const deadline = object(source.contextSnapshot?.resourceDeadline).deadlineAt;
  if (typeof deadline === "string" && Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) <= Date.now())
    throw conflict("The original run deadline is exhausted. Pending verification and reporting require a newly authorized budget.", { code: "retry_resume_budget_exhausted" });
  return { source, disposition };
}

export async function consumeSuppressedRetryResume(db: Db, source: typeof heartbeatRuns.$inferSelect,
  disposition: ExecutionRetryDisposition, actorId: string, successorRunId: string) {
  if (disposition.state !== "blocked") throw conflict("This suppressed source already has a successor.");
  const resumed: ExecutionRetryDisposition = { ...disposition, state: "resumed", resumedByUserId: actorId, successorRunId };
  await db.update(heartbeatRuns).set({ resultJson: { ...object(source.resultJson), retryDisposition: resumed }, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, source.id)));
  if (disposition.recoveryActionId) await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date(),
    outcome: "restored", resolutionNote: "The operator resumed the exact stopped source with current ownership and scope.",
    evidence: { sourceRunId: source.id, retryDisposition: resumed }, wakePolicy: null })
    .where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, disposition.recoveryActionId),
      eq(issueRecoveryActions.sourceIssueId, disposition.issueId!), eq(issueRecoveryActions.fingerprint, source.id), eq(issueRecoveryActions.cause, "retry_suppressed")));
  await persistActivity(db, { companyId: source.companyId, actorType: "user", actorId, action: "issue.retry_resumed",
    entityType: "heartbeat_run", entityId: source.id, issueId: disposition.issueId,
    details: { sourceRunId: source.id, successorRunId, recoveryActionId: disposition.recoveryActionId } });
}
