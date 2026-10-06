import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";
import { z } from "zod";
import { activityLog, agents, environmentLeases, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, issueRecoveryActions, issues, projects, projectWorkspaces, toolInvocations, workspaceOperations, workspaceWriteOwners, type Db } from "@paperclipai/db";
import type { ExecutionRetryDisposition, RetrySupersessionRequest } from "@paperclipai/shared";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { readCapturedExecutionProfile, readExecutionProfileBinding } from "./execution-profile-binding.js";
import { conflict } from "../errors.js";
import { getConversationOwnershipBlocker } from "./conversation-continuation.js";
import { adapterExecutionControls } from "./adapter-execution-control.js";
import { persistActivity } from "./activity-log.js";
import { readContinuationMaterials } from "./continuation-materials.js";
import { readIssueResourcePolicies } from "./issue-resource-limits.js";
import { physicalWorkspaceIdentity } from "./workspace-physical-identity.js";

/** Missing process metadata is not exit proof. A host-owned, released source
 * reservation with no launch attempt is separate positive pre-launch evidence. */
async function verifiedNeverLaunchedSource(db: Db, source: typeof heartbeatRuns.$inferSelect, issueId: string) {
  if (source.runtimeMode !== "legacy" || source.processPid || source.processGroupId || source.processStartedAt) return false;
  // A captured claim in preparing is positive pre-dispatch authority: the
  // controller commits dispatching before provider handoff. This
  // is not a namespace exit receipt. Unknown historical claims remain held.
  const bootstrap = object(source.resultJson?.executionRecovery);
  const capturedAdapter = object(source.runnerProfileJson?.adapterDispatch).adapterType;
  if (source.controllerBootId && source.executionStage === "preparing" &&
      source.controllerLeaseExpiresAt && source.controllerLeaseExpiresAt.getTime() <= Date.now() &&
      ["codex_local", "claude_local"].includes(String(capturedAdapter)) &&
      readCapturedExecutionProfile(source.runnerProfileJson) && bootstrap.kind === "bootstrap" &&
      bootstrap.providerWorkStarted === false) {
    const events = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, source.companyId), eq(heartbeatRunEvents.runId, source.id),
      inArray(heartbeatRunEvents.eventType, ["adapter.invoke", "legacy.process_identity_recorded"]),
    )).limit(1);
    const authorities = await db.select({ id: workspaceWriteOwners.id }).from(workspaceWriteOwners).where(and(
      eq(workspaceWriteOwners.companyId, source.companyId), eq(workspaceWriteOwners.runId, source.id),
    )).limit(1);
    const leases = await db.select({ id: environmentLeases.id }).from(environmentLeases).where(and(
      eq(environmentLeases.companyId, source.companyId), eq(environmentLeases.heartbeatRunId, source.id),
    )).limit(1);
    const tools = await db.select({ id: toolInvocations.id }).from(toolInvocations).where(and(
      eq(toolInvocations.companyId, source.companyId), eq(toolInvocations.runId, source.id),
    )).limit(1);
    const operations = await db.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, source.companyId), eq(workspaceOperations.heartbeatRunId, source.id),
    )).limit(1);
    if (!events.length && !authorities.length && !leases.length && !tools.length && !operations.length) return true;
  }
  const cwd = source.contextSnapshot?.paperclipWorkspace && object(source.contextSnapshot.paperclipWorkspace).cwd;
  if (typeof cwd !== "string") return false;
  const identity = await physicalWorkspaceIdentity(cwd).catch(() => null);
  if (!identity) return false;
  const owners = await db.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.companyId, source.companyId), eq(workspaceWriteOwners.runId, source.id))).for("share");
  if (owners.length !== 1) return false;
  const owner = owners[0]!;
  if (owner.issueId !== issueId || owner.state !== "released" || !owner.releasedAt || owner.launchId !== null || owner.launchIdentity !== null || owner.stopReceipt !== null ||
    owner.canonicalRoot !== identity.root || owner.resourceKey !== identity.resourceKey || owner.realm !== identity.realm || owner.device !== identity.device || owner.inode !== identity.inode ||
    owner.history[0]?.event !== "claimed" || owner.history.some(event => !["claimed", "private_roots_reserved", "released"].includes(String(event.event))) ||
    !owner.history.some(event => event.event === "released" && event.generation === owner.generation && event.launchId === null)) return false;
  const dispatched = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, source.companyId),
    eq(heartbeatRunEvents.runId, source.id), inArray(heartbeatRunEvents.eventType, ["adapter.invoke", "legacy.process_identity_recorded"]))).limit(1);
  return dispatched.length === 0;
}

