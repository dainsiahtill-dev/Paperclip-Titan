import { describe, expect, it } from "vitest";
import { DEFAULT_CLAUDE_LOCAL_MODEL, resolveClaudeModel } from "./index.js";

describe("Claude model defaults", () => {
  it.each([undefined, null, "", "  "])("uses Opus 5 for an unset model (%j)", (model) => {
    expect(DEFAULT_CLAUDE_LOCAL_MODEL).toBe("claude-opus-5");
    expect(resolveClaudeModel(model)).toBe("claude-opus-5");
  });

  it("keeps explicit model IDs ahead of environment overrides", () => {
    expect(resolveClaudeModel(" claude-sonnet-4-5 ", { ANTHROPIC_MODEL: "opus" }))
      .toBe("claude-sonnet-4-5");
    expect(resolveClaudeModel("", { ANTHROPIC_MODEL: " custom-model " })).toBe("custom-model");
    expect(resolveClaudeModel("MiniMax-M3.1-Flash-Preview", { ANTHROPIC_MODEL: "claude-opus-5" }))
      .toBe("MiniMax-M3.1-Flash-Preview");
  });

  it("lets an explicit Claude-settings choice bypass the Paperclip model override", () => {
    expect(resolveClaudeModel("MiniMax-M3.1-Flash-Preview", { ANTHROPIC_MODEL: "stale-pin" }, "claude_config"))
      .toBe("");
    expect(resolveClaudeModel(undefined, {}, "claude_config")).toBe("");
  });

  it.each([
    { CLAUDE_CODE_USE_BEDROCK: "1" },
    { CLAUDE_CODE_USE_BEDROCK: "true" },
    { ANTHROPIC_BEDROCK_BASE_URL: "https://bedrock.example" },
    { CLAUDE_CODE_USE_VERTEX: "1" },
  ])("keeps provider-specific defaults for %j", (env) => {
    expect(resolveClaudeModel(undefined, env)).toBe("");
    expect(resolveClaudeModel("provider-model", env)).toBe("provider-model");
  });
});
