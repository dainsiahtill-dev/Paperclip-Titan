import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import { agentWakeupRequests, heartbeatRuns, type Db } from '@paperclipai/db';
import { issueCommentDeliveries } from '@paperclipai/db/schema/issue_comment_deliveries';
import type { LogActivityInput } from './activity-log.js';
import { adapterExecutionControls } from './adapter-execution-control.js';
import { issueTreeControlService } from './issue-tree-control.js';
import { queuedCommentIdsFromWakePayload } from './issue-queued-comment-queue.js';
import { claimCommentDelivery, deliveryRecord as record, settleCommentDelivery } from './comment-delivery.js';
import { redactSensitiveText } from '../redaction.js';
import { deliverNativeContextSteering } from './native-comment-steering.js';
import { registerNativeSteeringReadinessListener } from './native-runtime/native-session-executor.js';

const running = new Map<string, Promise<number>>();
const requestedAgain = new Set<string>();

export async function getLiveAdapterSteeringState(runId: string, db?: Db, commentIds: readonly string[] = []): Promise<'available' | 'temporarily_unavailable' | 'unsupported'> {
  const owner = adapterExecutionControls.get(runId);
  if (!owner?.steering || owner.controller.signal.aborted) return 'unsupported';
  if (db && commentIds.length) {
    const [run] = await db.select({ resultJson: heartbeatRuns.resultJson }).from(heartbeatRuns).where(eq(heartbeatRuns.id, runId));
    const acknowledgements = record(record(run?.resultJson).queuedSteeringAcknowledgements);
    if (commentIds.some((id) => record(acknowledgements[id]).status === 'uncertain')) return 'temporarily_unavailable';
    const pending = await db.select({ id: issueCommentDeliveries.id }).from(issueCommentDeliveries).where(and(eq(issueCommentDeliveries.targetRunId, runId), inArray(issueCommentDeliveries.commentId, [...commentIds]), inArray(issueCommentDeliveries.status, ['dispatching', 'uncertain']))).limit(1);
    if (pending.length) return 'temporarily_unavailable';
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
  const steering = owner.steering;
  const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, input.runId));
  const issueId = typeof run?.contextSnapshot?.issueId === 'string' ? run.contextSnapshot.issueId : null;
  if (!run || run.runtimeMode !== 'legacy' || !issueId || input.issueId && input.issueId !== issueId) return 0;
  if (await issueTreeControlService(db).getActivePauseHoldGate(run.companyId, issueId)) return 0;
  const ownerValid = () => adapterExecutionControls.get(run.id) === owner && owner.steering === steering && !owner.controller.signal.aborted;
  const previous = record(record(run.resultJson).queuedSteeringAcknowledgements);
  if (input.commentId && record(previous[input.commentId]).status === 'acknowledged') {
    const [receipt] = await db.select().from(issueCommentDeliveries).where(and(eq(issueCommentDeliveries.companyId, run.companyId), eq(issueCommentDeliveries.targetRunId, run.id), eq(issueCommentDeliveries.commentId, input.commentId), eq(issueCommentDeliveries.status, 'acknowledged'))).limit(1);
    if (receipt && (!input.queueId || receipt.queueId === input.queueId)) return 1;
  }
  if (run.status !== 'running') return 0;
  const wakes = await db.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, 'deferred_issue_execution'), sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
    input.queueId ? eq(agentWakeupRequests.id, input.queueId) : undefined,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id));
  let delivered = 0;
  for (const wake of wakes) {
    const payload = record(wake.payload), context = record(payload._paperclipWakeContext);
    if (wake.idempotencyKey?.startsWith('chat-inbound:') || payload.mutation === 'interaction' || context.interactionId) continue;
    for (const commentId of queuedCommentIdsFromWakePayload(payload)) {
      if (input.commentId && input.commentId !== commentId) continue;
      if (!ownerValid()) return delivered;
      const state = await steering.state();
      if (!state.supported || !state.active || state.busy) return delivered;
      const claimed = await claimCommentDelivery(db, {
        companyId: run.companyId, issueId, runId: run.id, queueId: wake.id, commentId, revision: input.revision,
        controllerId: owner.id, turnId: state.turnId ?? run.id, mode: 'acp', activityActor: input.activityActor, ownerValid,
      });
      if (!claimed) return delivered;
      if (claimed.duplicate) { delivered += 1; continue; }
      const { receipt, comment } = claimed;
      const author = comment.authorAgentId ? `Agent ${comment.authorAgentId}` : comment.authorType === 'user' ? `Board ${comment.authorUserId ?? 'unknown'}` : 'System';
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        if (!ownerValid()) {
          await settleCommentDelivery(db, { receipt, ownerValid, deferredReason: 'steering_stale_target' });
          return delivered;
        }
        const pending = steering.send({ correlationId: receipt.correlationId, text: `[Paperclip task handoff; original author: ${author}; comment: ${comment.id}]\n${comment.body}` }).then(async (ack) => {
          if (ack.outcome !== 'injected') {
            await settleCommentDelivery(db, { receipt, ownerValid, deferredReason: ack.reason });
            return false;
          }
          return settleCommentDelivery(db, { receipt, ownerValid, acknowledgement: { turnId: receipt.targetTurnId } });
        });
        const completed = await Promise.race([
          pending,
          new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('Steering acknowledgement timed out')), 8000); }),
        ]);
        if (!completed) return delivered;
        delivered += 1;
      } catch (error) {
        const errorMessage = redactSensitiveText(error instanceof Error ? error.message : 'Steering failed without an error message').slice(0, 500);
        await settleCommentDelivery(db, { receipt, ownerValid, errorMessage });
        return delivered;
      } finally { clearTimeout(timer); }
    }
  }
  return delivered;
}

/** One scheduler delivery pass per live run. It never creates another run. */
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
  // Compatibility entry point for the existing wake scheduler. Runtime mode
  // selects the real owner; this does not add another scheduling authority.
  const runs = await db.select({ id: heartbeatRuns.id, runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agentId), eq(heartbeatRuns.status, 'running')));
  for (const run of runs) {
    if (run.runtimeMode === 'native') scheduleNativeContextSteering(db, run.id);
    else if (adapterExecutionControls.get(run.id)?.steering) scheduleLegacySteering(db, run.id);
  }
}

export function scheduleNativeContextSteering(db: Db, runId: string): void {
  if (running.has(runId)) { requestedAgain.add(runId); return; }
  const job = deliverNativeContextSteering(db, runId).finally(() => {
    running.delete(runId);
    if (requestedAgain.delete(runId)) scheduleNativeContextSteering(db, runId);
  });
  running.set(runId, job);
  void job.catch(() => {});
}

registerNativeSteeringReadinessListener(scheduleNativeContextSteering);
