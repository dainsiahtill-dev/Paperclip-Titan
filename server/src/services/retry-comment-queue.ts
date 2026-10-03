import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agentWakeupRequests, heartbeatRuns, issueComments, issues, type Db } from "@paperclipai/db";
import {
  queuedCommentIdsFromRunContext,
  queuedCommentIdsFromWakePayload,
  withQueuedCommentIdsInRunContext,
  withQueuedCommentIdsInWakePayload,
} from "./issue-queued-comment-queue.js";
import { commentDeliveryUncertaintyForComments } from './comment-delivery.js';

type Run = typeof heartbeatRuns.$inferSelect;
type Wake = typeof agentWakeupRequests.$inferSelect;

/** Called inside the existing issue/wake/run claim transaction. */
export async function adoptDeferredCommentsForLegacyRetry(
  tx: Db,
  input: {
    run: Run;
    wake: Wake;
    issueId: string;
    now: Date;
    canAdopt: (wake: Wake) => boolean;
  },
): Promise<{ run: Run; wake: Wake } | null> {
  const { run, wake, issueId, now } = input;
  if (run.runtimeMode !== "legacy" || !run.retryOfRunId || run.invocationSource !== "automation" || run.wakeupRequestId !== wake.id) return null;
  const [parent] = await tx.select({ runtimeMode: heartbeatRuns.runtimeMode }).from(heartbeatRuns)
    .where(and(eq(heartbeatRuns.id, run.retryOfRunId), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId)));
  if (parent?.runtimeMode !== "legacy") return null;
  const [issue] = await tx.select({ assigneeAgentId: issues.assigneeAgentId, conversationAgentId: issues.conversationAgentId })
    .from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, run.companyId)));
  if (!issue || issue.assigneeAgentId !== run.agentId || issue.conversationAgentId) return null;

  const pending = await tx.select().from(agentWakeupRequests).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    sql`${agentWakeupRequests.payload}->>'issueId' = ${issueId}`,
  )).orderBy(asc(agentWakeupRequests.requestedAt), asc(agentWakeupRequests.id)).for("update");
  const adopted = pending.filter(input.canAdopt);
  if (!adopted.length) return null;
  const context = run.contextSnapshot ?? {};
  const ids = [...new Set([
    ...queuedCommentIdsFromRunContext(context),
    ...queuedCommentIdsFromWakePayload(wake.payload),
    ...(typeof context.wakeCommentId === "string" ? [context.wakeCommentId] : []),
    ...adopted.flatMap((entry) => queuedCommentIdsFromWakePayload(entry.payload)),
  ])];
  const live = await tx.select({ id: issueComments.id }).from(issueComments).where(and(
    eq(issueComments.companyId, run.companyId), eq(issueComments.issueId, issueId),
    inArray(issueComments.id, ids), isNull(issueComments.deletedAt),
    sql`nullif(trim(${issueComments.body}), '') is not null`,
  )).orderBy(asc(issueComments.createdAt), asc(issueComments.id));
  const liveSet = new Set(live.map((comment) => comment.id));
  // Wake payload order is canonical, including user reorder; the DB read only
  // filters deleted comments and must not silently restore creation order.
  const liveIds = ids.filter((id) => liveSet.has(id));
  if (!liveIds.length) return null;
  const queuedCommentDeliveryUncertainty = await commentDeliveryUncertaintyForComments(tx, { companyId: run.companyId, issueId, commentIds: liveIds });

  const [updatedWake] = await tx.update(agentWakeupRequests).set({
    payload: withQueuedCommentIdsInWakePayload(wake.payload, liveIds), updatedAt: now,
  }).where(and(eq(agentWakeupRequests.id, wake.id), eq(agentWakeupRequests.companyId, run.companyId), eq(agentWakeupRequests.agentId, run.agentId), eq(agentWakeupRequests.status, "queued"), eq(agentWakeupRequests.runId, run.id))).returning();
  const [updatedRun] = await tx.update(heartbeatRuns).set({
    contextSnapshot: { ...withQueuedCommentIdsInRunContext(context, liveIds), queuedCommentDeliveryUncertainty }, updatedAt: now,
  }).where(and(eq(heartbeatRuns.id, run.id), eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.status, "queued"), eq(heartbeatRuns.wakeupRequestId, wake.id))).returning();
  if (!updatedWake || !updatedRun) throw new Error("Retry queue claim disappeared while locked");
  await tx.update(agentWakeupRequests).set({
    status: "coalesced", runId: run.id, finishedAt: now, updatedAt: now,
  }).where(and(
    eq(agentWakeupRequests.companyId, run.companyId),
    eq(agentWakeupRequests.agentId, run.agentId),
    eq(agentWakeupRequests.status, "deferred_issue_execution"),
    inArray(agentWakeupRequests.id, adopted.map((entry) => entry.id)),
  ));
  return { run: updatedRun, wake: updatedWake };
}
