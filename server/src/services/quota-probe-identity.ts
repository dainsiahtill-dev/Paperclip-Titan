import { quotaNativeConfigIdentity } from "./quota-probe-native-config.js";
import { createHash } from "node:crypto";
import { and, eq, inArray, or } from "drizzle-orm";
import { companySecrets, environments, heartbeatRuns, instanceSettings, issues, projects, routineRevisions, routineRuns, routines, userSecretDefinitions, type Db } from "@paperclipai/db";
import { aiConnectionBindingSchema } from "@paperclipai/shared";
import { aiConnectionService } from "./ai-connections.js";
import { record, type QuotaFallbackAgent } from "./agent-quota-fallback-policy.js";

export interface QuotaProbeIdentity {
  version: 1; companyId: string; agentId: string; responsibleUserId: string | null;
  sourceRunId: string | null; effectiveFingerprint: string;
}
function canonical(value: unknown): string {
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, item]) => item !== undefined).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  return JSON.stringify(value) ?? "null";
}
/** Only a digest leaves this function. Source IDs are provenance, not authority. */
export function quotaProbeFingerprint(context: unknown): string {
  return createHash("sha256").update(canonical(context)).digest("hex");
}

/** Same env precedence as execution: environment, Agent/issue, project, routine revision. */
export async function loadQuotaProbeContext(db: Db, agent: QuotaFallbackAgent, user: string | null, sourceRunId: string | null) {
  const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  const [source] = sourceRunId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, sourceRunId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).limit(1) : [];
  if (sourceRunId && (!source || (source.responsibleUserId !== null && source.responsibleUserId !== user))) throw new Error("quota_probe_source_scope_unknown");
  const sourceContext = record(source?.contextSnapshot);
  const issueId = typeof sourceContext.issueId === "string" ? sourceContext.issueId : null;
  const [issue] = issueId ? await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, agent.companyId))).limit(1) : [];
  if (issueId && !issue) throw new Error("quota_probe_issue_scope_unknown");
  // Execution policies can select a different environment/trust boundary.
  // Unknown policy overlays cannot be certified by a local host request.
  if (Object.keys(record(issue?.executionPolicy)).length > 0) throw new Error("quota_probe_execution_policy_unsupported");
  const overrides = record(issue?.assigneeAdapterOverrides);
  const config = { ...agent.adapterConfig, ...record(overrides.adapterConfig) };
  const environmentId = typeof overrides.environmentId === "string" ? overrides.environmentId : agent.defaultEnvironmentId ?? settings?.defaultEnvironmentId;
  const [environment] = await db.select().from(environments).where(environmentId ? eq(environments.id, environmentId) : eq(environments.driver, "local")).limit(1);
  const projectId = issue?.projectId ?? (typeof sourceContext.projectId === "string" ? sourceContext.projectId : null);
  const [project] = projectId ? await db.select().from(projects).where(and(eq(projects.id, projectId), eq(projects.companyId, agent.companyId))).limit(1) : [];
  if (projectId && !project) throw new Error("quota_probe_project_scope_unknown");
  let routineId: string | null = null, routineRevisionId: string | null = null, routineEnv: unknown = null;
  if (issue?.originKind === "routine_execution" && issue.originId) {
    routineId = issue.originId;
    const [dispatch] = issue.originRunId ? await db.select().from(routineRuns).where(and(eq(routineRuns.id, issue.originRunId), eq(routineRuns.companyId, agent.companyId), eq(routineRuns.routineId, routineId))).limit(1) : [];
    routineRevisionId = dispatch?.routineRevisionId ?? null;
    if (routineRevisionId) {
      const [revision] = await db.select().from(routineRevisions).where(and(eq(routineRevisions.id, routineRevisionId), eq(routineRevisions.companyId, agent.companyId), eq(routineRevisions.routineId, routineId))).limit(1);
      if (record(revision?.snapshot).version !== 1) throw new Error("quota_probe_routine_revision_unknown");
      routineEnv = record(record(revision?.snapshot).routine).env;
    } else {
      const [routine] = await db.select().from(routines).where(and(eq(routines.id, routineId), eq(routines.companyId, agent.companyId))).limit(1);
      if (!routine) throw new Error("quota_probe_routine_scope_unknown");
      routineEnv = routine.env;
    }
  }
  return { settings, config, environmentId, environment, project, routineId, routineRevisionId, routineEnv };
}

