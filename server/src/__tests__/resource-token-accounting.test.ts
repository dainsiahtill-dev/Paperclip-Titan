import { describe, expect, it } from "vitest";
import { claudeModelUsageTotals, parseClaudeStreamJson } from "../../../packages/adapters/claude-local/src/server/parse.js";
import { parseCodexJsonl } from "../../../packages/adapters/codex-local/src/server/parse.js";

describe("provider token accounting", () => {
  it("includes Claude cache creation and reads once without changing its raw input counter", () => {
    const usage = claudeModelUsageTotals({ model: { inputTokens: 100, outputTokens: 20, cacheReadInputTokens: 50, cacheCreationInputTokens: 30 } });
    expect(usage).toMatchObject({ inputTokens: 130, cachedInputTokens: 50, totalTokens: 200 });
  });
  it("counts Claude raw fallback cache creation and reads even without modelUsage", () => {
    const parsed = parseClaudeStreamJson(JSON.stringify({ type: "result", result: "ok", usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 30 } }));
    expect(parsed.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 50, totalTokens: 200 });
  });
  it("never double counts Codex cached input, which is a subset of reported input", () => {
    const parsed = parseCodexJsonl(JSON.stringify({ type: "turn.completed", usage: { input_tokens: 100, cached_input_tokens: 50, output_tokens: 20 } }));
    expect(parsed.usage).toMatchObject({ inputTokens: 100, cachedInputTokens: 50, totalTokens: 120 });
  });
});
