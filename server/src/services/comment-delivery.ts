import { createHash } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, type Db } from '@paperclipai/db';
import { issueCommentDeliveries } from '@paperclipai/db/schema/issue_comment_deliveries';
import { conflict } from '../errors.js';
import { issueTreeControlService } from './issue-tree-control.js';
import { logActivity, publishActivity, type ActivityPublication, type LogActivityInput } from './activity-log.js';
import { queuedCommentIdsFromWakePayload, queuedCommentQueueRevision, withQueuedCommentIdsInWakePayload } from './issue-queued-comment-queue.js';

export const deliveryRecord = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
type Comment = typeof issueComments.$inferSelect;
type Receipt = typeof issueCommentDeliveries.$inferSelect;
export const commentDeliveryDigest = (comment: Comment) => createHash('sha256').update(JSON.stringify([
  comment.id, comment.body, comment.authorType, comment.authorAgentId, comment.authorUserId, comment.updatedAt.toISOString(),
])).digest('hex');
const sessionId = (run: typeof heartbeatRuns.$inferSelect) => run.nativeSessionId ?? run.sessionIdBefore;
async function controllerLeaseLive(tx: Db, run: typeof heartbeatRuns.$inferSelect) {
  if (run.runtimeMode !== 'legacy' || !run.controllerBootId) return true;
  const [owner] = await tx.select({ live: sql<boolean>`${heartbeatRuns.controllerLeaseExpiresAt} > clock_timestamp()` }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
  return owner?.live === true;
}

/** Existing scheduler/prompt readers can carry uncertainty without copying text. */
export async function commentDeliveryUncertaintyForComments(db: Db, input: {
  companyId: string;
  issueId: string;
  commentIds: readonly string[];
}) {
  if (!input.commentIds.length) return [];
  const live = await db.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId),
    inArray(issueComments.id, [...input.commentIds]), sql`${issueComments.deletedAt} IS NULL`,
  ));
  if (!live.length) return [];
  return db.select({
    commentId: issueCommentDeliveries.commentId, deliveryId: issueCommentDeliveries.id,
    targetRunId: issueCommentDeliveries.targetRunId, targetTurnId: issueCommentDeliveries.targetTurnId,
    correlationId: issueCommentDeliveries.correlationId, payloadSha256: issueCommentDeliveries.payloadSha256,
    status: issueCommentDeliveries.status,
  }).from(issueCommentDeliveries).where(and(
    eq(issueCommentDeliveries.companyId, input.companyId), eq(issueCommentDeliveries.issueId, input.issueId),
    inArray(issueCommentDeliveries.commentId, live.map((comment) => comment.id)),
    inArray(issueCommentDeliveries.status, ['dispatching', 'uncertain', 'superseded', 'cancelled']),
    sql`${issueCommentDeliveries.dispatchedAt} IS NOT NULL`,
  ));
}

export interface CommentDeliveryInput {
  companyId: string;
  issueId: string;
  runId: string;
  queueId: string;
  commentId: string;
  revision?: string;
  turnId: string | null;
  controllerId: string;
  mode: 'acp' | 'native';
  activityActor?: Pick<LogActivityInput, 'actorType' | 'actorId' | 'agentApiKeyId'>;
  ownerValid: () => boolean;
}

