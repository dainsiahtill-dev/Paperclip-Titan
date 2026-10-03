import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { agentWakeupRequests, heartbeatRuns, issueComments, type Db } from '@paperclipai/db';
import { claimCommentDelivery, commentDeliveryDigest, deliveryRecord as record, settleCommentDelivery } from './comment-delivery.js';
import { issueCommentDeliveries } from '@paperclipai/db/schema/issue_comment_deliveries';
import type { LogActivityInput } from './activity-log.js';
import { queuedCommentIdsFromWakePayload } from './issue-queued-comment-queue.js';
import { readNativeSteeringBoundary, type NativeSteeringBoundary } from './native-steering-boundary.js';
import { captureNativeSteeringOwner, getNativeSteeringBoundarySnapshot, NativeSessionSteeringError, steerNativeSession } from './native-runtime/native-session-executor.js';

async function waitAtBoundary(db: Db, run: typeof heartbeatRuns.$inferSelect, wakeId: string, reason: string) {
  const message = reason === 'tool_in_progress'
    ? 'Message saved. Waiting for the current tool to finish before handoff.'
    : reason === 'steering_unsupported'
      ? 'Message saved. This runner receives handoffs at the next turn boundary.'
      : reason === 'native_user_instruction_boundary'
        ? 'Message saved. Waiting for the next turn to preserve instruction order.'
        : 'The active turn boundary is not confirmed. Message saved for the next safe boundary.';
  await db.update(agentWakeupRequests).set({ payload: sql`jsonb_set(coalesce(${agentWakeupRequests.payload}, '{}'::jsonb), '{executionWait}', ${JSON.stringify({ reason, message })}::jsonb)`, updatedAt: new Date() }).where(and(
    eq(agentWakeupRequests.id, wakeId), eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.status, 'deferred_issue_execution'),
    sql`coalesce(${agentWakeupRequests.payload}->'executionWait'->>'reason', '') NOT IN ('steering_acknowledgement_unknown', 'steering_dispatching')`,
  ));
}

/** Ordinary Agent/system context uses the original run's authority. This path
 * never reserves or activates a user identity and never launches another turn.
 */
export async function deliverNativeContextSteering(db: Db, runId: string, input: {
  issueId?: string;
  queueId?: string;
  commentId?: string;
  revision?: string;
  activityActor?: Pick<LogActivityInput, 'actorType' | 'actorId' | 'agentApiKeyId'>;
} = {}): Promise<number> {
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
  const issueId = run?.nativeIssueId ?? record(run?.contextSnapshot).issueId;
  if (!run || run.runtimeMode !== 'native' || typeof issueId !== 'string' || input.issueId && input.issueId !== issueId) return 0;
  if (input.commentId && input.queueId) {
    const [comment] = await db.select().from(issueComments).where(and(eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), eq(issueComments.id, input.commentId)));
    if (comment && !comment.deletedAt) {
      const [receipt] = await db.select({ id: issueCommentDeliveries.id }).from(issueCommentDeliveries).where(and(eq(issueCommentDeliveries.companyId, run.companyId), eq(issueCommentDeliveries.issueId, issueId), eq(issueCommentDeliveries.targetRunId, run.id), eq(issueCommentDeliveries.queueId, input.queueId), eq(issueCommentDeliveries.commentId, comment.id), eq(issueCommentDeliveries.payloadSha256, commentDeliveryDigest(comment)), eq(issueCommentDeliveries.status, 'acknowledged'))).limit(1);
      if (receipt) return 1;
    }
  }
  if (run.status !== 'running') return 0;
  const wakes = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.status, 'deferred_issue_execution'),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    input.queueId ? eq(agentWakeupRequests.id, input.queueId) : undefined,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  let delivered = 0;
  for (const wake of wakes) {
    const payload = record(wake.payload), context = record(payload._paperclipWakeContext);
    if (wake.idempotencyKey?.startsWith('chat-inbound:') || payload.mutation === 'interaction' || context.interactionId) continue;
    const ids = queuedCommentIdsFromWakePayload(payload);
    if (!ids.length) continue;
    const comments = await db.select().from(issueComments).where(and(eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId), inArray(issueComments.id, ids)));
    for (const id of ids) {
      if (input.commentId && input.commentId !== id) continue;
      const comment = comments.find((row) => row.id === id);
      if (!comment || comment.deletedAt) continue;
      if (comment.authorType === 'user' || comment.authorUserId) {
        await waitAtBoundary(db, run, wake.id, 'native_user_instruction_boundary');
        return delivered;
      }
      const ownerValid = captureNativeSteeringOwner(run.id);
      const snapshot = await getNativeSteeringBoundarySnapshot(run.id);
      if (!snapshot.supported) { await waitAtBoundary(db, run, wake.id, 'steering_unsupported'); return delivered; }
      let boundary: NativeSteeringBoundary = await readNativeSteeringBoundary(db, run, { turnId: snapshot.activeTurnId, sourceCursor: snapshot.sourceCursor, pendingRuntimeRequests: snapshot.pendingRuntimeRequests });
      if (!ownerValid() || !ownerValid.id || boundary !== 'available') {
        await waitAtBoundary(db, run, wake.id, ownerValid() ? boundary : 'native_steering_boundary_unknown');
        return delivered;
      }
      const claimed = await claimCommentDelivery(db, { companyId: run.companyId, issueId, runId: run.id, queueId: wake.id, commentId: comment.id, revision: input.revision, turnId: snapshot.activeTurnId, controllerId: ownerValid.id, mode: 'native', ownerValid, activityActor: input.activityActor });
      if (!claimed) return delivered;
      if (claimed.duplicate) { delivered += 1; continue; }
      const { receipt } = claimed;
      if (claimed.comment.authorType === 'user' || claimed.comment.authorUserId) {
        await settleCommentDelivery(db, { receipt, ownerValid, deferredReason: 'native_user_instruction_boundary' });
        return delivered;
      }
      const author = claimed.comment.authorType === 'agent' ? `Agent ${claimed.comment.authorAgentId ?? 'unknown'}` : 'System';
      const acknowledge = (ack: { turnId: string }) => settleCommentDelivery(db, { receipt, ownerValid, acknowledgement: ack });
      try {
        const ack = await steerNativeSession({
          runId: run.id, message: `[Paperclip task context; original author: ${author}; comment: ${comment.id}]\n${claimed.comment.body}`,
          correlationId: receipt.correlationId, expectedTurnId: receipt.targetTurnId,
          authorizeBeforeDispatch: async () => {
            const current = await getNativeSteeringBoundarySnapshot(run.id);
            boundary = current.supported && current.activeTurnId === receipt.targetTurnId
              ? await readNativeSteeringBoundary(db, run, { turnId: current.activeTurnId, sourceCursor: current.sourceCursor, pendingRuntimeRequests: current.pendingRuntimeRequests })
              : 'steering_stale_turn';
            if (!ownerValid() || boundary !== 'available') throw new NativeSessionSteeringError('steering_temporarily_unavailable', 'Waiting for a confirmed tool boundary.');
          },
          onAcknowledged: async (value) => { await acknowledge(value); },
        });
        if (!await acknowledge(ack)) return delivered;
        delivered += 1;
      } catch (error) {
        const uncertain = !(error instanceof NativeSessionSteeringError) || error.code === 'steering_timeout';
        await settleCommentDelivery(db, { receipt, ownerValid, ...(uncertain ? { errorMessage: 'Native handoff acknowledgement could not be confirmed' } : { deferredReason: boundary !== 'available' ? boundary : (error as NativeSessionSteeringError).code }) });
        return delivered;
      }
    }
  }
  return delivered;
}
