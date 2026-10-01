import { createHash } from "node:crypto";
import { agentQuotaFallbackConfigSchema, type AgentQuotaFallbackConfig, type QuotaFallbackBackup } from "@paperclipai/shared";
import { AI_AUTH_ENV_KEYS } from "./ai-connection-runtime.js";

export interface QuotaFallbackAgent {
  id: string;
  companyId: string;
  adapterType: string;
  adapterConfig: Record<string, unknown>;
  runtimeConfig: Record<string, unknown>;
  metadata: Record<string, unknown> | null;
  defaultEnvironmentId?: string | null;
}

export interface QuotaFallbackScope {
  usingBackup: boolean;
  lastQuotaAt: string | null;
  primaryQuotaRunId: string | null;
  backupQuotaRunId: string | null;
  lastPrimaryCheckAt: string | null;
  lastPrimaryCheckResult: "available" | "unavailable" | "busy" | "error" | null;
  nextPrimaryCheckAt: string | null;
  probeUntil: string | null;
  probeGroup: string | null;
  probeToken: string | null;
  probeFingerprint: string | null;
  recoveryToken: string | null;
  recoveryAt: string | null;
  primaryCheckIntervalSec: number | null;
}

export interface QuotaFallbackBook {
  version: 1;
  fingerprint: string;
  scopes: Record<string, QuotaFallbackScope>;
}

export interface QuotaFallbackPin {
  version: 1;
  fingerprint: string;
  usingBackup: boolean;
  primaryAdapterType: string;
  adapterType: string;
  model: string | null;
}

export const QUOTA_FALLBACK_METADATA_KEY = "quotaFallbackState";
export const QUOTA_PROBE_LEASE_MS = 120_000;
export const quotaScopeKey = (responsibleUserId: string | null) => responsibleUserId ?? "__unattributed__";

export function quotaFallbackPolicy(agent: QuotaFallbackAgent): AgentQuotaFallbackConfig | null {
  if (!["claude_local", "codex_local"].includes(agent.adapterType)) return null;
  const parsed = agentQuotaFallbackConfigSchema.safeParse(agent.runtimeConfig.quotaFallback);
  return parsed.success && parsed.data.enabled && parsed.data.backup ? parsed.data : null;
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}

export function quotaFallbackFingerprint(agent: QuotaFallbackAgent): string {
  const policy = quotaFallbackPolicy(agent);
  return createHash("sha256").update(canonical({ adapterType: agent.adapterType, adapterConfig: agent.adapterConfig, aiConnection: agent.runtimeConfig.aiConnection, policy: policy ? { enabled: true, backup: policy.backup } : null, environmentId: agent.defaultEnvironmentId, group: record(agent.runtimeConfig.heartbeat).concurrencyGroup })).digest("hex");
}

export function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export function quotaFallbackBook(agent: QuotaFallbackAgent): QuotaFallbackBook {
  const fingerprint = quotaFallbackFingerprint(agent);
  const value = record(agent.metadata?.[QUOTA_FALLBACK_METADATA_KEY]);
  if (value.version !== 1) return { version: 1, fingerprint, scopes: {} };
  const policy = quotaFallbackPolicy(agent);
  const scopes: Record<string, QuotaFallbackScope> = {};
  for (const [key, raw] of Object.entries(record(value.scopes))) {
    const scope = record(raw);
    if (value.fingerprint === fingerprint && typeof scope.usingBackup === "boolean") {
      scopes[key] = { ...initialQuotaScope(), ...scope } as QuotaFallbackScope;
      const current = scopes[key]!;
      if (policy && current.usingBackup) {
        const anchor = current.lastPrimaryCheckAt ?? current.lastQuotaAt;
        if (!policy.recoveryEnabled) current.nextPrimaryCheckAt = null;
        else if ((current.primaryCheckIntervalSec !== policy.primaryCheckIntervalSec || !current.nextPrimaryCheckAt) && anchor) current.nextPrimaryCheckAt = new Date(Date.parse(anchor) + policy.primaryCheckIntervalSec * 1000).toISOString();
        current.primaryCheckIntervalSec = policy.primaryCheckIntervalSec;
      }
    } else if (typeof scope.probeToken === "string" && typeof scope.probeUntil === "string") {
      // A config edit invalidates routing but cannot release a still-running
      // old probe's provider slot. Its result will only release this lease.
      scopes[key] = { ...initialQuotaScope(), probeToken: scope.probeToken, probeUntil: scope.probeUntil, probeGroup: typeof scope.probeGroup === "string" ? scope.probeGroup : null, probeFingerprint: typeof scope.probeFingerprint === "string" ? scope.probeFingerprint : null };
    }
  }
  return { version: 1, fingerprint, scopes };
}