export async function deriveQuotaProbeIdentity(db: Db, agent: QuotaFallbackAgent, responsibleUserId: string | null, sourceRunId: string | null): Promise<QuotaProbeIdentity> {
  const context = await loadQuotaProbeContext(db, agent, responsibleUserId, sourceRunId);
  const binding = agent.runtimeConfig.aiConnection ? aiConnectionBindingSchema.parse(agent.runtimeConfig.aiConnection) : null;
  let managedIdentity: unknown = null;
  if (binding) {
    const selection = await aiConnectionService(db).select({ companyId: agent.companyId, agentId: agent.id, userId: responsibleUserId, adapterType: agent.adapterType, model: context.config.model, runnerProvider: context.config.provider, acpxAgent: context.config.acpxAgent, binding });
    managedIdentity = { attribution: selection.attribution, grantId: selection.grant.id, revision: selection.grant.updatedAt, credentialRefs: selection.grant.credentialSecretRefs, connectionRevision: selection.connection.updatedAt };
  }
  const nativeConfig = binding ? null : await quotaNativeConfigIdentity(agent.adapterType, { ...record(context.environment?.envVars), ...record(context.config.env), ...record(context.project?.env), ...record(context.routineEnv) }, context.config.cwd);
  const inputs = [context.config, binding ? null : context.environment?.envVars, binding ? null : context.project?.env, binding ? null : context.routineEnv, managedIdentity];
  const secretIds = new Set<string>(), definitionIds = new Set<string>(), definitionKeys = new Set<string>();
  const collect = (value: unknown) => {
    if (!value || typeof value !== "object") return;
    const entry = record(value);
    if (typeof entry.secretId === "string") secretIds.add(entry.secretId);
    if (entry.type === "user_secret_ref" && typeof entry.key === "string") definitionKeys.add(entry.key);
    for (const child of Object.values(value)) collect(child);
  };
  for (const input of inputs) collect(input);
  if (definitionKeys.size) {
    const definitions = await db.select({ id: userSecretDefinitions.id }).from(userSecretDefinitions).where(and(eq(userSecretDefinitions.companyId, agent.companyId), inArray(userSecretDefinitions.key, [...definitionKeys])));
    if (definitions.length !== definitionKeys.size || !responsibleUserId) throw new Error("quota_probe_user_secret_scope_unknown");
    for (const definition of definitions) definitionIds.add(definition.id);
  }
  const versions = secretIds.size || definitionIds.size ? await db.select({ id: companySecrets.id, latestVersion: companySecrets.latestVersion, updatedAt: companySecrets.updatedAt, ownerUserId: companySecrets.ownerUserId, definitionId: companySecrets.userSecretDefinitionId }).from(companySecrets).where(and(eq(companySecrets.companyId, agent.companyId), or(secretIds.size ? inArray(companySecrets.id, [...secretIds]) : undefined, definitionIds.size ? and(inArray(companySecrets.userSecretDefinitionId, [...definitionIds]), responsibleUserId ? eq(companySecrets.ownerUserId, responsibleUserId) : undefined) : undefined))).orderBy(companySecrets.id) : [];
  return { version: 1, companyId: agent.companyId, agentId: agent.id, responsibleUserId, sourceRunId, effectiveFingerprint: quotaProbeFingerprint({ companyId: agent.companyId, agentId: agent.id, responsibleUserId, adapterType: agent.adapterType, config: context.config, environmentId: context.environmentId ?? context.environment?.id ?? null, environmentRevision: context.environment?.updatedAt, executionMode: record(context.settings?.general).executionMode, managedOnly: record(context.settings?.experimental).enableManagedSandboxOnly, env: inputs.slice(1), routineRevisionId: context.routineRevisionId, nativeConfig, versions }) };
}