/** Caller owns capability/identity checks. No provider I/O inside these locks. */
export async function claimCommentDelivery(db: Db, input: CommentDeliveryInput): Promise<{
  receipt: Receipt; comment: Comment; duplicate: boolean;
} | null> {
  let unknown = false;
  const claimed = await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for('update');
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for('update');
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, input.queueId), eq(agentWakeupRequests.companyId, input.companyId))).for('update');
    const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, input.commentId), eq(issueComments.issueId, input.issueId), eq(issueComments.companyId, input.companyId))).for('update');
    if (!issue || !run || !wake || !comment || comment.deletedAt) return null;
    if (!await controllerLeaseLive(tx as unknown as Db, run)) return null;
    if (await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(input.companyId, input.issueId)) return null;
    const digest = commentDeliveryDigest(comment);
    const correlationId = createHash('sha256').update(JSON.stringify([input.companyId, input.issueId, input.queueId, input.runId, input.turnId, input.commentId, digest, issue.conversationSessionGeneration])).digest('hex');
    const [prior] = await tx.select().from(issueCommentDeliveries).where(eq(issueCommentDeliveries.correlationId, correlationId)).for('update');
    if (prior?.status === 'acknowledged') return { receipt: prior, comment, duplicate: true };
    if (prior && ['cancelled', 'superseded'].includes(prior.status)) return null;
    const previousVersions = await tx.select({ id: issueCommentDeliveries.id }).from(issueCommentDeliveries).where(and(
      eq(issueCommentDeliveries.companyId, input.companyId), eq(issueCommentDeliveries.targetRunId, input.runId),
      eq(issueCommentDeliveries.commentId, input.commentId), inArray(issueCommentDeliveries.status, ['dispatching', 'uncertain', 'acknowledged', 'superseded', 'cancelled']),
      sql`${issueCommentDeliveries.correlationId} <> ${correlationId}`,
    )).limit(1);
    // An edited version cannot reuse native's comment correlation or turn an
    // unknown previous effect into permission to inject a second instruction.
    if (previousVersions.length) {
      unknown = true;
      return null;
    }
    if (prior && ['dispatching', 'uncertain'].includes(prior.status)) {
      // A new controller cannot decide whether a previous external request ran.
      await tx.update(issueCommentDeliveries).set({ status: 'uncertain', lastErrorCode: 'steering_acknowledgement_unknown', updatedAt: new Date() }).where(eq(issueCommentDeliveries.id, prior.id));
      await tx.update(agentWakeupRequests).set({ payload: { ...deliveryRecord(wake.payload), executionWait: { reason: 'steering_acknowledgement_unknown', message: 'Delivery could not be confirmed. Message saved for the next turn; it will not be resent into this turn.' } }, updatedAt: new Date() }).where(eq(agentWakeupRequests.id, wake.id));
      const result = deliveryRecord(run.resultJson);
      await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: { ...deliveryRecord(result.queuedSteeringAcknowledgements), [comment.id]: { ...deliveryRecord(deliveryRecord(result.queuedSteeringAcknowledgements)[comment.id]), status: 'uncertain', queueId: wake.id, deliveryId: prior.id, correlationId: prior.correlationId, payloadSha256: prior.payloadSha256 } } } }).where(eq(heartbeatRuns.id, run.id));
      unknown = true;
      return null;
    }
    const [agent] = await tx.select({ status: agents.status }).from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId)));
    const ids = queuedCommentIdsFromWakePayload(wake.payload);
    if (!input.ownerValid() || (input.mode === 'acp' ? run.runtimeMode !== 'legacy' : run.runtimeMode !== 'native') || issue.conversationAgentId || issue.assigneeAgentId !== run.agentId || issue.executionRunId !== run.id || (run.nativeIssueId ?? deliveryRecord(run.contextSnapshot).issueId ?? deliveryRecord(run.contextSnapshot).taskId) !== issue.id || run.status !== 'running' || wake.agentId !== run.agentId || deliveryRecord(wake.payload).issueId !== issue.id || wake.status !== 'deferred_issue_execution' || !ids.includes(comment.id) || ['paused', 'terminated'].includes(agent?.status ?? '')) return null;
    const comments = await tx.select().from(issueComments).where(and(eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId), inArray(issueComments.id, ids)));
    const ordered = ids.flatMap((id) => { const row = comments.find((entry) => entry.id === id); return row && !row.deletedAt ? [row] : []; });
    const revision = queuedCommentQueueRevision({ queueId: wake.id, comments: ordered });
    if (input.revision && input.revision !== revision) throw conflict('The queued message changed', { code: 'queued_comment_stale_revision' });
    const historical = deliveryRecord(deliveryRecord(run.resultJson).queuedSteeringAcknowledgements)[comment.id];
    if (deliveryRecord(historical).status === 'uncertain') {
      if (input.revision) throw conflict('Delivery could not be confirmed. The message is preserved for the next turn.', { code: 'steering_acknowledgement_unknown' });
      return null;
    }
    const now = new Date();
    const [receipt] = await tx.insert(issueCommentDeliveries).values({
      companyId: input.companyId, issueId: issue.id, commentId: comment.id, queueId: wake.id,
      targetRunId: run.id, targetTurnId: input.turnId, targetSessionId: sessionId(run), sessionGeneration: issue.conversationSessionGeneration,
      controllerId: input.controllerId, controllerBootId: run.controllerBootId,
      commentVersion: comment.updatedAt, payloadSha256: digest, queueRevision: revision, correlationId,
      deliveryMode: input.mode, status: 'dispatching', attemptCount: 1, dispatchedAt: now,
      activityActorType: input.activityActor?.actorType ?? 'system', activityActorId: input.activityActor?.actorId ?? 'live-adapter-steering',
      activityAgentApiKeyId: input.activityActor?.agentApiKeyId ?? null,
    }).onConflictDoUpdate({ target: issueCommentDeliveries.correlationId, set: { status: 'dispatching', controllerId: input.controllerId, dispatchedAt: now, updatedAt: now, attemptCount: sql`${issueCommentDeliveries.attemptCount} + 1` } }).returning();
    await tx.update(agentWakeupRequests).set({ payload: { ...deliveryRecord(wake.payload), executionWait: { reason: 'steering_dispatching', message: 'Message saved. Waiting for the active turn to confirm delivery.' } }, updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
    return { receipt, comment, duplicate: false };
  });
  // Respond only after unknown state commits; throwing inside the transaction
  // would roll back the very uncertainty a failed request needs to preserve.
  if (unknown && input.revision) throw conflict('Delivery could not be confirmed. The message is preserved for the next turn.', { code: 'steering_acknowledgement_unknown' });
  return claimed;
}

