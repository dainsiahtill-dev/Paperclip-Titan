import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { agents, companySkills, environments, instanceSettings, projectWorkspaces, type Db } from "@paperclipai/db";
import { agentReadinessRequirementsSchema, type AgentPreflightCheck, type AgentPreflightProfile, type AgentPreflightResult } from "@paperclipai/shared";
import { readPaperclipSkillSyncPreference } from "@paperclipai/adapter-utils/server-utils";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { assertManagedAiProjectAuth } from "./ai-connection-runtime.js";
import { environmentService } from "./environments.js";
import { createToolGatewayService } from "./tool-gateway.js";
import { existingProbeCwd, probeInterpreter } from "./governed-stdio.js";
import { preflightDigest, preflightProfile, record } from "./agent-preflight-profile.js";
import { createToolRuntimeSupervisor, type ToolRuntimeSupervisorOptions } from "./tool-runtime-supervisor.js";

const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };
async function readableSkill(file: string, roots: string[], code: string): Promise<AgentPreflightCheck> {
  try {
    const canonical = await fs.realpath(file);
    const allowedRoots = await Promise.all(roots.map(root => fs.realpath(root).catch(() => null)));
    if (!allowedRoots.some(root => root && within(root, canonical))) throw new Error();
    const stat = await fs.stat(canonical);
    if (!stat.isFile() || !(stat.mode & 0o444) || stat.size > 1_048_576) throw new Error();
    await fs.access(canonical, constants.R_OK);
    const bytes = await fs.readFile(canonical);
    return { code, status: "readable", message: "Required SKILL.md source is readable. Runtime-home delivery is not asserted by this source check.", detail: code.slice("skill:".length), fingerprint: preflightDigest(bytes.toString("base64")) };
  } catch { return { code, status: "error", message: "Required SKILL.md is missing, unreadable, oversized, or outside an approved workspace/managed root.", detail: code.slice("skill:".length) }; }
}

