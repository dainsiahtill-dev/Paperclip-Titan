import { describe, expect, it } from "vitest";
import {
  buildHeartbeatRunStopMetadata,
  mergeHeartbeatRunStopMetadata,
  resolveHeartbeatRunTimeoutPolicy,
  resolveHeartbeatRunExecutionTimeoutPolicy,
} from "./heartbeat-stop-metadata.js";

describe("heartbeat stop metadata", () => {
  it("preserves known fractional execution timeout values", () => {
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("process", { timeoutSec: 0.5 })).toEqual({
      effectiveTimeoutSec: 0.5, timeoutConfigured: true, timeoutSource: "config",
    });
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("http", { timeoutMs: 1234.5 })).toEqual({
      effectiveTimeoutSec: 1.2345, effectiveTimeoutMs: 1234.5, timeoutConfigured: true, timeoutSource: "config",
    });
  });

  it("uses exact native turn timeout instead of a legacy adapter default", () => {
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("openclaw_gateway", {}, { nativeTurnTimeoutMs: 0 })).toEqual({
      effectiveTimeoutSec: 0, effectiveTimeoutMs: 0, timeoutConfigured: false, timeoutSource: "default",
    });
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("codex_local", { timeoutSec: 0.125 }, { nativeTurnTimeoutMs: 125 })).toEqual({
      effectiveTimeoutSec: 0.125, effectiveTimeoutMs: 125, timeoutConfigured: true, timeoutSource: "config",
    });
  });

  it("does not claim an unproved adapter or sandbox default is disabled", () => {
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("fixture_plugin", {})).toBeNull();
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("hermes_local", { timeoutSec: 0 })).toBeNull();
    expect(resolveHeartbeatRunExecutionTimeoutPolicy("codex_local", { timeoutSec: 0 }, { sandboxTarget: true })).toBeNull();
  });

  it("uses frozen runtime policy instead of the current saved adapter config", () => {
    expect(buildHeartbeatRunStopMetadata({
      adapterType: "codex_local", adapterConfig: { timeoutSec: 600 },
      timeoutPolicy: { effectiveTimeoutSec: 1800, timeoutConfigured: true, timeoutSource: "config" },
      outcome: "cancelled",
    })).toMatchObject({ effectiveTimeoutSec: 1800, timeoutFired: false });
  });

  it("reports unknown policy when execution evidence is missing", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local", adapterConfig: { timeoutSec: 600 },
      timeoutPolicy: null, outcome: "failed",
    });
    expect(mergeHeartbeatRunStopMetadata({ effectiveTimeoutMs: 9000 }, metadata)).toEqual({
      effectiveTimeoutSec: null, timeoutConfigured: false, timeoutSource: "unknown",
      stopReason: "adapter_failed", timeoutFired: false,
    });
  });

  it("keeps local coding adapters at no timeout by default", () => {
    for (const adapterType of [
      "codex_local",
      "claude_local",
      "cursor",
      "gemini_local",
      "opencode_local",
      "pi_local",
      "process",
    ]) {
      expect(resolveHeartbeatRunTimeoutPolicy(adapterType, {})).toEqual({
        effectiveTimeoutSec: 0,
        timeoutConfigured: false,
        timeoutSource: "default",
      });
    }
  });

  it("records configured timeout policy and timeout stop reason", () => {
    const metadata = buildHeartbeatRunStopMetadata({
      adapterType: "codex_local",
      adapterConfig: { timeoutSec: 45 },
      outcome: "timed_out",
      errorCode: "timeout",
      errorMessage: "Timed out after 45s",
    });

    expect(metadata).toEqual({
      effectiveTimeoutSec: 45,
      timeoutConfigured: true,
      timeoutSource: "config",
      stopReason: "timeout",
      timeoutFired: true,
    });
  });

  it("distinguishes budget cancellation from manual cancellation", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled due to budget pause",
      }).stopReason,
    ).toBe("budget_paused");

    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "cancelled",
        errorCode: "cancelled",
        errorMessage: "Cancelled by control plane",
      }).stopReason,
    ).toBe("cancelled");
  });

  it("records graceful interruption separately from failure", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "codex_local",
        adapterConfig: {},
        outcome: "interrupted",
        errorCode: "server_shutdown_interrupted",
        errorMessage: "Interrupted by graceful server shutdown",
      }).stopReason,
    ).toBe("interrupted");
  });

  it("normalizes max-turn exhaustion stop reasons", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "turn_limit_exhausted",
        errorMessage: "turn limit reached",
      }).stopReason,
    ).toBe("max_turns_exhausted");

    const merged = mergeHeartbeatRunStopMetadata(
      { stopReason: "turn_limit_exhausted" },
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "failed",
        errorCode: "adapter_failed",
      }),
    );
    expect(merged.stopReason).toBe("max_turns_exhausted");
  });

  it("prioritizes succeeded outcome over inconsistent max-turn error metadata", () => {
    expect(
      buildHeartbeatRunStopMetadata({
        adapterType: "claude_local",
        adapterConfig: {},
        outcome: "succeeded",
        errorCode: "max_turns_exhausted",
      }).stopReason,
    ).toBe("completed");
  });

  it("preserves existing result fields when merging stop metadata", () => {
    const result = mergeHeartbeatRunStopMetadata(
      { summary: "done" },
      buildHeartbeatRunStopMetadata({
        adapterType: "openclaw_gateway",
        adapterConfig: {},
        outcome: "succeeded",
      }),
    );

    expect(result).toMatchObject({
      summary: "done",
      stopReason: "completed",
      effectiveTimeoutSec: 120,
      timeoutConfigured: true,
      timeoutSource: "default",
      timeoutFired: false,
    });
  });
});
