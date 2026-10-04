import { AGENT_DEFAULT_MAX_CONCURRENT_RUNS, type AgentSafetyPreset, type AgentQuotaFallbackConfig } from "@paperclipai/shared";
import { defaultCreateValues } from "../components/agent-config-defaults";

export function buildNewAgentRuntimeConfig(input?: {
  safetyPreset?: AgentSafetyPreset;
  heartbeatEnabled?: boolean;
  intervalSec?: number;
  quotaFallback?: AgentQuotaFallbackConfig;
}): Record<string, unknown> {
  const config: Record<string, unknown> = {
    ...(input?.safetyPreset ? { safetyPreset: input.safetyPreset } : {}),
    ...(input?.quotaFallback ? { quotaFallback: input.quotaFallback } : {}),
    heartbeat: {
      enabled: input?.heartbeatEnabled ?? defaultCreateValues.heartbeatEnabled,
      intervalSec: input?.intervalSec ?? defaultCreateValues.intervalSec,
      wakeOnDemand: true,
      skipTimerWhenNoActionableWork: true,
      cooldownSec: 10,
      maxConcurrentRuns: AGENT_DEFAULT_MAX_CONCURRENT_RUNS,
    },
  };

  return config;
}
