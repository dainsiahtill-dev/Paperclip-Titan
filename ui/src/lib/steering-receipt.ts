export function matchesSteeringReceipt(comment: {
  id: string; createdAt?: Date | string; updatedAt: Date | string; deliveryContentDigest?: string | null;
} | undefined, receipt: Record<string, unknown>, acknowledgedAt: Date | string) {
  if (!comment) return false;
  if (typeof receipt.deliveryId === "string") {
    return typeof receipt.payloadSha256 === "string" && receipt.payloadSha256 === comment.deliveryContentDigest
      && typeof receipt.commentVersion === "string"
      && new Date(receipt.commentVersion).getTime() === new Date(comment.updatedAt).getTime();
  }
  // Legacy events contain no payload version. An edit before a late ACK can
  // otherwise promote new text the provider never received.
  return comment.createdAt !== undefined
    && new Date(comment.createdAt).getTime() === new Date(comment.updatedAt).getTime()
    && new Date(comment.updatedAt).getTime() <= new Date(acknowledgedAt).getTime();
}
