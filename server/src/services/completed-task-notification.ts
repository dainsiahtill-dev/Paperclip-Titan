import { and, eq } from "drizzle-orm";
import { issueComments, type Db } from "@paperclipai/db";

/** A completed-task mention is notification authority, never executor continuation. */
export async function verifiedCompletedTaskMention(db: Db, input: {
  companyId: string; issueId: string; targetAgentId: string; assigneeAgentId: string | null;
  status: string; commentId: string | null; wakeReason: string | null;
  actorType: string | null; actorId: string | null;
}) {
  if (input.status !== "done" || input.wakeReason !== "issue_comment_mentioned" || !input.commentId ||
      input.assigneeAgentId === input.targetAgentId || !input.actorId) return false;
  const [comment] = await db.select({ userId: issueComments.authorUserId, agentId: issueComments.authorAgentId, deletedAt: issueComments.deletedAt })
    .from(issueComments).where(and(eq(issueComments.id, input.commentId), eq(issueComments.companyId, input.companyId), eq(issueComments.issueId, input.issueId)));
  return Boolean(comment && !comment.deletedAt && (input.actorType === "user" ? comment.userId === input.actorId
    : input.actorType === "agent" && comment.agentId === input.actorId));
}