/** Read-only saved-config preview: never prepare a managed home, acquire a lease, install, or test a model. */
export async function runAgentBasicPreflight(db: Db, agent: typeof agents.$inferSelect, responsibleUserId: string | null, hostOptions: Pick<ToolRuntimeSupervisorOptions, "deploymentMode" | "deploymentExposure" | "trustedLocalStdioRuntimeHost"> = {}): Promise<AgentPreflightResult> {
  const checks: AgentPreflightCheck[] = [];
  let profile: AgentPreflightProfile = { source: "saved_agent", adapterType: agent.adapterType, cwd: null, projectId: null, target: "unverified", sandbox: null, model: null, effort: null };
  const runtime = record(agent.runtimeConfig);
  const finish = (): AgentPreflightResult => ({ status: checks.some(check => check.status === "error") ? "fail" : checks.some(check => check.status === "unverified") ? "unverified" : "pass", testedAt: new Date().toISOString(), profileDigest: preflightDigest({ profile, requirements: runtime.readinessRequirements ?? {}, evidence: checks.map(({ code, status, fingerprint }) => ({ code, status, fingerprint })) }), profile, checks, modelInvoked: false });
  const parsed = agentReadinessRequirementsSchema.safeParse(runtime.readinessRequirements ?? {});
  if (!parsed.success) { checks.push({ code: "requirements", status: "error", message: "Saved readiness requirements are invalid. Use typed interpreter, SKILL.md and governed connection references." }); return finish(); }
  const requirements = parsed.data;
  if (!(requirements.interpreters?.length || requirements.skills?.length || requirements.mcp?.length)) checks.push({ code: "requirements", status: "unverified", message: "No interpreter, skill or MCP requirements are saved; this is configuration inspection only." });
  const [settings] = await db.select().from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  const environmentId = agent.defaultEnvironmentId ?? settings?.defaultEnvironmentId;
  const [environment] = environmentId ? await db.select().from(environments).where(eq(environments.id, environmentId)).limit(1) : [];
  let target = environmentId ? environment?.driver === "local" ? "local" : environment?.driver === "ssh" ? "remote" : environment?.driver ?? "unverified" : "local";
  if (record(settings?.experimental).enableManagedSandboxOnly || record(settings?.general).executionMode === "kubernetes") target = "sandbox";
  if (environmentId) {
    const boundCompanies = await environmentService(db).listBoundCompanyIds(environmentId);
    if (boundCompanies.length && !boundCompanies.includes(agent.companyId)) { checks.push({ code: "target", status: "error", message: "The saved environment is unavailable to this company." }); return finish(); }
    if (!environment || environment.status !== "active") { checks.push({ code: "target", status: "error", message: "The saved environment is missing or inactive." }); return finish(); }
  }
  const config = record(agent.adapterConfig);
  const env = { ...record(environment?.envVars), ...record(config.env) };
  try {
    profile = preflightProfile({ adapterType: agent.adapterType, config, runtimeConfig: runtime, target, source: "saved_agent" });
    // Auth/config inspection is local only. Unsupported remote targets never fall back to host reads.
    if (target === "local" && record(runtime.aiConnection).provider) await assertManagedAiProjectAuth(config, record(runtime.aiConnection).provider as "openai" | "anthropic");
    const args = [...(Array.isArray(config.args) ? config.args : []), ...(Array.isArray(config.extraArgs) ? config.extraArgs : [])];
    if (args.some(arg => arg !== "--skip-git-repo-check")) throw new Error();
    if (record(runtime.aiConnection).provider && Object.keys(env).some(key => /^(OPENAI_BASE_URL|ANTHROPIC_BASE_URL|PAPERCLIP_CODEX_PROVIDERS|CLAUDE_CODE_USE_)/.test(key))) throw new Error();
  } catch { checks.push({ code: "config_guard", status: "error", message: "Saved configuration conflicts with the managed auth/safety profile or includes unsupported raw launch overrides." }); return finish(); }
  checks.push({ code: "profile", status: "configured", message: "Saved launch configuration inspected. Model/effort matches prove configuration only, not model entitlement or paid-task qualification." });
  checks.push({ code: "home", status: "configured", message: "Probes use a disposable private home with no copied credentials. The eventual employee home and authentication were not tested." });
  const compareExpected = () => {
    for (const [key, expected] of Object.entries(requirements.expected ?? {})) {
      const actual = profile[key as keyof AgentPreflightProfile];
      checks.push({ code: `expected:${key}`, status: actual === expected ? "configured" : "error", message: actual === expected ? `Saved ${key} matches the declared expectation.` : `Saved ${key} differs from the declared expectation.`, detail: `Expected: ${expected}; effective: ${actual ?? "not resolved"}` });
    }
  };
  if (target !== "local") {
    compareExpected();
    checks.push({ code: "target", status: "unverified", message: "Remote, sandbox and provisioning targets are not probed by basic checks; no local fallback or provisioning occurred." });
    return finish();
  }
  try { createToolRuntimeSupervisor(db, hostOptions).assertLocalStdioAvailable(); }
  catch { checks.push({ code: "host_policy", status: "unverified", message: "The deployment has not approved a trusted local tool runtime; no local probes were launched." }); return finish(); }
  if (!profile.cwd) { checks.push({ code: "cwd", status: "unverified", message: "No explicit employee cwd is saved. Task-specific workspace resolution has not occurred." }); return finish(); }
  try { profile.cwd = await existingProbeCwd(profile.cwd); checks.push({ code: "cwd", status: "resolved", message: "Saved workspace exists and resolves on this local target." }); }
  catch { checks.push({ code: "cwd", status: "error", message: "Saved workspace is missing or inaccessible; no directory was created." }); return finish(); }
  const workspaces = await db.select().from(projectWorkspaces).where(eq(projectWorkspaces.companyId, agent.companyId));
  const matching = (await Promise.all(workspaces.map(async workspace => ({ workspace, canonical: workspace.cwd ? await fs.realpath(workspace.cwd).catch(() => null) : null })))).filter(item => item.canonical === profile.cwd);
  const projectIds = [...new Set(matching.map(item => item.workspace.projectId))];
  profile.projectId = projectIds.length === 1 ? projectIds[0]! : null;
  if (projectIds.length > 1) checks.push({ code: "project", status: "unverified", message: "More than one project names this workspace; a task-bound project is required." });
  compareExpected();
  const uncertainEnv = Object.keys(env).some(key => /^(LD_|DYLD_|NODE_OPTIONS$|PYTHONPATH$|PYTHONHOME$|BASH_ENV$|ENV$)/i.test(key)) || (env.PATH !== undefined && typeof env.PATH !== "string");
  if (uncertainEnv) checks.push({ code: "interpreter_environment", status: "unverified", message: "Custom interpreter loader or unresolved PATH bindings are not run by basic checks." });
  else for (const interpreter of requirements.interpreters ?? []) checks.push(await probeInterpreter(interpreter, profile.cwd, typeof env.PATH === "string" ? env.PATH : undefined));
  const managedRoot = path.join(resolvePaperclipInstanceRoot(), "skills", agent.companyId);
  const skillRoots = [profile.cwd, managedRoot, ...workspaces.flatMap(workspace => workspace.cwd ? [workspace.cwd] : [])];
  const selected = readPaperclipSkillSyncPreference(config);
  for (const skill of requirements.skills ?? []) {
    if ("workspacePath" in skill) { checks.push(await readableSkill(path.join(profile.cwd, skill.workspacePath), [profile.cwd], `skill:${skill.workspacePath}`)); continue; }
    const code = `skill:${skill.key}`;
    const [row] = await db.select().from(companySkills).where(and(eq(companySkills.companyId, agent.companyId), eq(companySkills.key, skill.key))).limit(1);
    if (!row) { checks.push({ code, status: "error", message: "Required skill is not in this company's skill library." }); continue; }
    const selectedEntry = selected.desiredSkillEntries.find(entry => entry.key === skill.key);
    if (!selectedEntry) { checks.push({ code, status: "unverified", message: "Required managed skill is not selected for this employee; no skill was installed." }); continue; }
    const source = selectedEntry.versionId ? path.join(managedRoot, "__versions__", row.id, selectedEntry.versionId) : row.sourceLocator;
    if (!source || !path.isAbsolute(source)) { checks.push({ code, status: "unverified", message: "Skill source has not been materialized locally; basic checks do not install or fetch it." }); continue; }
    checks.push(await readableSkill(path.basename(source) === "SKILL.md" ? source : path.join(source, "SKILL.md"), skillRoots, code));
  }
  if (requirements.mcp?.length) {
    const gateway = createToolGatewayService(db, hostOptions);
    for (const requirement of requirements.mcp) checks.push(await gateway.preflightLocalConnection({ companyId: agent.companyId, agentId: agent.id, cwd: profile.cwd, responsibleUserId, ...requirement }));
  }
  return finish();
}
