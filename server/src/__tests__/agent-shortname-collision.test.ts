import { describe, expect, it } from "vitest";
import { hasAgentNameCollision } from "../services/agents.ts";

describe("hasAgentNameCollision", () => {
  it("compares human names without ASCII slug stripping", () => {
    const collision = hasAgentNameCollision("Codex Coder", [
      { id: "a1", name: " codex coder ", status: "idle" },
    ]);
    expect(collision).toBe(true);
  });

  it("ignores terminated agents", () => {
    const collision = hasAgentNameCollision("Codex Coder", [
      { id: "a1", name: "Codex Coder", status: "terminated" },
    ]);
    expect(collision).toBe(false);
  });

  it("ignores the excluded agent id", () => {
    const collision = hasAgentNameCollision(
      "Codex Coder",
      [
        { id: "a1", name: "Codex Coder", status: "idle" },
        { id: "a2", name: "other-agent", status: "idle" },
      ],
      { excludeAgentId: "a1" },
    );
    expect(collision).toBe(false);
  });

  it("allows punctuation variants which share a legacy slug", () => {
    const collision = hasAgentNameCollision("Codex Coder", [
      { id: "a1", name: "codex-coder", status: "idle" },
    ]);
    expect(collision).toBe(false);
  });
  it.each(["!!!", "研发主管", "café"])("detects duplicates even without ASCII slug identity (%s)", (name) => {
    expect(hasAgentNameCollision(name, [{ id: "a1", name, status: "idle" }])).toBe(true);
  });
});
