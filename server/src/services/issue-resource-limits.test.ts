import { describe, expect, it, vi } from "vitest";
import { evaluateIssueResourceLimits, armIssueRunDeadline } from "./issue-resource-limits.js";

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
