import { loadQuotaProbeContext } from "./quota-probe-identity.js";
import { agents, type Db } from "@paperclipai/db";
import { aiConnectionBindingSchema, type AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { requireServerAdapter } from "../adapters/index.js";
import { secretService } from "./secrets.js";
import { AI_AUTH_ENV_KEYS, assertManagedAiProjectAuth, prepareManagedAiRuntime } from "./ai-connection-runtime.js";
import { record } from "./agent-quota-fallback-policy.js";

type AgentRow = typeof agents.$inferSelect;
type ProbeOptions = { sourceRunId?: string | null; isolatedBackupAuth?: boolean; signal?: AbortSignal };

function authEnvironment(value: unknown) {
  const allowed = new Set<string>([...AI_AUTH_ENV_KEYS, "ANTHROPIC_MODEL", "MINIMAX_API_KEY", "GEMINI_API_KEY"]);
  return Object.fromEntries(Object.entries(record(value)).filter(([key]) => allowed.has(key)));
}

/** Same configured local credentials/model; no task JWT or coding run is created. */
export async function probeQuotaModel(db: Db, agent: AgentRow, responsibleUserId: string | null, options: ProbeOptions = {}): Promise<AdapterEnvironmentTestResult> {
  const unsupported = (message: string): AdapterEnvironmentTestResult => ({ adapterType: agent.adapterType, status: "fail", testedAt: new Date().toISOString(), checks: [{ code: "quota_probe_environment_unsupported", level: "error", message }] });
  if (options.signal?.aborted) return unsupported("Quota recovery probe was cancelled before execution.");
  // The current ACP environment tester checks authentication/scaffold only;
  // it does not perform a harmless hello on the execution path.
  if (agent.adapterConfig.engine === "acp") return unsupported("Exact ACP hello probing is unavailable. CLI readiness cannot certify ACP execution.");
  let effective: Awaited<ReturnType<typeof loadQuotaProbeContext>>;
  try { effective = await loadQuotaProbeContext(db, agent, responsibleUserId, options.sourceRunId ?? null); }
  catch { return unsupported("This task's effective execution scope could not be reproduced safely."); }
  const { settings, environmentId, environment } = effective;
  if (effective.config.engine === "acp") return unsupported("Exact ACP hello probing is unavailable. CLI readiness cannot certify ACP execution.");
  if (record(settings?.general).executionMode === "kubernetes" || record(settings?.experimental).enableManagedSandboxOnly === true) return unsupported("Quota recovery probes require an instance that permits local CLI execution.");
  if ((environmentId && !environment) || (environment && (environment.driver !== "local" || environment.status !== "active"))) return unsupported("Quota recovery probes cannot verify a remote or inactive runtime by calling a different host account.");

  const binding = agent.runtimeConfig.aiConnection ? aiConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
  const secrets = secretService(db);
  const context = { actorType: "system" as const, actorId: "quota_model_probe", responsibleUserId };
  let baseEnv: Record<string, string> = {};
  let projectEnv: Record<string, string> = {};
  if (!binding && !options.isolatedBackupAuth && environment) {
    baseEnv = (await secrets.resolveEnvBindings(agent.companyId, authEnvironment(environment.envVars), { ...context, consumerType: "environment", consumerId: environment.id })).env;
  }
  if (!binding && !options.isolatedBackupAuth && effective.project) projectEnv = (await secrets.resolveEnvBindings(agent.companyId, authEnvironment(effective.project.env), { ...context, consumerType: "project", consumerId: effective.project.id })).env;
  const routineEnv = !binding && !options.isolatedBackupAuth && effective.routineId
    ? (await secrets.resolveEnvBindings(agent.companyId, authEnvironment(effective.routineEnv), { ...context, consumerType: "routine", consumerId: effective.routineId })).env : {};
  const configForProbe: Record<string, unknown> = { ...effective.config, env: binding || options.isolatedBackupAuth ? {} : authEnvironment(effective.config.env), helloProbeTimeoutSec: 45 };
  delete configForProbe.instructionsFilePath;
  const resolved = await secrets.resolveAdapterConfigForRuntime(agent.companyId, configForProbe,
    { ...context, consumerType: "agent", consumerId: agent.id }, { adapterType: agent.adapterType });
  resolved.config.env = { ...baseEnv, ...record(resolved.config.env), ...projectEnv, ...routineEnv };
  let managed: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
  try {
    if (binding) {
      await assertManagedAiProjectAuth(resolved.config, binding.provider);
      managed = await prepareManagedAiRuntime(db, { companyId: agent.companyId, agentId: agent.id, responsibleUserId, adapterType: agent.adapterType, binding, config: resolved.config });
    }
    options.signal?.throwIfAborted();
    return await requireServerAdapter(agent.adapterType).testEnvironment({ companyId: agent.companyId, adapterType: agent.adapterType, config: managed?.config ?? resolved.config, signal: options.signal });
  } finally { await managed?.cleanup(); }
}

export function quotaProbeAvailable(result: AdapterEnvironmentTestResult): boolean {
  return !result.checks.some(check => check.level === "error") && result.checks.some(check => check.code === "claude_hello_probe_passed" || check.code === "codex_hello_probe_passed");
}
