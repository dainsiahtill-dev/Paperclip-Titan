import { describe, expect, it } from "vitest";
import { matchesSteeringReceipt } from "./steering-receipt";
const comment = { id: "comment", updatedAt: "2026-10-04T00:00:00.000Z", deliveryContentDigest: "digest-a" };
describe("steering receipt placement", () => {
  it("requires exact current content even when a comment edit shares the same timestamp", () => {
    const receipt = { deliveryId: "delivery", payloadSha256: "digest-a", commentVersion: comment.updatedAt };
    expect(matchesSteeringReceipt(comment, receipt, comment.updatedAt)).toBe(true);
    expect(matchesSteeringReceipt({ ...comment, deliveryContentDigest: "digest-b" }, receipt, comment.updatedAt)).toBe(false);
  });
  it("does not turn a new delivery identity without version evidence into a current-content ACK", () => {
    expect(matchesSteeringReceipt(comment, { deliveryId: "delivery" }, comment.updatedAt)).toBe(false);
  });
  it("preserves legacy historical placement only before a subsequent edit", () => {
    expect(matchesSteeringReceipt(comment, {}, "2026-10-04T00:00:01.000Z")).toBe(true);
    expect(matchesSteeringReceipt({ ...comment, updatedAt: "2026-10-04T00:00:02.000Z" }, {}, "2026-10-04T00:00:01.000Z")).toBe(false);
  });
});