const dispositionSchema = z.object({
  version: z.literal(1), state: z.enum(["blocked", "resumed", "superseded"]),
  code: z.enum(["heartbeat_wake_on_demand_disabled", "execution_profile_changed"]), sourceRunId: z.string().uuid(),
  issueId: z.string().uuid().nullable(), agentId: z.string().uuid(), issueRevision: z.string().nullable(),
  sourceFingerprint: z.string(), executionProfileFingerprint: z.string().nullable().optional(), workspaceFingerprint: z.string(), scopeFingerprint: z.string(),
  requiresExplicitResume: z.literal(true), recoveryActionId: z.string().uuid().nullable(),
  resumedByUserId: z.string().optional(), successorRunId: z.string().uuid().optional(),
  supersessionRequestId: z.string().uuid().optional(),
});
const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export function readRetryDisposition(result: unknown): ExecutionRetryDisposition | null {
  const parsed = dispositionSchema.safeParse(object(result).retryDisposition);
  return parsed.success ? parsed.data : null;
}
/** System audit is the producer boundary; run events and result JSON are projections. */
export async function readVerifiedRetryDisposition(db: Db, run: Pick<typeof heartbeatRuns.$inferSelect, "id" | "companyId" | "agentId" | "resultJson">) {
  const records = await db.select().from(activityLog).where(and(eq(activityLog.companyId, run.companyId),
    eq(activityLog.entityType, "heartbeat_run"), eq(activityLog.entityId, run.id),
    inArray(activityLog.action, ["issue.retry_suppressed", "issue.retry_resumed", "issue.retry_superseded"])))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  const original = records.find(record => record.action === "issue.retry_suppressed" && record.actorType === "system" && record.actorId === "heartbeat");
  const suppressed = readRetryDisposition({ retryDisposition: original?.details?.retryDisposition });
  if (!suppressed || suppressed.sourceRunId !== run.id || suppressed.agentId !== run.agentId || suppressed.state !== "blocked") return null;
  for (const record of records) {
    if (record.actorType !== "user" || !record.actorId.trim() || record.action === "issue.retry_suppressed") continue;
    const decision = readRetryDisposition({ retryDisposition: record.details?.retryDisposition });
    if (decision && decision.sourceRunId === suppressed.sourceRunId && decision.sourceFingerprint === suppressed.sourceFingerprint &&
      record.details?.suppressionAuditId === original!.id) return decision;
  }
  return suppressed;
}

export async function listVerifiedRetryHolds(db: Db, companyId: string, issueId: string) {
  const sources = await db.select({ run: heartbeatRuns }).from(heartbeatRuns).innerJoin(activityLog, and(
    eq(activityLog.companyId, heartbeatRuns.companyId), eq(activityLog.entityId, sql`${heartbeatRuns.id}::text`),
    eq(activityLog.entityType, "heartbeat_run"), eq(activityLog.action, "issue.retry_suppressed"),
    eq(activityLog.actorType, "system"), eq(activityLog.actorId, "heartbeat")))
    .where(and(eq(heartbeatRuns.companyId, companyId), sql`${activityLog.details}->'retryDisposition'->>'issueId' = ${issueId}`));
  const held: Array<{ source: typeof heartbeatRuns.$inferSelect; disposition: ExecutionRetryDisposition }> = [];
  for (const { run } of sources) {
    const disposition = await readVerifiedRetryDisposition(db, run);
    if (disposition?.state === "blocked") held.push({ source: run, disposition });
  }
  return held;
}

type SupersessionDecision = RetrySupersessionRequest & { sourceRunId: string; successorRunId?: string; requestFingerprint: string;
  workspaceFingerprint: string; scopeFingerprint: string; executionProfileFingerprint: string };
