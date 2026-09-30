import { and, eq } from "drizzle-orm";
import { agents, environments, heartbeatRuns, instanceSettings, issues, projects, type Db } from "@paperclipai/db";
import { aiConnectionBindingSchema, type AdapterEnvironmentTestResult } from "@paperclipai/shared";
import { requireServerAdapter } from "../adapters/index.js";
import { secretService } from "./secrets.js";
import { AI_AUTH_ENV_KEYS, assertManagedAiProjectAuth, prepareManagedAiRuntime } from "./ai-connection-runtime.js";
import { record } from "./agent-quota-fallback-policy.js";

type AgentRow = typeof agents.$inferSelect;
type ProbeOptions = { sourceRunId?: string | null; isolatedBackupAuth?: boolean };

function authEnvironment(value: unknown) {
  const allowed = new Set<string>([...AI_AUTH_ENV_KEYS, "ANTHROPIC_MODEL", "MINIMAX_API_KEY", "GEMINI_API_KEY"]);
  return Object.fromEntries(Object.entries(record(value)).filter(([key]) => allowed.has(key)));
}

/** Same configured local credentials/model; no task JWT or coding run is created. */
export async function probeQuotaModel(db: Db, agent: AgentRow, responsibleUserId: string | null, options: ProbeOptions = {}): Promise<AdapterEnvironmentTestResult> {
  const unsupported = (message: string): AdapterEnvironmentTestResult => ({ adapterType: agent.adapterType, status: "fail", testedAt: new Date().toISOString(), checks: [{ code: "quota_probe_environment_unsupported", level: "error", message }] });
  const [settings] = await db.select({ general: instanceSettings.general, experimental: instanceSettings.experimental, defaultEnvironmentId: instanceSettings.defaultEnvironmentId }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  if (record(settings?.general).executionMode === "kubernetes" || record(settings?.experimental).enableManagedSandboxOnly === true) return unsupported("Quota recovery probes require an instance that permits local CLI execution.");
  const environmentId = agent.defaultEnvironmentId ?? settings?.defaultEnvironmentId;
  const environment = await db.select().from(environments).where(environmentId ? eq(environments.id, environmentId) : eq(environments.driver, "local")).limit(1).then(rows => rows[0] ?? null);
  if ((environmentId && !environment) || (environment && (environment.driver !== "local" || environment.status !== "active"))) return unsupported("Quota recovery probes cannot verify a remote or inactive runtime by calling a different host account.");

  const binding = agent.runtimeConfig.aiConnection ? aiConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : undefined;
  const secrets = secretService(db);
  const context = { actorType: "system" as const, actorId: "quota_model_probe", responsibleUserId };
  let baseEnv: Record<string, string> = {};
  let projectEnv: Record<string, string> = {};
  if (!binding && !options.isolatedBackupAuth && environment) {
    baseEnv = (await secrets.resolveEnvBindings(agent.companyId, authEnvironment(environment.envVars), { ...context, consumerType: "environment", consumerId: environment.id })).env;
  }
  if (!options.isolatedBackupAuth && options.sourceRunId) {
    const [source] = await db.select({ context: heartbeatRuns.contextSnapshot }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, options.sourceRunId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).limit(1);
    const sourceContext = record(source?.context);
    const issueId = typeof sourceContext.issueId === "string" ? sourceContext.issueId : null;
    const [issue] = issueId ? await db.select({ projectId: issues.projectId, originKind: issues.originKind, adapterOverrides: issues.assigneeAdapterOverrides, executionPolicy: issues.executionPolicy }).from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId))).limit(1) : [];
    // Never establish primary recovery using a different account/model from
    // an issue override or a routine revision we have not reproduced here.
    if ((!binding && issue?.originKind === "routine_execution") || Object.keys(record(record(issue?.adapterOverrides).adapterConfig)).length > 0 || Object.keys(record(issue?.executionPolicy)).length > 0) return unsupported("This task has a routine, adapter or execution-policy override. Primary availability cannot be established by a host-only probe.");
    const projectId = issue?.projectId ?? (typeof sourceContext.projectId === "string" ? sourceContext.projectId : null);
    const [project] = projectId ? await db.select({ id: projects.id, env: projects.env }).from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, agent.companyId))).limit(1) : [];
    if (project && !binding) projectEnv = (await secrets.resolveEnvBindings(agent.companyId, authEnvironment(project.env), { ...context, consumerType: "project", consumerId: project.id })).env;
  }
  const configForProbe: Record<string, unknown> = { ...agent.adapterConfig, engine: "cli", env: binding || options.isolatedBackupAuth ? {} : authEnvironment(agent.adapterConfig.env), helloProbeTimeoutSec: 45 };
  delete configForProbe.instructionsFilePath;
  const resolved = await secrets.resolveAdapterConfigForRuntime(agent.companyId, configForProbe,
    { ...context, consumerType: "agent", consumerId: agent.id }, { adapterType: agent.adapterType });
  resolved.config.env = { ...baseEnv, ...record(resolved.config.env), ...projectEnv };
  let managed: Awaited<ReturnType<typeof prepareManagedAiRuntime>> | undefined;
  try {
    if (binding) {
      await assertManagedAiProjectAuth(resolved.config, binding.provider);
      managed = await prepareManagedAiRuntime(db, { companyId: agent.companyId, agentId: agent.id, responsibleUserId, adapterType: agent.adapterType, binding, config: resolved.config });
    }
    return await requireServerAdapter(agent.adapterType).testEnvironment({ companyId: agent.companyId, adapterType: agent.adapterType, config: managed?.config ?? resolved.config });
  } finally { await managed?.cleanup(); }
}

export function quotaProbeAvailable(result: AdapterEnvironmentTestResult): boolean {
  return !result.checks.some(check => check.level === "error") && result.checks.some(check => check.code === "claude_hello_probe_passed" || check.code === "codex_hello_probe_passed");
}