export async function settleCommentDelivery(db: Db, input: {
  receipt: Receipt;
  ownerValid: () => boolean;
  acknowledgement?: { turnId: string | null };
  errorMessage?: string;
  deferredReason?: string;
  onCommit?: (tx: Db) => Promise<void>;
}): Promise<boolean> {
  const publications: ActivityPublication[] = [];
  const completed = await db.transaction(async (tx) => {
    const r = input.receipt;
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, r.issueId), eq(issues.companyId, r.companyId))).for('update');
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, r.targetRunId!), eq(heartbeatRuns.companyId, r.companyId))).for('update');
    const [wake] = await tx.select().from(agentWakeupRequests).where(and(eq(agentWakeupRequests.id, r.queueId), eq(agentWakeupRequests.companyId, r.companyId))).for('update');
    const [comment] = await tx.select().from(issueComments).where(and(eq(issueComments.id, r.commentId), eq(issueComments.companyId, r.companyId), eq(issueComments.issueId, r.issueId))).for('update');
    const [receipt] = await tx.select().from(issueCommentDeliveries).where(eq(issueCommentDeliveries.id, r.id)).for('update');
    if (!receipt || receipt.status === 'acknowledged') return Boolean(receipt?.status === 'acknowledged');
    if (!['dispatching', 'uncertain'].includes(receipt.status)) return false;
    if (receipt.controllerId !== r.controllerId || receipt.attemptCount !== r.attemptCount || receipt.payloadSha256 !== r.payloadSha256 || receipt.correlationId !== r.correlationId) return false;
    const [agent] = run ? await tx.select({ status: agents.status }).from(agents).where(and(eq(agents.id, run.agentId), eq(agents.companyId, run.companyId))) : [];
    const now = new Date();
    const sourceValid = comment && !comment.deletedAt && commentDeliveryDigest(comment) === r.payloadSha256 && comment.updatedAt.getTime() === r.commentVersion.getTime();
    const held = issue ? await issueTreeControlService(tx as unknown as Db).getActivePauseHoldGate(r.companyId, r.issueId) : true;
    const leaseLive = run ? await controllerLeaseLive(tx as unknown as Db, run) : false;
    const targetValid = issue && run && wake && !held && leaseLive && input.ownerValid() && issue.executionRunId === run.id && issue.assigneeAgentId === run.agentId && run.status === 'running' && issue.conversationSessionGeneration === r.sessionGeneration && sessionId(run) === r.targetSessionId && run.controllerBootId === r.controllerBootId && wake.status === 'deferred_issue_execution' && wake.agentId === run.agentId && deliveryRecord(wake.payload).issueId === issue.id && queuedCommentIdsFromWakePayload(wake.payload).includes(r.commentId) && !['paused', 'terminated'].includes(agent?.status ?? '');
    const turnValid = !input.acknowledgement || !r.targetTurnId || input.acknowledgement.turnId === r.targetTurnId;
    if (!sourceValid || !targetValid || !turnValid) {
      await tx.update(issueCommentDeliveries).set({ status: !comment || comment.deletedAt || !input.ownerValid() ? 'cancelled' : 'superseded', lastErrorCode: 'steering_stale_target', updatedAt: now }).where(eq(issueCommentDeliveries.id, r.id));
      return false;
    }
    const result = deliveryRecord(run.resultJson);
    const acknowledgements = { ...deliveryRecord(result.queuedSteeringAcknowledgements) };
    if (!input.acknowledgement) {
      const uncertain = !input.deferredReason;
      await tx.update(issueCommentDeliveries).set({ status: uncertain ? 'uncertain' : 'pending', lastErrorCode: input.deferredReason ?? 'steering_acknowledgement_unknown', updatedAt: now }).where(eq(issueCommentDeliveries.id, r.id));
      const message = uncertain ? 'Delivery could not be confirmed. The message is preserved for the next turn; it will not be resent into this turn.' : input.deferredReason === 'tool_in_progress' ? 'Message saved. Waiting for the current tool to finish before handoff.' : 'Message saved. This runner will receive it at the next turn boundary.';
      await tx.update(agentWakeupRequests).set({ payload: { ...deliveryRecord(wake.payload), executionWait: { reason: input.deferredReason ?? 'steering_acknowledgement_unknown', message } }, updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
      if (uncertain && receipt.status !== 'uncertain') {
        acknowledgements[comment.id] = { status: 'uncertain', queueId: wake.id, deliveryId: r.id, correlationId: r.correlationId, payloadSha256: r.payloadSha256, errorMessage: input.errorMessage, at: now.toISOString() };
        await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: acknowledgements }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
        await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: 'system', actorId: 'live-adapter-steering', agentId: run.agentId, runId: run.id, action: 'issue.queued_comment_delivery_uncertain', entityType: 'issue', entityId: issue.id, details: { commentId: comment.id, queueId: wake.id, targetRunId: run.id, deliveryId: r.id, protocol: r.deliveryMode, errorMessage: input.errorMessage } }, publications);
      }
      return false;
    }
    await input.onCommit?.(tx as unknown as Db);
    const turnId = input.acknowledgement.turnId;
    await tx.update(issueCommentDeliveries).set({ status: 'acknowledged', targetTurnId: turnId, acknowledgedAt: now, lastErrorCode: null, updatedAt: now }).where(eq(issueCommentDeliveries.id, r.id));
    acknowledgements[comment.id] = { status: 'acknowledged', queueId: wake.id, turnId, protocol: r.deliveryMode, deliveryId: r.id, correlationId: r.correlationId, payloadSha256: r.payloadSha256, acknowledgedAt: now.toISOString() };
    const remaining = queuedCommentIdsFromWakePayload(wake.payload).filter((id) => id !== comment.id);
    const payload = withQueuedCommentIdsInWakePayload(wake.payload, remaining);
    delete payload.executionWait;
    await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: acknowledgements }, updatedAt: now }).where(eq(heartbeatRuns.id, run.id));
    await tx.update(agentWakeupRequests).set({ payload, ...(remaining.length ? {} : { status: r.deliveryMode === 'acp' ? 'coalesced' : 'cancelled', runId: run.id, finishedAt: now }), updatedAt: now }).where(eq(agentWakeupRequests.id, wake.id));
    await logActivity(tx as unknown as Db, {
      companyId: run.companyId, actorType: r.activityActorType as LogActivityInput['actorType'], actorId: r.activityActorId,
      agentApiKeyId: r.activityAgentApiKeyId, agentId: run.agentId, runId: run.id,
      action: 'issue.queued_comment_steered', entityType: 'issue', entityId: issue.id,
      details: { commentId: comment.id, queueId: wake.id, targetRunId: run.id, turnId, deliveryId: r.id, correlationId: r.correlationId, protocol: r.deliveryMode, duplicate: false, originalAuthorType: comment.authorType, originalAuthorAgentId: comment.authorAgentId, originalAuthorUserId: comment.authorUserId },
    }, publications);
    return true;
  });
  for (const publication of publications) publishActivity(publication);
  return completed;
}
