import { describe, expect, it } from "vitest";
import { sessionCodec } from "./index.js";

describe("Claude session codec model identity", () => {
  const params = {
    sessionId: "12345678-1234-4abc-9def-123456789012",
    cwd: "/workspace",
    modelIdentity: "model:MiniMax-M3.1-Flash-Preview",
  };

  it("serializes the model identity needed by the next heartbeat", () => {
    expect(sessionCodec.serialize({ ...params, unrelated: "do-not-store" })).toEqual(params);
  });

  it("deserializes the persisted model identity", () => {
    expect(sessionCodec.deserialize(params)).toEqual(params);
  });
});
