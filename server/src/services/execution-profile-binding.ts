import { and, eq, sql } from "drizzle-orm";
import { agents, environments, executionWorkspaces, heartbeatRuns, issues, projects, type Db } from "@paperclipai/db";
import { enforceAgentSafetyPreset } from "@paperclipai/shared";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { instanceSettingsService } from "./instance-settings.js";
import { readExecutionWorkspaceConfig } from "./execution-workspaces.js";
import { environmentService } from "./environments.js";
import { isExecutionForcedToKubernetes } from "./execution-allowlist.js";
import { resolveCoreTrustPreset } from "./trust-preset-resolver.js";
import { applyDefaultIsolatedExecutionWorkspacePolicy, buildExecutionWorkspaceAdapterConfig,
  gateProjectExecutionWorkspacePolicy, parseIssueExecutionWorkspaceSettings, parseProjectExecutionWorkspacePolicy,
  resolveExecutionWorkspaceEnvironmentId, resolveExecutionWorkspaceMode, ManagedSandboxUnavailableError } from "./execution-workspace-policy.js";

const object = (v: unknown): Record<string, unknown> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, unknown> : {};
export type ExecutionProfileBinding = { version: 1; fingerprint: string; environmentFingerprint: string; adapterConfigFingerprint: string; instanceFingerprint: string };
type ExecutionSettings = Awaited<ReturnType<ReturnType<typeof instanceSettingsService>["readExecutionSettings"]>>;
export function executionInstanceProfileFingerprint(settings: ExecutionSettings) {
  return nativeSha256({ defaultEnvironmentId: settings.defaultEnvironmentId, executionMode: settings.general.executionMode,
    managedSandboxOnly: settings.experimental.enableManagedSandboxOnly === true, nativeRunner: settings.experimental.enableNativeRunner,
    isolatedWorkspaces: settings.experimental.enableIsolatedWorkspaces,
    defaultIsolatedWorkspaces: settings.experimental.enableIsolatedWorkspaces && settings.experimental.enableIsolatedWorkspacesByDefault });
}
type EnvironmentInput = Pick<typeof environments.$inferSelect, "id" | "driver" | "status" | "config" | "envVars">;
export function executionEnvironmentFingerprint(environment: EnvironmentInput | null, selectedId: string | null) {
  // Only digests escape this module. Values are saved configuration/binding references;
  // resolving secrets, leases, remote targets or provider credentials is forbidden here.
  return nativeSha256(environment ? { id: environment.id, driver: environment.driver, status: environment.status,
    config: environment.config, envVars: environment.envVars } : { selectedId, unavailable: true });
}
export function readCapturedExecutionProfile(profile: unknown): ExecutionProfileBinding | null {
  const value = object(object(profile).executionProfileBinding);
  return value.version === 1 && [value.fingerprint, value.environmentFingerprint, value.adapterConfigFingerprint, value.instanceFingerprint]
    .every(v => typeof v === "string" && /^[a-f0-9]{64}$/.test(v)) ? value as ExecutionProfileBinding : null;
}

