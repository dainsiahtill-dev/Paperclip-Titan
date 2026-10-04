import { createHash, randomUUID } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import { and, eq } from "drizzle-orm";
import { executionWorkspaces, heartbeatRuns, issues, projectWorkspaces, workspaceOperations, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { findWorkspaceCommandDefinition } from "@paperclipai/shared";
import type { EngineeringEvidencePolicy } from "@paperclipai/shared/types/delivery";
import { engineeringBundleSchema } from "@paperclipai/shared/validators/delivery";
import { conflict } from "../errors.js";
import { deliveryCanonicalJson, deliveryDigest } from "./work-product-material.js";
import { workspaceFileResourceService } from "./workspace-file-resources.js";
import { readProjectWorkspaceRuntimeConfig } from "./project-workspace-runtime-config.js";
import { workspaceWriteOwnershipService } from "./workspace-write-ownership.js";
import { getWorkspaceOperationLogStore } from "./workspace-operation-log-store.js";

const object = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
function fail(reason: string): never { throw conflict(`Engineering evidence: ${reason}`, { code: "engineering_evidence_unverified" }); }
export type EngineeringJobAuthorization = { actorType: string; actorId: string; agentId: string | null; runId: string | null; issueId: string | null };

/** Inherited requirements accumulate. A child cannot change an inherited file/job role or source target. */
export function mergeEngineeringPolicies(policies: Array<EngineeringEvidencePolicy | undefined>): EngineeringEvidencePolicy | undefined {
  const values = policies.filter((policy): policy is EngineeringEvidencePolicy => Boolean(policy));
  if (!values.length) return undefined;
  const first = values[0]!;
  const files = new Map<string, EngineeringEvidencePolicy["sourceScope"]["files"][number]>(), jobs = new Map<string, EngineeringEvidencePolicy["requiredJobs"][number]>();
  for (const value of values) {
    if (value.sourceScope.projectId !== first.sourceScope.projectId || value.sourceScope.executionWorkspaceId !== first.sourceScope.executionWorkspaceId) fail("inherited source targets conflict; Board must align the policies");
    for (const file of value.sourceScope.files) {
      if (files.has(file.path) && files.get(file.path)!.role !== file.role) fail("inherited source role cannot be changed");
      files.set(file.path, file);
    }
    for (const job of value.requiredJobs) {
      if (jobs.has(job.id) && jobs.get(job.id)!.role !== job.role) fail("inherited job role cannot be changed");
      jobs.set(job.id, job);
    }
  }
  if (files.size > 128 || jobs.size > 16) fail("combined inherited scope exceeds bounded verification limits");
  return { version: 1, sourceScope: { ...first.sourceScope, files: [...files.values()].sort((a,b) => a.path.localeCompare(b.path)) }, requiredJobs: [...jobs.values()].sort((a,b) => a.id.localeCompare(b.id)) };
}

export async function engineeringSource(db: Db, companyId: string, issueId: string, policy: EngineeringEvidencePolicy) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, issueId), eq(issues.companyId, companyId)));
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, policy.sourceScope.executionWorkspaceId), eq(executionWorkspaces.companyId, companyId)));
  if (!issue || !workspace || issue.projectId !== policy.sourceScope.projectId || workspace.projectId !== issue.projectId || issue.executionWorkspaceId !== workspace.id) fail("source issue/project/workspace binding changed");
  if (workspace.providerType !== "local_fs" || !workspace.cwd || workspace.closedAt || workspace.status !== "active") fail("only an active local workspace is supported");
  const root = await realpath(workspace.cwd), identity = await stat(root);
  const files = [];
  let bytes = 0;
  for (const file of policy.sourceScope.files) {
    const content = await workspaceFileResourceService(db).readContent(issueId, { path: file.path, workspace: "execution", executionWorkspaceId: workspace.id }, { issue });
    if (content.resource.workspaceId !== workspace.id || content.content.encoding !== "utf8" || content.content.data.includes("\uFFFD")) fail("source must be bounded authorized text files in the selected workspace");
    if (!content.content.data.trim()) fail(`empty ${file.role} source input: ${file.path}`);
    const data = Buffer.from(content.content.data, "utf8"); bytes += data.length;
    if (bytes > 4_000_000) fail("source scope exceeds 4 MB; narrow the Board-approved scope explicitly");
    files.push({ ...file, bytes: data.length, sha256: createHash("sha256").update(data).digest("hex") });
  }
  // Exact current working bytes, including uncommitted/untracked contents in the approved scope.
  // No Git hook/config execution and no claim that this subset is a clean/full repository.
  return { workspace, root, device: String(identity.dev), inode: String(identity.ino), digest: deliveryDigest({ scope: policy.sourceScope, files }), files };
}

