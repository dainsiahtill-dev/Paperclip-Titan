import { describe, expect, it, vi } from "vitest";
import { evaluateIssueResourceLimits, armIssueRunDeadline, readTrustedLegacyUsageCheckpoint } from "./issue-resource-limits.js";

function legacyCheckpointFixture() {
  const scope = { version: 1, source: "codex_session_cumulative_delta", sessionId: "session-a", scopeHash: "a".repeat(64) };
  return { id: "run-a", companyId: "company-a", agentId: "agent-a", controllerBootId: "boot-a", runtimeMode: "legacy",
    runnerProfileJson: { legacyUsageScope: scope },
    resultJson: { legacyUsageCheckpoint: { ...scope, runId: "run-a", companyId: "company-a", agentId: "agent-a", controllerBootId: "boot-a", adapterType: "codex_local",
      bindingVerified: true, baselineVerified: true, observedTotalTokens: 160, usageUnknown: true, observedAt: "2026-10-04T08:00:00.000Z" } },
  };
}

describe("legacy usage checkpoint trust", () => {
  it("retains a scoped reported lower bound without claiming complete usage", () => {
    expect(readTrustedLegacyUsageCheckpoint(legacyCheckpointFixture())).toMatchObject({ observedTotalTokens: 160, usageUnknown: true, source: "codex_session_cumulative_delta", sessionId: "session-a" });
  });
  it.each(["runId", "companyId", "agentId", "controllerBootId", "sessionId", "scopeHash", "source", "adapterType"])("rejects a changed %s binding", field => {
    const row = legacyCheckpointFixture();
    (row.resultJson.legacyUsageCheckpoint as Record<string, unknown>)[field] = "foreign";
    expect(readTrustedLegacyUsageCheckpoint(row)).toBeNull();
  });
  it.each(["bindingVerified", "baselineVerified"])("requires affirmative %s provenance", field => {
    const row = legacyCheckpointFixture();
    (row.resultJson.legacyUsageCheckpoint as Record<string, unknown>)[field] = false;
    expect(readTrustedLegacyUsageCheckpoint(row)).toBeNull();
  });
  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER + 1])("rejects invalid reported totals %s", value => {
    const row = legacyCheckpointFixture(); row.resultJson.legacyUsageCheckpoint.observedTotalTokens = value;
    expect(readTrustedLegacyUsageCheckpoint(row)).toBeNull();
  });
  it("requires its own immutable scope pin and legacy runtime", () => {
    const row = legacyCheckpointFixture(); row.runnerProfileJson = {} as typeof row.runnerProfileJson;
    expect(readTrustedLegacyUsageCheckpoint(row)).toBeNull();
    const native = legacyCheckpointFixture(); native.runtimeMode = "native";
    expect(readTrustedLegacyUsageCheckpoint(native)).toBeNull();
  });
});

describe("task resource limits", () => {
  it("keeps subscription token usage and automatic attempts bounded across runs", () => {
    expect(evaluateIssueResourceLimits({ maxTokensPerIssue: 1000 }, { totalTokens: 1000, unknownUsageCount: 0, automaticRuns: 1, noProgressRuns: 0 }).code).toBe("issue_token_limit");
    expect(evaluateIssueResourceLimits({ maxAutomaticRuns: 3 }, { totalTokens: 0, unknownUsageCount: 0, automaticRuns: 3, noProgressRuns: 0 }).code).toBe("issue_automatic_run_limit");
  });
  it("requires known token semantics and excludes bounded waits from no-progress caps", () => {
    const usage = { totalTokens: 10, unknownUsageCount: 1, automaticRuns: 0, noProgressRuns: 3 };
    expect(evaluateIssueResourceLimits({ maxTokensPerIssue: 1000 }, usage).code).toBe("issue_token_usage_unknown");
    expect(evaluateIssueResourceLimits({ maxNoProgressRuns: 2 }, { ...usage, boundedWait: true }).blocked).toBe(false);
    expect(evaluateIssueResourceLimits({ maxNoProgressRuns: 2 }, { ...usage, newHumanInput: true }).blocked).toBe(false);
    expect(evaluateIssueResourceLimits({ maxNoProgressRuns: 2 }, usage).code).toBe("issue_no_progress_limit");
  });
  it("preserves an owned physical deadline until its stop callback settles", async () => {
    vi.useFakeTimers();
    try {
      let finish!: () => void;
      const stop = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
      const deadline = armIssueRunDeadline({ deadlineAt: Date.now() + 1000, stop });
      await vi.advanceTimersByTimeAsync(1000);
      expect(stop).toHaveBeenCalledTimes(1);
      let drained = false;
      const drain = deadline.drain().then(() => { drained = true; });
      await Promise.resolve(); expect(drained).toBe(false);
      finish(); await drain; expect(drained).toBe(true);
      deadline.clear(); await vi.advanceTimersByTimeAsync(5000); expect(stop).toHaveBeenCalledTimes(1);
    } finally { vi.useRealTimers(); }
  });
  it("clears an unexpired deadline without stopping completed work", async () => {
    vi.useFakeTimers();
    try {
      const stop = vi.fn(async () => undefined);
      const deadline = armIssueRunDeadline({ deadlineAt: Date.now() + 1000, stop });
      deadline.clear(); await vi.advanceTimersByTimeAsync(2000); expect(stop).not.toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
