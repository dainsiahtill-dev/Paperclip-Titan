export type HeartbeatRunOutcome = "succeeded" | "interrupted" | "failed" | "cancelled" | "timed_out";

export type HeartbeatRunStopReason =
  | "completed"
  | "interrupted"
  | "timeout"
  | "cancelled"
  | "budget_paused"
  | "paused"
  | "max_turns_exhausted"
  | "process_lost"
  | "unmanaged_background_task_stopped"
  | "adapter_failed";

export interface HeartbeatRunTimeoutPolicy {
  effectiveTimeoutSec: number | null;
  effectiveTimeoutMs?: number | null;
  timeoutConfigured: boolean;
  timeoutSource: "config" | "default" | "unknown";
}

export interface HeartbeatRunStopMetadata extends HeartbeatRunTimeoutPolicy {
  stopReason: HeartbeatRunStopReason;
  timeoutFired: boolean;
}

export interface HeartbeatRunExecutionTimeoutPolicySnapshot extends HeartbeatRunTimeoutPolicy {
  version: 1;
  runId: string;
  adapterType: string;
}

// This key lives only in the server-owned runner profile, never wake/result JSON.
export const HEARTBEAT_EXECUTION_TIMEOUT_POLICY_KEY = "executionTimeoutPolicy";

export function readHeartbeatRunTimeoutPolicySnapshot(run: {
  id: string;
  runnerProfileJson?: Record<string, unknown> | null;
}): HeartbeatRunTimeoutPolicy | null {
  const value = run.runnerProfileJson?.[HEARTBEAT_EXECUTION_TIMEOUT_POLICY_KEY];
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const snapshot = value as Record<string, unknown>;
  const seconds = snapshot.effectiveTimeoutSec;
  const milliseconds = snapshot.effectiveTimeoutMs;
  if (snapshot.version !== 1 || snapshot.runId !== run.id ||
    typeof snapshot.adapterType !== "string" || !snapshot.adapterType ||
    typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0 ||
    snapshot.timeoutConfigured !== (seconds > 0) ||
    (snapshot.timeoutSource !== "config" && snapshot.timeoutSource !== "default") ||
    (milliseconds !== undefined && (typeof milliseconds !== "number" || !Number.isFinite(milliseconds) ||
      milliseconds < 0 || milliseconds / 1000 !== seconds))) return null;
  return {
    effectiveTimeoutSec: seconds,
    timeoutConfigured: seconds > 0,
    timeoutSource: snapshot.timeoutSource,
    ...(typeof milliseconds === "number" ? { effectiveTimeoutMs: milliseconds } : {}),
  };
}

function readFiniteNumber(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }
  if (typeof value === "string") {
    const parsed = Number(value.trim());
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function hasOwn(record: Record<string, unknown>, key: string) {
  return Object.prototype.hasOwnProperty.call(record, key);
}

function defaultTimeoutSecForAdapter(adapterType: string) {
  return adapterType === "openclaw_gateway" ? 120 : 0;
}

export function normalizeMaxTurnStopReason(value: unknown): Extract<HeartbeatRunStopReason, "max_turns_exhausted"> | null {
  return value === "max_turns_exhausted" || value === "turn_limit_exhausted"
    ? "max_turns_exhausted"
    : null;
}

export function resolveHeartbeatRunTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown> | null | undefined,
): HeartbeatRunTimeoutPolicy {
  const config = adapterConfig ?? {};

  if (adapterType === "http") {
    const hasTimeoutMs = hasOwn(config, "timeoutMs");
    const rawTimeoutMs = hasTimeoutMs ? readFiniteNumber(config.timeoutMs) : 0;
    const timeoutMs = Math.max(0, Math.floor(rawTimeoutMs ?? 0));
    return {
      effectiveTimeoutSec: timeoutMs / 1000,
      effectiveTimeoutMs: timeoutMs,
      timeoutConfigured: timeoutMs > 0,
      timeoutSource: hasTimeoutMs ? "config" : "default",
    };
  }

  const hasTimeoutSec = hasOwn(config, "timeoutSec");
  const defaultTimeoutSec = defaultTimeoutSecForAdapter(adapterType);
  const rawTimeoutSec = hasTimeoutSec ? readFiniteNumber(config.timeoutSec) : defaultTimeoutSec;
  const timeoutSec = Math.max(0, Math.floor(rawTimeoutSec ?? defaultTimeoutSec));

  return {
    effectiveTimeoutSec: timeoutSec,
    timeoutConfigured: timeoutSec > 0,
    timeoutSource: hasTimeoutSec ? "config" : "default",
  };
}