/** Read-only preview of the same selection and overlays used by dispatch. Never initializes rows. */
export async function readExecutionProfileBinding(db: Db, issue: typeof issues.$inferSelect | null,
  agent: typeof agents.$inferSelect, lock = false): Promise<ExecutionProfileBinding> {
  const settings = await instanceSettingsService(db).readExecutionSettings(lock);
  const envs = environmentService(db);
  const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
  const managedSandboxOnly = settings.experimental.enableManagedSandboxOnly === true;
  const managed = managedSandboxOnly ? await envs.findManagedSandboxEnvironment(agent.companyId) : null;
  const selection = (() => { try { return resolveExecutionWorkspaceEnvironmentId({ agentDefaultEnvironmentId: agent.defaultEnvironmentId,
    instanceDefaultEnvironmentId: settings.defaultEnvironmentId, localDefaultEnvironmentId: local?.id ?? "uninitialized-local",
    managedSandboxOnly, managedSandboxEnvironmentId: managed?.id ?? null });
  } catch (error) {
    if (!(error instanceof ManagedSandboxUnavailableError)) throw error;
    // An unavailable target is a distinct digest, never permission for local fallback.
    return { environmentId: null, source: "managed_unavailable" };
  } })();
  const executionPolicy = { executionMode: settings.general.executionMode, managedSandboxOnly };
  const forced = isExecutionForcedToKubernetes(executionPolicy);
  const kubernetes = forced ? await envs.findKubernetesEnvironment(agent.companyId) : null;
  const selectedId = forced ? kubernetes?.id ?? null : selection.environmentId;
  const selectedQuery = selectedId && selectedId !== "uninitialized-local" ? db.select().from(environments).where(eq(environments.id, selectedId)) : null;
  const [environment] = selectedQuery ? await (lock ? selectedQuery.for("share") : selectedQuery) : [];
  const projectQuery = issue?.projectId ? db.select().from(projects).where(and(eq(projects.companyId, agent.companyId), eq(projects.id, issue.projectId))) : null;
  const [project] = projectQuery ? await (lock ? projectQuery.for("share") : projectQuery) : [];
  const workspaceQuery = issue?.executionWorkspaceId ? db.select().from(executionWorkspaces)
    .where(and(eq(executionWorkspaces.companyId, agent.companyId), eq(executionWorkspaces.id, issue.executionWorkspaceId))) : null;
  const [workspace] = workspaceQuery ? await (lock ? workspaceQuery.for("share") : workspaceQuery) : [];
  const enabled = settings.experimental.enableIsolatedWorkspaces;
  const projectPolicy = applyDefaultIsolatedExecutionWorkspacePolicy({
    projectPolicy: gateProjectExecutionWorkspacePolicy(parseProjectExecutionWorkspacePolicy(project?.executionWorkspacePolicy), enabled),
    defaultIsolatedWorkspacesEnabled: enabled && settings.experimental.enableIsolatedWorkspacesByDefault, hasProject: Boolean(project) });
  const issueSettings = enabled ? parseIssueExecutionWorkspaceSettings(issue?.executionWorkspaceSettings) : null;
  const overrides = issue?.assigneeAgentId === agent.id ? object(issue.assigneeAdapterOverrides) : {};
  const legacyUseProjectWorkspace = typeof overrides.useProjectWorkspace === "boolean" ? overrides.useProjectWorkspace : null;
  const trust = resolveCoreTrustPreset({ companyId: agent.companyId, agent, project, issue });
  const resolvedMode = resolveExecutionWorkspaceMode({ projectPolicy, issueSettings, legacyUseProjectWorkspace });
  const mode = trust.kind === "low_trust_review" && resolvedMode === "shared_workspace" ? "isolated_workspace" : resolvedMode;
  const overlaidConfig = {
    ...buildExecutionWorkspaceAdapterConfig({ agentConfig: object(agent.adapterConfig), projectPolicy, issueSettings, mode, legacyUseProjectWorkspace }),
    ...object(overrides.adapterConfig),
  };
  let effectiveConfig = overlaidConfig;
  let unsupportedPreset = false;
  try { effectiveConfig = enforceAgentSafetyPreset(agent.adapterType, agent.runtimeConfig, overlaidConfig); }
  catch { unsupportedPreset = true; }
  const environmentFingerprint = executionEnvironmentFingerprint(environment ?? null, selectedId);
  const adapterConfigFingerprint = nativeSha256(unsupportedPreset ? { unsupportedPreset, overlaidConfig } : effectiveConfig);
  const savedWorkspace = readExecutionWorkspaceConfig(workspace?.metadata);
  const strategy = object(effectiveConfig.workspaceStrategy);
  // Normalize runtime-created workspace snapshots to the same effective inputs.
  // New workspace IDs and lifecycle bookkeeping are not execution-policy edits.
  const workspaceOverlay = {
    provisionCommand: strategy.provisionCommand ?? savedWorkspace?.provisionCommand ?? projectPolicy?.workspaceStrategy?.provisionCommand ?? null,
    runtimeProvisionCommand: strategy.runtimeProvisionCommand ?? savedWorkspace?.runtimeProvisionCommand ?? projectPolicy?.workspaceStrategy?.runtimeProvisionCommand ?? null,
    teardownCommand: strategy.teardownCommand ?? savedWorkspace?.teardownCommand ?? null,
    cleanupCommand: savedWorkspace?.cleanupCommand ?? null,
    workspaceRuntime: effectiveConfig.workspaceRuntime ?? savedWorkspace?.workspaceRuntime ?? null,
    desiredState: effectiveConfig.desiredState ?? savedWorkspace?.desiredState ?? null,
    serviceStates: effectiveConfig.serviceStates ?? savedWorkspace?.serviceStates ?? null,
  };
  const runtime = object(agent.runtimeConfig);
  const instanceFingerprint = executionInstanceProfileFingerprint(settings);
  return { version: 1, environmentFingerprint, adapterConfigFingerprint, instanceFingerprint, fingerprint: nativeSha256({ version: 1,
    adapterType: agent.adapterType, adapterConfigFingerprint, defaultEnvironmentId: agent.defaultEnvironmentId,
    aiConnection: runtime.aiConnection ?? null, safetyPreset: runtime.safetyPreset ?? null,
    trust: { kind: trust.kind, boundary: "boundary" in trust ? trust.boundary : null },
    instanceFingerprint,
    selection: { source: forced ? "kubernetes" : selection.source, selectedId }, environmentFingerprint,
    projectEnv: project?.env ?? null, workspaceOverlay,
  }) };
}

/** Check a freshly read profile against both admission and the actual selected dispatch inputs. */
export async function assertExecutionProfileDispatch(db: Db, input: {
  companyId: string; agentId: string; issueId: string | null; expected: ExecutionProfileBinding;
  environment: EnvironmentInput | null; selectedEnvironmentId: string | null; effectiveAdapterConfig: Record<string, unknown>;
}) {
  const [agent] = await db.select().from(agents).where(and(eq(agents.companyId, input.companyId), eq(agents.id, input.agentId)));
  const [issue] = input.issueId ? await db.select().from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))) : [];
  if (!agent || (input.issueId && !issue)) throw new Error("continuation_execution_profile_changed");
  const current = await readExecutionProfileBinding(db, issue ?? null, agent);
  if (current.fingerprint !== input.expected.fingerprint ||
    current.environmentFingerprint !== executionEnvironmentFingerprint(input.environment, input.selectedEnvironmentId) ||
    current.adapterConfigFingerprint !== nativeSha256(input.effectiveAdapterConfig)) throw new Error("continuation_execution_profile_changed");
}

/** Capture once, before effects. A historical run lacking a capture cannot acquire one on recovery. */
export async function retainExecutionProfileBinding(db: Db, run: typeof heartbeatRuns.$inferSelect, binding: ExecutionProfileBinding) {
  await db.transaction(async tx => {
    const [current] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id))).for("update");
    if (!current) throw new Error("continuation_execution_profile_changed");
    const existing = readCapturedExecutionProfile(current.runnerProfileJson);
    if (existing && existing.fingerprint !== binding.fingerprint) throw new Error("continuation_execution_profile_changed");
    if (!existing) await tx.update(heartbeatRuns).set({ runnerProfileJson:
      sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ executionProfileBinding: binding })}::jsonb` })
      .where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.id, run.id)));
  });
}