export async function readVerifiedRetrySupersession(db: Db, companyId: string, sourceRunId: string, successorRunId: string) {
  const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.id, sourceRunId)));
  if (!source) return null;
  const disposition = await readVerifiedRetryDisposition(db, source);
  if (disposition?.state !== "superseded" || disposition.successorRunId !== successorRunId) return null;
  const records = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityType, "heartbeat_run"),
    eq(activityLog.entityId, sourceRunId), eq(activityLog.action, "issue.retry_superseded"), eq(activityLog.actorType, "user")))
    .orderBy(desc(activityLog.createdAt), desc(activityLog.id));
  const decision = records.map(record => object(record.details?.retrySupersession) as unknown as SupersessionDecision)
    .find(value => value.sourceRunId === sourceRunId && value.successorRunId === successorRunId && value.requestId === disposition.supersessionRequestId);
  return decision && typeof decision.residualObjective === "string" && Number.isSafeInteger(decision.maxRunSeconds) && decision.maxRunSeconds > 0 ? decision : null;
}
export function retrySourceFingerprint(run: typeof heartbeatRuns.$inferSelect) {
  const { retryDisposition: _, ...result } = object(run.resultJson);
  return nativeSha256({ id: run.id, companyId: run.companyId, agentId: run.agentId, status: run.status,
    error: run.error, errorCode: run.errorCode, context: run.contextSnapshot, result, logSha256: run.logSha256,
    scheduledRetryAttempt: run.scheduledRetryAttempt, usage: run.usageJson });
}
export async function retryScopeFingerprints(db: Db, issue: typeof issues.$inferSelect | null, agent: typeof agents.$inferSelect, lock = false,
  options: { omitExecutionWorkspaceLifecycleStatus?: boolean } = {}) {
  const projectQuery = issue?.projectId ? db.select().from(projectWorkspaces)
    .where(and(eq(projectWorkspaces.companyId, agent.companyId), eq(projectWorkspaces.projectId, issue.projectId)))
    .orderBy(asc(projectWorkspaces.id)) : null;
  const projectRows = projectQuery ? await (lock ? projectQuery.for("share") : projectQuery) : [];
  const executionQuery = issue?.executionWorkspaceId ? db.select().from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, agent.companyId), eq(executionWorkspaces.id, issue.executionWorkspaceId))) : null;
  const execution = executionQuery ? await (lock ? executionQuery.for("share") : executionQuery) : [];
  const policyQuery = issue?.projectId ? db.select({ policy: projects.executionWorkspacePolicy }).from(projects)
    .where(and(eq(projects.companyId, agent.companyId), eq(projects.id, issue.projectId))) : null;
  const projectPolicy = policyQuery ? await (lock ? policyQuery.for("share") : policyQuery) : [];
  const workspaceFingerprint = nativeSha256({ projectId: issue?.projectId ?? null,
    projectPolicy: projectPolicy[0]?.policy ?? null,
    projectWorkspaceId: issue?.projectWorkspaceId ?? null, executionWorkspaceId: issue?.executionWorkspaceId ?? null,
    preference: issue?.executionWorkspacePreference ?? null, settings: issue?.executionWorkspaceSettings ?? null,
    projectRows: projectRows.map(({ id, cwd, repoUrl, repoRef, defaultRef, sourceType, remoteProvider, remoteWorkspaceRef, metadata }) =>
      ({ id, cwd, repoUrl, repoRef, defaultRef, sourceType, remoteProvider, remoteWorkspaceRef, metadata })),
    execution: execution.map(({ id, cwd, repoUrl, baseRef, branchName, providerType, providerRef, mode, strategyType, status }) =>
      ({ id, cwd, repoUrl, baseRef, branchName, providerType, providerRef, mode, strategyType,
        ...(options.omitExecutionWorkspaceLifecycleStatus ? {} : { status }) })),
    adapterType: agent.adapterType, adapterConfig: agent.adapterConfig });
  const scopeFingerprint = nativeSha256({ companyId: agent.companyId, issueId: issue?.id ?? null, agentId: agent.id,
    title: issue?.title ?? null, description: issue?.description ?? null, parentId: issue?.parentId ?? null,
    goalId: issue?.goalId ?? null, executionPolicy: issue?.executionPolicy ?? null,
    overrides: issue?.assigneeAdapterOverrides ?? null, sessionGeneration: issue?.conversationSessionGeneration ?? null,
    resourcePolicies: issue ? (await readIssueResourcePolicies(db, agent.companyId, issue.id, lock)).map(({ issueId, limits }) => ({ issueId, limits })) : [],
    materials: issue ? await readContinuationMaterials(db, agent.companyId, issue.id, lock) : [] });
  return { workspaceFingerprint, scopeFingerprint, executionProfileFingerprint: (await readExecutionProfileBinding(db, issue, agent, lock)).fingerprint };
}