/** Resolve only timer semantics proved by core dispatch/adapter source. */
export function resolveHeartbeatRunExecutionTimeoutPolicy(
  adapterType: string,
  adapterConfig: Record<string, unknown>,
  options: { nativeTurnTimeoutMs?: number; sandboxTarget?: boolean } = {},
): HeartbeatRunTimeoutPolicy | null {
  const timeoutSource = hasOwn(adapterConfig, adapterType === "http" ? "timeoutMs" : "timeoutSec")
    ? "config" : "default";
  if (options.nativeTurnTimeoutMs !== undefined || adapterType === "http") {
    const milliseconds = options.nativeTurnTimeoutMs ?? Math.max(0, readFiniteNumber(adapterConfig.timeoutMs) ?? 0);
    return { effectiveTimeoutSec: milliseconds / 1000, effectiveTimeoutMs: milliseconds,
      timeoutConfigured: milliseconds > 0, timeoutSource };
  }
  if (adapterType === "openclaw_gateway") return resolveHeartbeatRunTimeoutPolicy(adapterType, adapterConfig);
  const seconds = readFiniteNumber(adapterConfig.timeoutSec) ?? 0;
  const knownLocalDefault = ["process", "codex_local", "claude_local", "cursor", "cursor_local",
    "gemini_local", "grok_local", "kimi_local", "opencode_local", "pi_local"].includes(adapterType);
  // Plugin/Hermes and sandbox-target fallback timers are adapter-specific.
  // An absent/zero config does not prove those executions were unlimited.
  if (seconds <= 0 && (!knownLocalDefault || (options.sandboxTarget && adapterType !== "process" && seconds === 0))) return null;
  return { effectiveTimeoutSec: Math.max(0, seconds), timeoutConfigured: seconds > 0, timeoutSource };
}

export function inferHeartbeatRunStopReason(input: {
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
}): HeartbeatRunStopReason {
  if (input.outcome === "succeeded") return "completed";
  if (input.outcome === "interrupted") return "interrupted";
  const maxTurnStopReason = normalizeMaxTurnStopReason(input.errorCode);
  if (maxTurnStopReason) return maxTurnStopReason;
  if (input.outcome === "timed_out") return "timeout";
  if (input.outcome === "failed" && input.errorCode === "unmanaged_background_task_stopped") return "unmanaged_background_task_stopped";
  if (input.outcome === "failed" && input.errorCode === "process_lost") return "process_lost";
  if (input.outcome === "cancelled") {
    const message = (input.errorMessage ?? "").toLowerCase();
    if (message.includes("budget")) return "budget_paused";
    if (message.includes("pause") || message.includes("paused")) return "paused";
    return "cancelled";
  }
  return "adapter_failed";
}

export function buildHeartbeatRunStopMetadata(input: {
  adapterType: string;
  adapterConfig: Record<string, unknown> | null | undefined;
  outcome: HeartbeatRunOutcome;
  errorCode?: string | null;
  errorMessage?: string | null;
  // Explicit null means no durable execution evidence; do not infer from a
  // mutable saved config. Omission keeps the standalone builder compatible.
  timeoutPolicy?: HeartbeatRunTimeoutPolicy | null;
}): HeartbeatRunStopMetadata {
  const timeoutPolicy = input.timeoutPolicy === undefined
    ? resolveHeartbeatRunTimeoutPolicy(input.adapterType, input.adapterConfig)
    : input.timeoutPolicy ?? { effectiveTimeoutSec: null, timeoutConfigured: false, timeoutSource: "unknown" as const };
  const stopReason = inferHeartbeatRunStopReason(input);
  return {
    ...timeoutPolicy,
    stopReason,
    timeoutFired: stopReason === "timeout",
  };
}

export function mergeHeartbeatRunStopMetadata(
  resultJson: Record<string, unknown> | null | undefined,
  metadata: HeartbeatRunStopMetadata,
): Record<string, unknown> {
  const existingMaxTurnStopReason = normalizeMaxTurnStopReason(resultJson?.stopReason);
  const result = { ...(resultJson ?? {}) };
  // Adapter/caller timeout fields cannot survive without matching server evidence.
  delete result.effectiveTimeoutMs;
  delete result[HEARTBEAT_EXECUTION_TIMEOUT_POLICY_KEY];
  return {
    ...result,
    stopReason: existingMaxTurnStopReason ?? metadata.stopReason,
    effectiveTimeoutSec: metadata.effectiveTimeoutSec,
    timeoutConfigured: metadata.timeoutConfigured,
    timeoutSource: metadata.timeoutSource,
    timeoutFired: metadata.timeoutFired,
    ...(metadata.effectiveTimeoutMs != null ? { effectiveTimeoutMs: metadata.effectiveTimeoutMs } : {}),
  };
}
