import { and, asc, eq, isNotNull } from 'drizzle-orm';
import { heartbeatRunEvents, heartbeatRuns, type Db } from '@paperclipai/db';
import { validatePrpEvent } from '../vendor/paperclip-runner/index.js';
import { nativeSha256 } from './native-runtime/canonical.js';
import { deliveryRecord as record } from './comment-delivery.js';

type Run = typeof heartbeatRuns.$inferSelect;
export type NativeSteeringBoundary = 'available' | 'tool_in_progress' | 'native_steering_boundary_unknown' | 'steering_stale_turn';

/** Rebuild each observation from durable events, including after reconnect.
 * The provider cursor must be fully committed; an empty in-process tool map
 * cannot establish a safe boundary. Unknown item starts conservatively wait.
 */
export async function readNativeSteeringBoundary(db: Db, run: Run, input: {
  turnId: string | null;
  sourceCursor: number | null;
  pendingRuntimeRequests: boolean;
}): Promise<NativeSteeringBoundary> {
  if (!input.turnId) return 'steering_stale_turn';
  if (!run.nativeSessionId || !run.runnerInstanceId || !Number.isSafeInteger(input.sourceCursor) || input.sourceCursor! < 1) return 'native_steering_boundary_unknown';
  const rows = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.agentId, run.agentId),
    isNotNull(heartbeatRunEvents.sourceEventId), isNotNull(heartbeatRunEvents.sourceSeq),
  )).orderBy(asc(heartbeatRunEvents.seq));
  let runnerCursor = 0, started = false;
  const sourceCursors = new Map<string, number>();
  const tools = new Set<string>();
  const requests = new Set<string>();
  for (const row of rows) {
    const parsed = validatePrpEvent(record(row.payload).prpEvent);
    if (!parsed.ok) return 'native_steering_boundary_unknown';
    const event = parsed.event;
    const digest = nativeSha256(event);
    if (event.runId !== run.id || event.normalizedSessionId !== run.nativeSessionId || event.sourceSeq !== row.sourceSeq || event.sourceEventId !== row.sourceEventId || event.sourceInstanceId !== row.sourceInstanceId || event.schemaVersion !== row.protocolSchemaVersion || ![digest, `sha256:${digest}`].includes(row.sourcePayloadSha256 ?? '')) return 'native_steering_boundary_unknown';
    if (event.sourceSeq !== (sourceCursors.get(event.sourceInstanceId) ?? 0) + 1) return 'native_steering_boundary_unknown';
    sourceCursors.set(event.sourceInstanceId, event.sourceSeq);
    if (event.sourceKind === 'runner') {
      if (event.sourceInstanceId !== run.runnerInstanceId || event.sourceSeq !== runnerCursor + 1 || event.sourceSeq > input.sourceCursor!) return 'native_steering_boundary_unknown';
      runnerCursor = event.sourceSeq;
    }
    if (event.turnId !== input.turnId) continue;
    const payload = record(event.payload);
    if (event.eventType === 'turn.started') { started = true; continue; }
    if (['turn.completed', 'turn.failed', 'turn.cancelled', 'turn.interrupted'].includes(event.eventType)) return 'steering_stale_turn';
    const itemId = event.itemId;
    if (event.eventType === 'item.started' && !['agentMessage', 'reasoning', 'plan', 'userMessage'].includes(String(payload.kind))) {
      if (!itemId) return 'native_steering_boundary_unknown';
      tools.add(`item:${itemId}`);
    }
    if (['item.completed', 'item.failed', 'item.cancelled'].includes(event.eventType) && itemId) tools.delete(`item:${itemId}`);
    if (event.eventType === 'tool.execution.started') {
      if (typeof payload.executionId !== 'string') return 'native_steering_boundary_unknown';
      tools.add(`execution:${payload.executionId}`);
    }
    if (['tool.execution.completed', 'tool.execution.failed', 'tool.execution.cancelled'].includes(event.eventType) && typeof payload.executionId === 'string') tools.delete(`execution:${payload.executionId}`);
    const requestId = payload.requestId ?? record(payload.request).requestId;
    if (event.eventType === 'runtime_request.created') {
      if (typeof requestId !== 'string') return 'native_steering_boundary_unknown';
      requests.add(requestId);
    }
    if (['runtime_request.resolved', 'runtime_request.cancelled', 'runtime_request.expired'].includes(event.eventType) && typeof requestId === 'string') requests.delete(requestId);
  }
  if (!started || runnerCursor !== input.sourceCursor) return 'native_steering_boundary_unknown';
  return tools.size || requests.size || input.pendingRuntimeRequests ? 'tool_in_progress' : 'available';
}
