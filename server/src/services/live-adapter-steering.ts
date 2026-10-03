import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { agentWakeupRequests, agents, heartbeatRuns, issueComments, issues, type Db } from '@paperclipai/db';
import { logActivity, publishActivity, type ActivityPublication, type LogActivityInput } from './activity-log.js';
import { adapterExecutionControls } from './adapter-execution-control.js';
import { issueTreeControlService } from './issue-tree-control.js';
import { queuedCommentIdsFromWakePayload, queuedCommentQueueRevision, withQueuedCommentIdsInWakePayload } from './issue-queued-comment-queue.js';
import { conflict } from '../errors.js';
import { redactSensitiveText } from '../redaction.js';

const running = new Map<string, Promise<number>>();
const requestedAgain = new Set<string>();
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

export async function getLiveAdapterSteeringState(runId: string, db?: Db, commentIds: readonly string[] = []): Promise<'available' | 'temporarily_unavailable' | 'unsupported'> {
  const owner = adapterExecutionControls.get(runId);
  if (!owner?.steering || owner.controller.signal.aborted) return 'unsupported';
  if (db && commentIds.length) {
    const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const acknowledgements = record(record(run?.resultJson).queuedSteeringAcknowledgements);
    if (commentIds.some((id) => record(acknowledgements[id]).status === 'uncertain')) return 'temporarily_unavailable';
  }
  try {
    const state = await owner.steering.state();
    return !state.supported ? 'unsupported' : state.active && !state.busy ? 'available' : 'temporarily_unavailable';
  } catch { return 'temporarily_unavailable'; }
}

