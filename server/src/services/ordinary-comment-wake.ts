import { and, eq, sql } from 'drizzle-orm';
import { agentWakeupRequests, agents, heartbeatRuns, issues, type Db } from '@paperclipai/db';
import { shouldWakeAssigneeForIssueComment } from './issue-comment-wakeup.js';
import { commentDeliveryDigest, deliveryRecord as record } from './comment-delivery.js';
import { withQueuedCommentIdsInWakePayload } from './issue-queued-comment-queue.js';
import type { issueComments } from '@paperclipai/db';

export interface OrdinaryCommentWakeIntent {
  resumeRequested?: boolean;
  reopened?: boolean;
  reopenedFrom?: string | null;
  interruptedRunId?: string | null;
  issueAtCommentStart?: { checkoutRunId?: string | null; executionRunId?: string | null };
}

/** Caller holds the source comment transaction. This is an unadmitted receipt
 * in the existing wake queue, never authority to dispatch a provider directly.
 */
export async function persistOrdinaryCommentWake(tx: Db, comment: typeof issueComments.$inferSelect, intent: OrdinaryCommentWakeIntent) {
  const [issue] = await tx.select().from(issues).where(and(eq(issues.id, comment.issueId), eq(issues.companyId, comment.companyId))).for('update');
  if (!issue || issue.conversationAgentId || !issue.assigneeAgentId || comment.deletedAt) return;
  const [agent] = await tx.select({ id: agents.id }).from(agents).where(and(eq(agents.id, issue.assigneeAgentId), eq(agents.companyId, issue.companyId)));
  if (!agent) return;
  const [sourceRun] = comment.createdByRunId ? await tx.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, comment.createdByRunId), eq(heartbeatRuns.companyId, issue.companyId))) : [];
  const selfComment = comment.authorAgentId === issue.assigneeAgentId || sourceRun?.agentId === issue.assigneeAgentId;
  if (!shouldWakeAssigneeForIssueComment({ selfComment, resumeRequested: intent.resumeRequested === true, commentCreatedByRunId: comment.createdByRunId, issueAtCommentStart: intent.issueAtCommentStart ?? issue, reopened: intent.reopened === true, currentStatus: issue.status })) return;
  const [existing] = await tx.select({ id: agentWakeupRequests.id }).from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, issue.companyId), eq(agentWakeupRequests.agentId, issue.assigneeAgentId),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
    sql`(${agentWakeupRequests.payload}->>'commentId' = ${comment.id} OR ${agentWakeupRequests.payload}#>'{_paperclipWakeContext,wakeCommentIds}' @> ${JSON.stringify([comment.id])}::jsonb)`,
  )).limit(1);
  if (existing) return;
  const actorType = comment.authorUserId ? 'user' : comment.authorAgentId ? 'agent' : 'system';
  const actorId = comment.authorUserId ?? comment.authorAgentId ?? 'issue-comment';
  const reason = intent.reopened ? 'issue_reopened_via_comment' : 'issue_commented';
  const context = {
    issueId: issue.id, taskId: issue.id, commentId: comment.id, wakeCommentId: comment.id, wakeCommentIds: [comment.id],
    source: intent.reopened ? 'issue.comment.reopen' : 'issue.comment', wakeReason: reason,
    ...(intent.resumeRequested ? { resumeIntent: true, followUpRequested: true } : {}),
    ...(intent.reopenedFrom ? { reopenedFrom: intent.reopenedFrom } : {}),
    ...(intent.interruptedRunId ? { interruptedRunId: intent.interruptedRunId } : {}),
  };
  await tx.insert(agentWakeupRequests).values({
    companyId: issue.companyId, agentId: issue.assigneeAgentId, source: 'automation', triggerDetail: 'system', reason,
    status: 'deferred_issue_execution', requestedByActorType: actorType, requestedByActorId: actorId,
    idempotencyKey: `ordinary-comment:${comment.id}`,
    payload: withQueuedCommentIdsInWakePayload({
      issueId: issue.id, commentId: comment.id, mutation: 'comment', _paperclipWakeContext: context,
      _ordinaryCommentWake: { pending: true, commentId: comment.id, sourceExecutionRunId: issue.executionRunId, payloadSha256: commentDeliveryDigest(comment), commentVersion: comment.updatedAt.toISOString() },
      executionWait: { reason: 'comment_admission_pending', message: 'Message saved. Waiting for the task to be ready.' },
    }, [comment.id]),
  });
}

export function ordinaryCommentWakeIsPending(payload: unknown) {
  return record(record(payload)._ordinaryCommentWake).pending === true;
}