export async function engineeringJobDefinition(db: Db, companyId: string, workspaceId: string, jobId: string) {
  const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, companyId)));
  if (!workspace) fail("configured workspace disappeared");
  const [projectWorkspace] = workspace.projectWorkspaceId ? await db.select().from(projectWorkspaces).where(and(eq(projectWorkspaces.id, workspace.projectWorkspaceId), eq(projectWorkspaces.companyId, companyId), eq(projectWorkspaces.projectId, workspace.projectId))).for("share") : [];
  const runtime = object(workspace.metadata?.config).workspaceRuntime ?? readProjectWorkspaceRuntimeConfig(projectWorkspace?.metadata)?.workspaceRuntime;
  const definition = findWorkspaceCommandDefinition(object(runtime), jobId);
  if (!definition || definition.kind !== "job" || !definition.command || definition.disabledReason) fail(`approved job ${jobId} is missing or disabled`);
  return { definition, digest: deliveryDigest(definition) };
}

export async function prepareEngineeringJob(db: Db, input: { companyId: string; issueId: string; workspaceId: string; jobId: string; command: Record<string, unknown>; cwd: string; authorization: EngineeringJobAuthorization }) {
  const { resolveDeliveryDefinition } = await import("./delivery-authority.js");
  const { engineeringEvidence: policy } = await resolveDeliveryDefinition(db, input.companyId, input.issueId);
  if (!policy) return null;
  const auth = input.authorization;
  if (auth.issueId !== input.issueId || !auth.actorId) fail("authenticated issue and principal are required");
  if (auth.actorType === "agent") {
    const [run] = auth.runId && auth.agentId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, auth.runId), eq(heartbeatRuns.agentId, auth.agentId), eq(heartbeatRuns.companyId, input.companyId))) : [];
    const context = object(run?.contextSnapshot);
    if (!run || run.status !== "running" || (context.issueId ?? object(context.paperclipIssue).id) !== input.issueId || auth.actorId !== auth.agentId) fail("agent job requires its actual current authenticated issue/run");
  } else if (!["board", "user"].includes(auth.actorType) || auth.runId || auth.agentId) fail("unsupported job principal");
  if (input.workspaceId !== policy.sourceScope.executionWorkspaceId) fail("job workspace differs from Board-approved source scope");
  const requirement = policy.requiredJobs.find(job => job.id === input.jobId);
  if (!requirement) fail("job is not required by the Board engineering policy");
  const job = await engineeringJobDefinition(db, input.companyId, input.workspaceId, input.jobId);
  if (deliveryCanonicalJson(job.definition.rawConfig) !== deliveryCanonicalJson(input.command)) fail("executed job differs from approved definition");
  // Template-dependent cwd/env/adapter overlays are deliberately outside v1 proof.
  if (String(input.command.cwd ?? ".").includes("{{") || Object.keys(object(input.command.env)).length) fail("engineering jobs require a fixed cwd and no command environment overrides");
  return { policy, policyDigest: deliveryDigest(policy), requirement, definitionDigest: job.digest, authorization: auth };
}

