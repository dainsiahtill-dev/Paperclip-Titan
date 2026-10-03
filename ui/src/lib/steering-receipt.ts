export function matchesSteeringReceipt(comment: {
  id: string; updatedAt: Date | string; deliveryContentDigest?: string | null;
} | undefined, receipt: Record<string, unknown>, acknowledgedAt: Date | string) {
  if (!comment) return false;
  if (typeof receipt.deliveryId === "string") {
    return typeof receipt.payloadSha256 === "string" && receipt.payloadSha256 === comment.deliveryContentDigest
      && typeof receipt.commentVersion === "string"
      && new Date(receipt.commentVersion).getTime() === new Date(comment.updatedAt).getTime();
  }
  return new Date(comment.updatedAt).getTime() <= new Date(acknowledgedAt).getTime();
}