/** Issue then source locks serialize suppression with ordinary retry admission. */
export async function persistRetrySuppression(db: Db, run: typeof heartbeatRuns.$inferSelect, reason: string, preDispatchProfileDrift = false) {
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
    let authorizedProfile: string | null = null;
    if (preDispatchProfileDrift) {
      const reference = object(object(source.runnerProfileJson).retryExecutionProfileAuthorization);
      const [parent] = source.retryOfRunId ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, source.retryOfRunId))) : [];
      const parentDecision = parent ? await readVerifiedRetryDisposition(lockedDb, parent) : null;
      const supersession = parent && parentDecision?.state === "superseded"
        ? await readVerifiedRetrySupersession(lockedDb, source.companyId, parent.id, source.id) : null;
      authorizedProfile = supersession?.executionProfileFingerprint ?? parentDecision?.executionProfileFingerprint ?? null;
      if (source.error !== "continuation_execution_profile_changed" || parentDecision?.successorRunId !== source.id ||
        !["resumed", "superseded"].includes(parentDecision.state)) throw new Error("retry_profile_rejection_authority_missing");
      // A pre-upgrade admitted decision may lack the v1 reference. Keep its
      // audited lineage held but unqualified; never infer an old profile from
      // today's settings or let another generic retry discard the decision.
      if (reference.version !== 1 || reference.sourceRunId !== parent?.id || reference.fingerprint !== authorizedProfile)
        authorizedProfile = null;
    }
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
          nextAction: preDispatchProfileDrift ? "Review the changed execution target/profile and authorize the current remaining work with a new bounded budget." : "Enable on-demand wakes, then explicitly retry this exact source run after reviewing its remaining work.",
          wakePolicy: { automatic: false } }).returning();
        recoveryActionId = action.id;
        [issue] = await tx.update(issues).set({ status: "blocked", statusVersion: sql`${issues.statusVersion} + 1`,
          blockedTransitionAt: new Date(), updatedAt: new Date() }).where(and(eq(issues.companyId, source.companyId), eq(issues.id, issue.id))).returning();
      }
    }
    const disposition: ExecutionRetryDisposition = { version: 1, state: "blocked", code: preDispatchProfileDrift ? "execution_profile_changed" : "heartbeat_wake_on_demand_disabled",
      sourceRunId: source.id, agentId: source.agentId, issueId, issueRevision: issue?.updatedAt.toISOString() ?? null,
      sourceFingerprint: retrySourceFingerprint(source), ...await retryScopeFingerprints(lockedDb, issue, agent),
      executionProfileFingerprint: preDispatchProfileDrift ? authorizedProfile : readCapturedExecutionProfile(source.runnerProfileJson)?.fingerprint ?? null,
      requiresExplicitResume: true, recoveryActionId };
    await tx.update(heartbeatRuns).set({ resultJson: { ...object(source.resultJson), retryDisposition: disposition }, updatedAt: new Date() })
      .where(and(eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, source.id)));
    await appendHeartbeatRunEvent(lockedDb, { companyId: source.companyId, agentId: source.agentId, runId: source.id,
      eventType: "lifecycle", stream: "system", level: "warn", message: reason, payload: { retrySuppression: disposition } });
    await persistActivity(lockedDb, { companyId: source.companyId, actorType: "system", actorId: "heartbeat",
      action: "issue.retry_suppressed", entityType: "heartbeat_run", entityId: source.id, issueId,
      details: { sourceRunId: source.id, recoveryActionId, code: disposition.code, retryDisposition: disposition } });
    return disposition;
  });
}