export function initialQuotaScope(): QuotaFallbackScope {
  return { usingBackup: false, lastQuotaAt: null, primaryQuotaRunId: null, backupQuotaRunId: null, lastPrimaryCheckAt: null, lastPrimaryCheckResult: null, nextPrimaryCheckAt: null, probeUntil: null, probeGroup: null, probeToken: null, probeFingerprint: null, recoveryToken: null, recoveryAt: null, primaryCheckIntervalSec: null };
}

const sharedConfigKeys = ["cwd", "instructionsFilePath", "promptTemplate", "bootstrapPrompt", "timeoutSec", "graceSec", "env", "paperclipRuntimeSkills", "mcpServers", "mcpServerBindings"];

export function stripQuotaAuthEnvironment(value: unknown): Record<string, unknown> {
  const env = { ...record(value) };
  for (const key of [...AI_AUTH_ENV_KEYS, "ANTHROPIC_MODEL", "MINIMAX_API_KEY", "GEMINI_API_KEY"]) delete env[key];
  return env;
}

export function quotaBackupSharedOverrides(value: unknown): Record<string, unknown> {
  const source = record(value);
  const shared = Object.fromEntries(sharedConfigKeys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));
  if (shared.env) shared.env = stripQuotaAuthEnvironment(shared.env);
  return shared;
}

export function buildQuotaBackupConfig(primary: QuotaFallbackAgent, backup: QuotaFallbackBackup): Record<string, unknown> {
  const config = quotaBackupSharedOverrides(primary.adapterConfig);
  config.env = stripQuotaAuthEnvironment(config.env);
  return {
    ...config,
    model: backup.model,
    ...(backup.thinkingEffort ? { thinkingEffort: backup.thinkingEffort, effort: backup.thinkingEffort } : {}),
    engine: primary.adapterConfig.engine === "acp" ? "acp" : "cli",
    ...(backup.adapterType === "codex_local" ? { dangerouslyBypassSandbox: true, fastMode: backup.fastMode === true } : { dangerouslySkipPermissions: true, permissionMode: "approve-all" }),
  };
}

export function selectQuotaFallbackAgent<T extends QuotaFallbackAgent>(primary: T, responsibleUserId: string | null, pinned?: QuotaFallbackPin | null): { agent: T; pin: QuotaFallbackPin | null } {
  const policy = quotaFallbackPolicy(primary);
  if (!policy && !pinned) return { agent: primary, pin: null };
  const fingerprint = quotaFallbackFingerprint(primary);
  if (pinned && pinned.fingerprint !== fingerprint) throw new Error("Quota fallback configuration changed during startup; start a new turn with the updated configuration");
  const usingBackup = !!policy?.backup && (pinned?.usingBackup ?? quotaFallbackBook(primary).scopes[quotaScopeKey(responsibleUserId)]?.usingBackup ?? false);
  const backup = policy?.backup;
  const group = backup?.concurrencyGroup ?? (backup?.adapterType === "claude_local" && /^minimax/i.test(backup.model) ? "minimax" : "");
  const agent = usingBackup && backup ? {
    ...primary,
    adapterType: backup.adapterType,
    adapterConfig: buildQuotaBackupConfig(primary, backup),
    runtimeConfig: { ...primary.runtimeConfig, aiConnection: backup.aiConnection, heartbeat: { ...record(primary.runtimeConfig.heartbeat), concurrencyGroup: group } },
  } : primary;
  return { agent: agent as T, pin: { version: 1, fingerprint, usingBackup, primaryAdapterType: primary.adapterType, adapterType: agent.adapterType, model: typeof agent.adapterConfig.model === "string" ? agent.adapterConfig.model : null } };
}

export function readQuotaFallbackPin(value: unknown): QuotaFallbackPin | null {
  const pin = record(value);
  return pin.version === 1 && typeof pin.fingerprint === "string" && typeof pin.usingBackup === "boolean" && typeof pin.primaryAdapterType === "string" && typeof pin.adapterType === "string" ? pin as unknown as QuotaFallbackPin : null;
}

export function activeQuotaProbeReservations(metadata: unknown, now: Date): Array<{ group: string | null }> {
  const scopes = record(record(record(metadata)[QUOTA_FALLBACK_METADATA_KEY]).scopes);
  return Object.values(scopes).flatMap(raw => {
    const scope = record(raw);
    const until = typeof scope.probeUntil === "string" ? Date.parse(scope.probeUntil) : NaN;
    return until > now.getTime() && until <= now.getTime() + QUOTA_PROBE_LEASE_MS && typeof scope.probeToken === "string" ? [{ group: typeof scope.probeGroup === "string" && scope.probeGroup ? scope.probeGroup : null }] : [];
  });
}