export async function resolveEngineeringEvidence(db: Db, input: { companyId: string; issueId: string; policy: EngineeringEvidencePolicy; contentText: string | null; isPrimary: boolean }) {
  const ownership = workspaceWriteOwnershipService(db);
  let fence: Awaited<ReturnType<typeof ownership.claim>> | null = null;
  try {
    if (!input.isPrimary || !input.contentText || Buffer.byteLength(input.contentText) > 64_000) fail("one primary managed JSON document bundle is required");
    const bundle = engineeringBundleSchema.parse(JSON.parse(input.contentText));
    if (bundle.executionWorkspaceId !== input.policy.sourceScope.executionWorkspaceId) fail("bundle workspace differs from authorized scope");
    if (bundle.operationIds.length !== input.policy.requiredJobs.length || new Set(bundle.operationIds).size !== bundle.operationIds.length) fail("one inner operation is required for every approved job");
    const [workspace] = await db.select().from(executionWorkspaces).where(and(eq(executionWorkspaces.id, bundle.executionWorkspaceId), eq(executionWorkspaces.companyId, input.companyId))).for("share");
    if (!workspace?.cwd) fail("local source workspace unavailable");
    fence = await ownership.claim({ cwd: workspace.cwd, companyId: input.companyId, issueId: input.issueId, runId: randomUUID() });
    if (fence.outcome === "busy") fail("source has an undrained managed writer; retry after it stops");
    const source = await engineeringSource(db, input.companyId, input.issueId, input.policy);
    if (source.root !== fence.owner.canonicalRoot || source.device !== fence.owner.device || source.inode !== fence.owner.inode) fail("source root changed during assessment");
    const policyDigest = deliveryDigest(input.policy), receipts = [], producers = new Set<string>(), jobs = new Set<string>();
    for (const id of bundle.operationIds) {
      const [operation] = await db.select().from(workspaceOperations).where(and(eq(workspaceOperations.id, id), eq(workspaceOperations.companyId, input.companyId))).for("share");
      if (!operation || operation.issueId !== input.issueId || operation.executionWorkspaceId !== bundle.executionWorkspaceId || operation.status !== "succeeded" || operation.exitCode !== 0 || !operation.finishedAt || operation.phase !== "workspace_provision") fail("missing, foreign, not-run or failed inner host job");
      const receipt = object(operation.metadata?.engineeringReceipt), auth = object(receipt.authorization);
      if (receipt.version !== 1 || receipt.kind !== "host_readonly_job" || receipt.policyDigest !== policyDigest || receipt.sourceDigest !== source.digest || receipt.sourceAfterDigest !== source.digest || receipt.executionWorkspaceId !== bundle.executionWorkspaceId) fail("missing or stale host source/readonly/job binding");
      const requirement = input.policy.requiredJobs.find(job => job.id === receipt.jobId);
      if (!requirement || requirement.role !== receipt.role || jobs.has(requirement.id)) fail("wrong or duplicate approved job role");
      jobs.add(requirement.id);
      const job = await engineeringJobDefinition(db, input.companyId, bundle.executionWorkspaceId, requirement.id);
      if (job.digest !== receipt.definitionDigest || job.definition.command !== operation.command || operation.cwd !== path.resolve(source.root, job.definition.cwd ?? ".")) fail("approved job definition or execution cwd changed");
      if (!auth.actorId || auth.issueId !== input.issueId || auth.runId !== operation.heartbeatRunId) fail("job authenticated owner binding missing");
      if (auth.actorType === "agent") {
        const [run] = typeof auth.runId === "string" ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, auth.runId), eq(heartbeatRuns.companyId, input.companyId))) : [];
        const context = object(run?.contextSnapshot);
        if (!run || run.agentId !== auth.agentId || auth.actorId !== auth.agentId || (context.issueId ?? object(context.paperclipIssue).id) !== input.issueId) fail("job run owner is no longer authentic");
        producers.add(run.agentId);
      } else if (!["board", "user"].includes(String(auth.actorType)) || auth.runId || auth.agentId) fail("unsupported job principal");
      const [owner] = typeof receipt.ownerId === "string" ? await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, receipt.ownerId)).for("share") : [];
      if (!owner || owner.companyId !== input.companyId || owner.issueId !== input.issueId || owner.generation !== receipt.ownerGeneration || owner.canonicalRoot !== source.root || owner.device !== source.device || owner.inode !== source.inode || owner.launchIdentity?.sourceAccess !== "ro" || owner.stopReceipt?.launchId !== receipt.launchId || owner.launchId !== receipt.launchId || owner.stopReceipt?.generation !== owner.generation || !["released", "reserved"].includes(owner.state) || (auth.runId && owner.runId !== auth.runId)) fail("actual readonly interval and namespace drain are unverified");
      if (operation.logStore !== "local_file" || operation.logCompressed || operation.logRef !== `${input.companyId}/${operation.id}.ndjson` || !operation.logSha256 || !operation.logBytes || operation.logBytes > 8_000_000) fail("bounded operation log is unavailable");
      const log = await getWorkspaceOperationLogStore().read({ store: "local_file", logRef: operation.logRef }, { limitBytes: 8_000_001 });
      if (log.nextOffset != null || Buffer.byteLength(log.content) !== operation.logBytes || createHash("sha256").update(log.content).digest("hex") !== operation.logSha256) fail("operation log changed or is incomplete");
      receipts.push({ operation, owner: { id: owner.id, generation: owner.generation, launchIdentity: owner.launchIdentity, stopReceipt: owner.stopReceipt } });
    }
    return { verified: true, reason: "Approved host jobs ran against the selected read-only source. Independent semantic review is still required.", digest: deliveryDigest({ policyDigest, source: source.digest, receipts }), producerAgentIds: [...producers] };
  } catch (error) {
    return { verified: false, reason: `Engineering evidence unverified: ${error instanceof Error ? error.message : "unsupported evidence"}`, digest: null, producerAgentIds: [] as string[] };
  } finally { if (fence?.outcome === "claimed") await ownership.releaseIfStopped(fence.owner); }
}