/** Called only inside the existing company-scoped issue admission transaction. */
export async function validateSuppressedRetryResume(db: Db, input: {
  companyId: string; issueId: string; agentId: string; sourceRunId: string;
  actorType?: string | null; actorId?: string | null; reason: string | null;
  retrySupersession?: RetrySupersessionRequest;
}): Promise<{ source: typeof heartbeatRuns.$inferSelect; disposition: ExecutionRetryDisposition; supersession?: SupersessionDecision } | null> {
  const [source] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.sourceRunId))).for("update");
  const disposition = source ? await readVerifiedRetryDisposition(db, source) : null;
  if (!disposition) {
    if (input.retrySupersession) throw conflict("This source has no server-owned suppressed work to supersede.");
    return null;
  }
  const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId)));
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  if (input.actorType !== "user" || !input.actorId || input.reason !== "retry_failed_run" ||
    !source || (!input.retrySupersession && source.agentId !== input.agentId) || disposition.sourceRunId !== source.id || disposition.issueId !== input.issueId ||
    !issue || issue.hiddenAt || issue.assigneeAgentId !== input.agentId || ["done", "cancelled"].includes(issue.status) || !agent)
    throw conflict("The suppressed retry no longer belongs to this current task and owner.", { code: "retry_resume_scope_changed" });
  if (disposition.state === "resumed") {
    if (input.retrySupersession) throw conflict("The original retry already has a successor; this is not a new-work decision.");
    return { source, disposition };
  }
  if (disposition.state === "superseded") {
    const prior = disposition.successorRunId ? await readVerifiedRetrySupersession(db, input.companyId, source.id, disposition.successorRunId) : null;
    if (!input.retrySupersession || !prior || prior.requestFingerprint !== nativeSha256(input.retrySupersession))
      throw conflict("This source already has a different authorized successor.", { code: "retry_supersession_conflict" });
    return { source, disposition, supersession: prior };
  }
  const scope = await retryScopeFingerprints(db, issue, agent);
  if (!input.retrySupersession && (!disposition.executionProfileFingerprint || disposition.executionProfileFingerprint !== scope.executionProfileFingerprint || disposition.issueRevision !== issue.updatedAt.toISOString() || disposition.sourceFingerprint !== retrySourceFingerprint(source) ||
    disposition.workspaceFingerprint !== scope.workspaceFingerprint || disposition.scopeFingerprint !== scope.scopeFingerprint)
    )
    throw conflict("The source or task scope changed. Review and authorize a new remaining-work decision before resuming.", { code: "retry_resume_scope_changed" });
  if (object(object(agent.runtimeConfig).heartbeat).wakeOnDemand === false)
    throw conflict("Enable on-demand wakes before explicitly retrying this source run.", { code: disposition.code });
  if (adapterExecutionControls.has(source.id) || await getConversationOwnershipBlocker(db, input.companyId, input.issueId))
    throw conflict("The previous physical execution has not stopped.", { code: "retry_resume_owner_active" });
  const leases = await db.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, source.id)));
  if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || lease.cleanupStatus === "failed" || lease.cleanupStatus === "pending") ||
    (source.startedAt && !source.processPid && !source.processGroupId && disposition.code !== "execution_profile_changed" && !await verifiedNeverLaunchedSource(db, source, input.issueId)))
    throw conflict("The previous execution requires verified stop and cleanup evidence.", { code: "retry_resume_stop_unverified" });
  const activeAction = await db.select().from(issueRecoveryActions).where(and(eq(issueRecoveryActions.companyId, input.companyId),
    eq(issueRecoveryActions.sourceIssueId, input.issueId), inArray(issueRecoveryActions.status, ["active", "escalated"]))).for("update");
  if (activeAction.some(action => action.id !== disposition.recoveryActionId))
    throw conflict("Another recovery incident owns this task's next action.", { code: "retry_resume_other_incident" });
  const deadline = object(source.contextSnapshot?.resourceDeadline).deadlineAt;
  if (!input.retrySupersession && typeof deadline === "string" && Number.isFinite(Date.parse(deadline)) && Date.parse(deadline) <= Date.now())
    throw conflict("The original run deadline is exhausted. Pending verification and reporting require a newly authorized budget.", { code: "retry_resume_budget_exhausted" });
  if (input.retrySupersession) {
    const request = input.retrySupersession;
    if (request.expectedIssueRevision !== issue.updatedAt.toISOString() || request.expectedAssigneeAgentId !== issue.assigneeAgentId)
      throw conflict("The task changed. Refresh its current scope and owner before authorizing remaining work.", { code: "retry_supersession_stale" });
    const caps = (await readIssueResourcePolicies(db, input.companyId, issue.id)).flatMap(policy => policy.limits.maxRunSeconds ? [policy.limits.maxRunSeconds] : []);
    if (!Number.isSafeInteger(request.maxRunSeconds) || request.maxRunSeconds <= 0 || request.maxRunSeconds > 604800 ||
      (caps.length && request.maxRunSeconds > Math.min(...caps))) throw conflict("The additional wall-time budget exceeds the current task policy.", { code: "retry_supersession_budget_invalid" });
    return { source, disposition, supersession: { ...request, ...scope, sourceRunId: source.id, requestFingerprint: nativeSha256(request) } };
  }
  return { source, disposition };
}

