/** Source-file launch constraints. Separate from API authorization and low-trust containment. */
export const AGENT_SAFETY_PRESETS = ["audit", "manager", "implementation", "testing"] as const;
export type AgentSafetyPreset = typeof AGENT_SAFETY_PRESETS[number];
function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
export function agentSafetyPreset(runtimeConfig: unknown): AgentSafetyPreset | null {
  const value = record(runtimeConfig).safetyPreset;
  if (value == null) return null;
  if (!AGENT_SAFETY_PRESETS.includes(value as AgentSafetyPreset)) throw new Error("Unsupported agent safety preset");
  return value as AgentSafetyPreset;
}
export function assertAgentSafetyPresetTransition(previous: unknown, next: unknown, boardAuthorized: boolean): void {
  if (agentSafetyPreset(previous) !== agentSafetyPreset(next) && !boardAuthorized) {
    throw new Error("Board agents:configure authority is required to change the safety preset");
  }
}
export function enforceAgentSafetyPreset(adapterType: string, savedRuntimeConfig: unknown, effectiveConfig: Record<string, unknown>): Record<string, unknown> {
  if (agentSafetyPreset(savedRuntimeConfig) !== "audit") return effectiveConfig;
  const fail = (reason: string): never => { throw new Error(`Audit read-only source constraint: ${reason}`); };
  if (adapterType !== "codex_local") fail("only the Codex CLI profile is supported; native and other adapters are unsupported");
  if (effectiveConfig.engine !== "cli") fail("explicit CLI engine is required; auto/ACP fallback is unsupported");
  if (effectiveConfig.command != null && effectiveConfig.command !== "" && effectiveConfig.command !== "codex") fail("custom executable commands are unsupported");
  if (effectiveConfig.dangerouslyBypassApprovalsAndSandbox || effectiveConfig.dangerouslyBypassSandbox) fail("sandbox bypass is forbidden");
  if (effectiveConfig.sandboxMode != null && effectiveConfig.sandboxMode !== "read-only") fail("writable sandbox mode is forbidden");
  // Reject both aliases: an ignored legacy alias must never become an escalation on resume.
  for (const field of ["extraArgs", "args"]) {
    const args = effectiveConfig[field];
    if (args == null) continue;
    if (!Array.isArray(args) || args.some((arg) => typeof arg !== "string")) fail("extra arguments must be string arrays");
    for (const arg of args as string[]) {
      if (arg !== "--skip-git-repo-check") fail("permission/profile/config/command arguments are unsupported");
    }
  }
  for (const key of Object.keys(record(effectiveConfig.env))) {
    if (/^(PATH|LD_.*|DYLD_.*|NODE_OPTIONS|CODEX_(?!HOME$).*|BASH_ENV|ENV|SHELL|PYTHONPATH|PYTHONHOME)$/i.test(key)) fail("executable/home environment overrides are unsupported");
  }
  return { ...effectiveConfig, sandboxMode: "read-only", dangerouslyBypassApprovalsAndSandbox: false, dangerouslyBypassSandbox: false };
}
export function applyAgentSafetyPreset(adapterType: string, adapterConfig: Record<string, unknown>, runtimeConfig: Record<string, unknown>): { adapterConfig: Record<string, unknown>; runtimeConfig: Record<string, unknown> } {
  const preset = agentSafetyPreset(runtimeConfig);
  if (!preset) return { adapterConfig, runtimeConfig };
  const nextRuntime = { ...runtimeConfig, heartbeat: { maxConcurrentRuns: 1, ...record(runtimeConfig.heartbeat) } };
  const nextAdapter = adapterType === "codex_local" ? {
    ...(preset === "audit" ? { engine: "cli", sandboxMode: "read-only" } : {}),
    ...(typeof adapterConfig.dangerouslyBypassApprovalsAndSandbox === "boolean" || typeof adapterConfig.dangerouslyBypassSandbox === "boolean" ? {} : { dangerouslyBypassApprovalsAndSandbox: false }),
    ...adapterConfig,
  } : adapterConfig;
  const enforced = enforceAgentSafetyPreset(adapterType, nextRuntime, nextAdapter);
  // Keep only the modern creation key; the runtime validator checks both aliases.
  if (preset === "audit" && !("dangerouslyBypassSandbox" in adapterConfig)) delete enforced.dangerouslyBypassSandbox;
  return { adapterConfig: enforced, runtimeConfig: nextRuntime };
}
export function resolveAgentPresetWorkspaceConcurrency(runtimeConfig: unknown, resolved: "auto" | "serialize" | "allow"): "auto" | "serialize" | "allow" {
  const preset = agentSafetyPreset(runtimeConfig);
  return preset === "implementation" || preset === "testing" ? "serialize" : resolved;
}
