import { createHash } from "node:crypto";
export function commentContentDigest(comment: {
  id: string; body: string; authorType?: string | null; authorAgentId?: string | null;
  authorUserId?: string | null; updatedAt: Date | string;
}) {
  return createHash("sha256").update(JSON.stringify([comment.id, comment.body,
    comment.authorType ?? null, comment.authorAgentId ?? null, comment.authorUserId ?? null,
    new Date(comment.updatedAt).toISOString()])).digest("hex");
}
