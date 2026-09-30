import { describe, expect, it } from "vitest";
import { agentRuntimeConfigSchema } from "./agent.js";

const backup = { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" };

describe("Agent quota fallback configuration", () => {
  it("normalizes a configured backup and primary recovery interval", () => {
    const parsed = agentRuntimeConfigSchema.parse({
      heartbeat: { enabled: false, maxConcurrentRuns: 1 },
      quotaFallback: { enabled: true, backup },
    });
    expect(parsed.quotaFallback).toMatchObject({ enabled: true, recoveryEnabled: true, primaryCheckIntervalSec: 900, backup });
    expect(parsed.heartbeat).toEqual({ enabled: false, maxConcurrentRuns: 1 });
  });

  it.each([0, 59, 86401, NaN, "900"])("rejects invalid primary check interval %s", (primaryCheckIntervalSec) => {
    expect(() => agentRuntimeConfigSchema.parse({ quotaFallback: { enabled: true, backup, primaryCheckIntervalSec } })).toThrow();
  });

  it("requires a backup when enabled", () => {
    expect(() => agentRuntimeConfigSchema.parse({ quotaFallback: { enabled: true } })).toThrow();
    expect(agentRuntimeConfigSchema.parse({ quotaFallback: { enabled: false } }).quotaFallback).toMatchObject({ enabled: false });
  });

  it.each([{ env: { OPENAI_API_KEY: "not-a-stored-secret" } }, { command: "custom-executable" }, { extraArgs: ["--model", "other"] }])(
    "rejects opaque credential and command overrides in a backup %s", (extra) => {
      expect(() => agentRuntimeConfigSchema.parse({ quotaFallback: { enabled: true, backup: { ...backup, ...extra } } })).toThrow();
    },
  );

  it("accepts explicit custom Claude models and independent managed connections", () => {
    const parsed = agentRuntimeConfigSchema.parse({ quotaFallback: {
      enabled: true, primaryCheckIntervalSec: 300,
      backup: { adapterType: "claude_local", model: "MiniMax-M3.1-Flash-Preview", concurrencyGroup: "minimax", aiConnection: { provider: "anthropic", method: "api_key", mode: "responsible_user" } },
    } });
    expect(parsed.quotaFallback).toMatchObject({ primaryCheckIntervalSec: 300, recoveryEnabled: true, backup: { model: "MiniMax-M3.1-Flash-Preview" } });
  });
});
