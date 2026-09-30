import { describe, expect, it } from "vitest";
import {
  activeQuotaProbeReservations, buildQuotaBackupConfig, initialQuotaScope,
  quotaFallbackFingerprint, selectQuotaFallbackAgent, type QuotaFallbackAgent,
} from "./agent-quota-fallback-policy.js";

function primary(): QuotaFallbackAgent {
  return { id: "agent", companyId: "company", adapterType: "claude_local",
    adapterConfig: { model: "MiniMax-M3.1-Flash-Preview", engine: "cli", command: "claude", instructionsFilePath: "/instructions/AGENTS.md", env: { ANTHROPIC_AUTH_TOKEN: "primary-key", OPENAI_BASE_URL: "https://primary.invalid", CODEX_HOME: "/primary/private-login", CLAUDE_CODE_USE_BEDROCK: "1", GITHUB_TOKEN: { type: "secret_ref", secretId: "business-secret" } } },
    runtimeConfig: { heartbeat: { maxConcurrentRuns: 1, concurrencyGroup: "minimax" }, aiConnection: { provider: "anthropic", mode: "responsible_user" }, quotaFallback: { enabled: true, backup: { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" }, recoveryEnabled: true, primaryCheckIntervalSec: 300 } }, metadata: null };
}
function activate(agent: QuotaFallbackAgent) {
  agent.metadata = { quotaFallbackState: { version: 1, fingerprint: quotaFallbackFingerprint(agent), scopes: { alice: { ...initialQuotaScope(), usingBackup: true } } } };
}

describe("quota routing policy", () => {
  it("leaves disabled Agents and their claim metadata unchanged", () => {
    const agent = primary(); agent.runtimeConfig.quotaFallback = { enabled: false };
    expect(selectQuotaFallbackAgent(agent, "alice")).toEqual({ agent, pin: null });
  });
  it("does not change primary configuration or another responsible user's route", () => {
    const agent = primary(); activate(agent);
    const alice = selectQuotaFallbackAgent(agent, "alice");
    expect(alice.agent.adapterType).toBe("codex_local");
    expect(alice.agent.adapterConfig).toMatchObject({ model: "gpt-6.1-sol", engine: "cli", dangerouslyBypassSandbox: true, instructionsFilePath: "/instructions/AGENTS.md" });
    expect(alice.agent.runtimeConfig.aiConnection).toBeUndefined();
    expect(alice.agent.runtimeConfig.heartbeat).toMatchObject({ maxConcurrentRuns: 1, concurrencyGroup: "" });
    expect(selectQuotaFallbackAgent(agent, "bob").agent).toBe(agent);
    expect(agent.adapterType).toBe("claude_local");
  });

  it("removes primary auth directories, endpoint and provider switches from backup environment", () => {
    const env = buildQuotaBackupConfig(primary(), { adapterType: "codex_local", model: "gpt-6.1-sol" }).env;
    expect(env).toEqual({ GITHUB_TOKEN: { type: "secret_ref", secretId: "business-secret" } });
  });

  it("keeps an admitted backup immutable when the primary recovers", () => {
    const agent = primary(); activate(agent);
    const admitted = selectQuotaFallbackAgent(agent, "alice");
    agent.metadata = null;
    expect(selectQuotaFallbackAgent(agent, "alice", admitted.pin).agent.adapterType).toBe("codex_local");
    expect(selectQuotaFallbackAgent(agent, "alice").agent.adapterType).toBe("claude_local");
  });

  it("invalidates outdated state and rejects a stale claim after config changes", () => {
    const agent = primary(); activate(agent);
    const admitted = selectQuotaFallbackAgent(agent, "alice");
    agent.adapterConfig.model = "MiniMax-another-version";
    expect(selectQuotaFallbackAgent(agent, "alice").pin?.usingBackup).toBe(false);
    expect(() => selectQuotaFallbackAgent(agent, "alice", admitted.pin)).toThrow("configuration changed");
  });

  it("counts only bounded, live provider probe leases", () => {
    const now = new Date("2026-10-01T00:00:00Z");
    expect(activeQuotaProbeReservations({ quotaFallbackState: { scopes: {
      alice: { probeToken: "lease", probeGroup: "minimax", probeUntil: "2026-10-01T00:01:00Z" },
      bob: { probeToken: "expired", probeGroup: "minimax", probeUntil: "2026-09-30T23:59:00Z" },
      forged: { probeToken: "forever", probeGroup: "minimax", probeUntil: "2099-01-01T00:00:00Z" },
    } } }, now)).toEqual([{ group: "minimax" }]);
  });

  it("keeps the backup selected when only recovery controls change", () => {
    const agent = primary(); activate(agent);
    const original = selectQuotaFallbackAgent(agent, "alice");
    agent.runtimeConfig.quotaFallback = { ...(agent.runtimeConfig.quotaFallback as Record<string, unknown>), primaryCheckIntervalSec: 60, recoveryEnabled: false };
    expect(selectQuotaFallbackAgent(agent, "alice").pin?.usingBackup).toBe(true);
    expect(selectQuotaFallbackAgent(agent, "alice", original.pin).agent.adapterType).toBe("codex_local");
  });
});