export async function deliverLegacySteering(db: Db, input: {
  runId: string;
  issueId?: string;
  queueId?: string;
  commentId?: string;
  revision?: string;
  activityActor?: Pick<LogActivityInput, 'actorType' | 'actorId' | 'agentApiKeyId'>;
}): Promise<number> {
  const owner = adapterExecutionControls.get(input.runId);
  if (!owner?.steering || owner.controller.signal.aborted) return 0;
  const [initial] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
  const issueId = typeof initial?.contextSnapshot?.issueId === 'string' ? initial.contextSnapshot.issueId : null;
  if (!initial || initial.status !== 'running' || initial.runtimeMode !== 'legacy' || !issueId || input.issueId && input.issueId !== issueId) return 0;
  if (await issueTreeControlService(db).getActivePauseHoldGate(initial.companyId, issueId)) return 0;

  const publications: ActivityPublication[] = [];
  const delivered = await db.transaction(async (tx) => {
    const [issue] = await tx.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, initial.companyId))).for('update');
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, initial.id), eq(heartbeatRuns.companyId, initial.companyId))).for('update');
    const [agent] = await tx.select({ status: agents.status }).from(agents).where(and(eq(agents.id, initial.agentId), eq(agents.companyId, initial.companyId)));
    if (!issue || !run || issue.conversationAgentId || issue.assigneeAgentId !== run.agentId || issue.executionRunId !== run.id || run.status !== 'running' || agent?.status === 'paused' || agent?.status === 'terminated' || owner.controller.signal.aborted) return 0;
    const result = record(run.resultJson);
    const acknowledgements = { ...record(result.queuedSteeringAcknowledgements) };
    if (input.commentId && record(acknowledgements[input.commentId]).status === 'acknowledged') {
      if (input.queueId && record(acknowledgements[input.commentId]).queueId !== input.queueId) throw conflict('The message belongs to another queue');
      return 1;
    }
    const wakes = await tx.select().from(agentWakeupRequests).where(and(
      eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
      eq(agentWakeupRequests.status, 'deferred_issue_execution'),
      sql`${agentWakeupRequests.payload}->>'issueId' = ${issue.id}`,
      input.queueId ? eq(agentWakeupRequests.id, input.queueId) : undefined,
    )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id)).for('update');
    let delivered = 0;
    for (const wake of wakes) {
      const payload = record(wake.payload), context = record(payload._paperclipWakeContext);
      if (wake.idempotencyKey?.startsWith('chat-inbound:') || payload.mutation === 'interaction' || context.interactionId) continue;
      const ids = queuedCommentIdsFromWakePayload(payload);
      if (!ids.length) continue;
      const comments = await tx.select().from(issueComments).where(and(eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issue.id), inArray(issueComments.id, ids)));
      const ordered = ids.flatMap((id) => { const comment = comments.find((row) => row.id === id); return comment && !comment.deletedAt ? [comment] : []; });
      if (input.revision && queuedCommentQueueRevision({ queueId: wake.id, comments: ordered }) !== input.revision) throw conflict('The queued message changed', { code: 'queued_comment_stale_revision' });
      let remaining = [...ids];
      for (const comment of ordered) {
        if (input.commentId && input.commentId !== comment.id) continue;
        const previous = record(acknowledgements[comment.id]);
        if (previous.status === 'acknowledged') { remaining = remaining.filter((id) => id !== comment.id); continue; }
        if (previous.status === 'uncertain') {
          if (input.commentId) throw conflict('Delivery could not be confirmed. The message is preserved; resume it in the next turn.', { code: 'steering_acknowledgement_unknown' });
          return delivered;
        }
        if (adapterExecutionControls.get(run.id) !== owner || owner.controller.signal.aborted) return delivered;
        const state = await owner.steering!.state();
        if (!state.supported || !state.active || state.busy) return delivered;
        const author = comment.authorAgentId ? `Agent ${comment.authorAgentId}` : `Board ${comment.authorUserId ?? 'unknown'}`;
        let acknowledgement;
        let timeout: ReturnType<typeof setTimeout> | undefined;
        try {
          acknowledgement = await Promise.race([
            owner.steering!.send({ correlationId: comment.id, text: `[Paperclip task handoff; original author: ${author}; comment: ${comment.id}]\n${comment.body}` }),
            new Promise<never>((_resolve, reject) => { timeout = setTimeout(() => reject(new Error('Steering acknowledgement timed out')), 8000); }),
          ]);
        } catch (error) {
          const errorMessage = redactSensitiveText(error instanceof Error ? error.message : 'Steering failed without an error message').slice(0, 500);
          acknowledgements[comment.id] = { status: 'uncertain', queueId: wake.id, at: new Date().toISOString(), errorMessage };
          await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: acknowledgements } }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
          await tx.update(agentWakeupRequests).set({ payload: { ...payload, executionWait: { reason: 'steering_acknowledgement_unknown', message: 'Delivery could not be confirmed. The message is preserved; resume it in the next turn.' } }, updatedAt: new Date() }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, run.companyId)));
          await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: 'system', actorId: 'live-adapter-steering', agentId: run.agentId, runId: run.id, action: 'issue.queued_comment_delivery_uncertain', entityType: 'issue', entityId: issue.id, details: { commentId: comment.id, queueId: wake.id, targetRunId: run.id, protocol: 'acp', errorMessage } }, publications);
          return delivered;
        } finally {
          clearTimeout(timeout);
        }
        if (acknowledgement.outcome !== 'injected') return delivered;
        acknowledgements[comment.id] = { status: 'acknowledged', queueId: wake.id, turnId: run.id, protocol: 'acp', at: new Date().toISOString() };
        remaining = remaining.filter((id) => id !== comment.id);
        const now = new Date();
        await tx.update(heartbeatRuns).set({ resultJson: { ...result, queuedSteeringAcknowledgements: acknowledgements }, updatedAt: now }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId)));
        await tx.update(agentWakeupRequests).set({ payload: withQueuedCommentIdsInWakePayload(payload, remaining), ...(remaining.length === 0 ? { status: 'coalesced', runId: run.id, finishedAt: now } : {}), updatedAt: now }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, run.companyId)));
        await logActivity(tx as unknown as Db, { companyId: run.companyId, actorType: input.activityActor?.actorType ?? 'system', actorId: input.activityActor?.actorId ?? 'live-adapter-steering', agentApiKeyId: input.activityActor?.agentApiKeyId, agentId: run.agentId, runId: run.id, action: 'issue.queued_comment_steered', entityType: 'issue', entityId: issue.id, details: { commentId: comment.id, queueId: wake.id, targetRunId: run.id, protocol: 'acp', originalAuthorType: comment.authorType, originalAuthorAgentId: comment.authorAgentId, originalAuthorUserId: comment.authorUserId } }, publications);
        delivered += 1;
      }
    }
    return delivered;
  });
  for (const publication of publications) publishActivity(publication);
  return delivered;
}

/** One owner per run; another event during delivery schedules one further pass. */
export function scheduleLegacySteering(db: Db, runId: string): void {
  if (running.has(runId)) { requestedAgain.add(runId); return; }
  const job = deliverLegacySteering(db, { runId }).finally(() => {
    running.delete(runId);
    if (requestedAgain.delete(runId)) scheduleLegacySteering(db, runId);
  });
  running.set(runId, job);
  void job.catch(() => {});
}

export async function scheduleLegacySteeringForAgent(db: Db, agentId: string): Promise<void> {
  const runs = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, 'running'), eq(heartbeatRuns.runtimeMode, 'legacy')));
  for (const run of runs) if (adapterExecutionControls.get(run.id)?.steering) scheduleLegacySteering(db, run.id);
}