export async function consumeSuppressedRetryResume(db: Db, source: typeof heartbeatRuns.$inferSelect,
  disposition: ExecutionRetryDisposition, actorId: string, successorRunId: string, supersession?: SupersessionDecision) {
  if (disposition.state !== "blocked") throw conflict("This suppressed source already has a successor.");
  if (supersession) {
    const [currentIssue] = await db.select().from(issues).where(and(eq(issues.companyId, source.companyId), eq(issues.id, disposition.issueId!)));
    const [currentAgent] = await db.select().from(agents).where(and(eq(agents.companyId, source.companyId), eq(agents.id, supersession.expectedAssigneeAgentId))).for("share");
    if (!currentIssue || !currentAgent || currentIssue.assigneeAgentId !== currentAgent.id || ["done", "cancelled"].includes(currentIssue.status))
      throw conflict("The current task owner changed before the decision committed.", { code: "retry_supersession_stale" });
    // Lock registered DB material/config/policy versions until commit. This is
    // not a filesystem lease; dispatch still revalidates before provider work.
    const currentScope = await retryScopeFingerprints(db, currentIssue, currentAgent, true);
    if (currentScope.scopeFingerprint !== supersession.scopeFingerprint || currentScope.workspaceFingerprint !== supersession.workspaceFingerprint || currentScope.executionProfileFingerprint !== supersession.executionProfileFingerprint)
      throw conflict("The scope changed before the decision committed. Refresh and authorize the current remaining work.", { code: "retry_supersession_stale" });
  }
  const authorizedProfile = supersession?.executionProfileFingerprint ?? disposition.executionProfileFingerprint;
  if (!authorizedProfile) throw conflict("The source has no qualified execution profile. Authorize new remaining work.");
  await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({
    retryExecutionProfileAuthorization: { version: 1, sourceRunId: source.id, fingerprint: authorizedProfile },
  })}::jsonb` }).where(and(eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, successorRunId)));
  const resumed: ExecutionRetryDisposition = { ...disposition, state: supersession ? "superseded" : "resumed", resumedByUserId: actorId, successorRunId,
    ...(supersession ? { supersessionRequestId: supersession.requestId } : {}) };
  await db.update(heartbeatRuns).set({ resultJson: { ...object(source.resultJson), retryDisposition: resumed }, updatedAt: new Date() })
    .where(and(eq(heartbeatRuns.companyId, source.companyId), eq(heartbeatRuns.id, source.id)));
  if (disposition.recoveryActionId) await db.update(issueRecoveryActions).set({ status: "resolved", resolvedAt: new Date(), updatedAt: new Date(),
    outcome: "restored", resolutionNote: "The operator resumed the exact stopped source with current ownership and scope.",
    evidence: { sourceRunId: source.id, retryDisposition: resumed }, wakePolicy: null })
    .where(and(eq(issueRecoveryActions.companyId, source.companyId), eq(issueRecoveryActions.id, disposition.recoveryActionId),
      eq(issueRecoveryActions.sourceIssueId, disposition.issueId!), eq(issueRecoveryActions.fingerprint, source.id), eq(issueRecoveryActions.cause, "retry_suppressed")));
  await persistActivity(db, { companyId: source.companyId, actorType: "user", actorId, action: supersession ? "issue.retry_superseded" : "issue.retry_resumed",
    entityType: "heartbeat_run", entityId: source.id, issueId: disposition.issueId,
    details: { sourceRunId: source.id, successorRunId, recoveryActionId: disposition.recoveryActionId, retryDisposition: resumed,
      ...(supersession ? { retrySupersession: { ...supersession, successorRunId } } : {}),
      suppressionAuditId: (await db.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, source.companyId),
        eq(activityLog.entityId, source.id), eq(activityLog.entityType, "heartbeat_run"), eq(activityLog.action, "issue.retry_suppressed"),
        eq(activityLog.actorType, "system"), eq(activityLog.actorId, "heartbeat"))).limit(1))[0]?.id } });
}
