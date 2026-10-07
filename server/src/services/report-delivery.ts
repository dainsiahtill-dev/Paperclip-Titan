import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, desc, eq, gt, inArray, isNotNull, sql } from "drizzle-orm";
import { activityLog, agentWakeupRequests, environmentLeases, executionWorkspaces, heartbeatRuns, issues, nativeRunFinalizations, workspaceOperations, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { issueExecutionPolicySchema } from "@paperclipai/shared/validators/issue";
import { openRunnerApiWorkspaceFile } from "./native-runtime/runner-api-files.js";
import { validateWorkspaceTextOutputPath, WORKSPACE_FILE_TEXT_MAX_BYTES } from "./workspace-file-resources.js";
import { workProductService } from "./work-products.js";
import { issueService } from "./issues.js";
import { logActivity } from "./activity-log.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";

type Input = { companyId: string; issueId: string; runId: string };
type Output = { path: string; state: "present" | "missing" | "unverified"; sha256?: string; byteSize?: number; nonEmpty?: boolean };
export interface ReportDeliveryBaseline {
  version: 1; companyId: string; issueId: string; runId: string; agentId: string;
  workspaceId: string; issueWorkspaceId: string | null; root: string; rootDevice: string; rootInode: string;
  contractHash: string; outputs: Output[];
}
export async function sealReportDeliveryOutputs(db: Db, input: Input) {
  const scope = await current(db, input);
  const baseline = object(scope?.run.contextSnapshot).reportDeliveryBaseline as ReportDeliveryBaseline | undefined;
  if (!scope?.policy?.reportDelivery || !baseline || baseline.contractHash !== contractHash(scope.policy) || !scope.workspace?.cwd) return false;
  const root = await fs.realpath(scope.workspace.cwd).catch(() => null);
  if (root !== baseline.root) return false;
  const outputs = await Promise.all(scope.policy.reportDelivery.files.map(file => observe(root!, file)));
  if (outputs.some((file, i) => file.state !== "present" || !file.nonEmpty || file.sha256 === baseline.outputs[i]?.sha256)) return false;
  await logActivity(db, { companyId: input.companyId, actorType: "system", actorId: "report-delivery-observer", runId: input.runId,
    action: "issue.report_delivery_outputs_sealed", entityType: "issue", entityId: input.issueId,
    details: { version: 2, contractHash: baseline.contractHash, workspaceId: baseline.workspaceId,
      outputsDigest: outputsDigest(outputs), outputs } });
  return true;
}

/** Start only the board-declared report review, at native finalization's authority seam. */
export async function prepareNativeReportReview(db: Db, input: Input) {
  return db.transaction(async tx => {
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, input.companyId), eq(issues.id, input.issueId))).for("update");
    const scope = await current(tx as unknown as Db, input);
    if (!scope?.policy?.reportDelivery || scope.run.runtimeMode !== "native" || scope.issue.status !== "in_progress" ||
        scope.issue.assigneeAgentId !== scope.run.agentId || parseIssueExecutionState(scope.issue.executionState)?.status === "pending") return false;
    if (scope.issue.executionRunId && scope.issue.executionRunId !== scope.run.id) return false;
    const [successor] = scope.run.startedAt ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${scope.issue.id}`,
      isNotNull(heartbeatRuns.startedAt), gt(heartbeatRuns.startedAt, scope.run.startedAt))).limit(1) : [];
    if (successor) return false;
    const baseline = object(scope.run.contextSnapshot).reportDeliveryBaseline as ReportDeliveryBaseline | undefined;
    if (baseline && (baseline.companyId !== input.companyId || baseline.issueId !== input.issueId || baseline.runId !== input.runId ||
        baseline.agentId !== scope.run.agentId || baseline.contractHash !== contractHash(scope.policy) ||
        baseline.issueWorkspaceId !== scope.issue.executionWorkspaceId || baseline.workspaceId !== scope.workspace?.id)) return false;
    const [seal] = await tx.select({ id: activityLog.id }).from(activityLog).where(and(eq(activityLog.companyId, input.companyId),
      eq(activityLog.entityId, input.issueId), eq(activityLog.runId, input.runId), eq(activityLog.actorType, "system"),
      eq(activityLog.actorId, "report-delivery-observer"), eq(activityLog.action, "issue.report_delivery_outputs_sealed"))).limit(1);
    const transition = applyIssueExecutionPolicyTransition({ issue: scope.issue, policy: normalizeIssueExecutionPolicy(scope.issue.executionPolicy),
      requestedStatus: "in_review", requestedAssigneePatch: {}, actor: { agentId: scope.run.agentId },
      reviewRequest: { instructions: seal
        ? "Inspect the controller-observed report. Source acceptance remains independent from report submission."
        : "Declared report outputs are not verified. Inspect the preserved run and missing or unchanged report files, then choose a scoped correction. No report was accepted and no additional provider attempt was granted." } });
    await issueService(db).update(scope.issue.id, { companyGuard: input.companyId, actorAgentId: scope.run.agentId, ...transition.patch }, tx);
    return true;
  });
}
type Submission = { state: "submitted" | "not_ready" | "stale" | "not_configured"; code?: string;
  workProductIds?: string[]; reviewer?: { type: "agent" | "user"; agentId?: string | null; userId?: string | null } };
const object = (v: unknown): Record<string, any> => v && typeof v === "object" && !Array.isArray(v) ? v as Record<string, any> : {};
const sha = (v: string | Buffer) => createHash("sha256").update(v).digest("hex");
const contractHash = (policy: any) => sha(JSON.stringify({ reportDelivery: policy.reportDelivery, stages: policy.stages }));
// The canonical verification digest uses original output values before logging.
// Display fields remain redacted; they are not authority for a version 2 seal.
const outputsDigest = (outputs: Output[]) => sha(JSON.stringify(outputs.map(output => [
  output.path, output.state, output.sha256 ?? null, output.byteSize ?? null, output.nonEmpty ?? null,
])));

async function current(db: Db, input: Input) {
  const [issue] = await db.select().from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId)));
  const [run] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  if (!issue || !run || (run.nativeIssueId ?? object(run.contextSnapshot).issueId ?? object(run.contextSnapshot).taskId) !== issue.id) return null;
  const parsed = issueExecutionPolicySchema.safeParse(issue.executionPolicy);
  const policy = parsed.success ? parsed.data : null;
  const workspaceId = typeof object(run.contextSnapshot).executionWorkspaceId === "string"
    ? object(run.contextSnapshot).executionWorkspaceId : issue.executionWorkspaceId;
  const [workspace] = workspaceId ? await db.select().from(executionWorkspaces).where(and(
    eq(executionWorkspaces.id, workspaceId), eq(executionWorkspaces.companyId, input.companyId))) : [];
  return { issue, run, policy, workspace };
}

async function observe(root: string, file: string): Promise<Output> {
  let handle: Awaited<ReturnType<typeof openRunnerApiWorkspaceFile>> | null = null;
  try {
    const relative = validateWorkspaceTextOutputPath(file);
    handle = await openRunnerApiWorkspaceFile(path.join(root, relative));
    const before = await handle.stat({ bigint: true });
    if (!before.isFile() || before.nlink !== 1n || before.size > BigInt(WORKSPACE_FILE_TEXT_MAX_BYTES)) return { path: file, state: "unverified" };
    // Bound the read even if another writer grows the file after fstat.
    const buffer = Buffer.alloc(Number(before.size) + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const part = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (!part.bytesRead) break;
      offset += part.bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    const named = await fs.lstat(path.join(root, relative), { bigint: true });
    if (["dev", "ino", "size", "mtimeNs", "ctimeNs"].some(key => before[key as keyof typeof before] !== after[key as keyof typeof after]) ||
        after.nlink !== 1n || named.isSymbolicLink() || named.dev !== after.dev || named.ino !== after.ino || offset !== Number(before.size))
      return { path: file, state: "unverified" };
    const bytes = buffer.subarray(0, offset);
    const body = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return { path: file, state: "present", sha256: sha(bytes), byteSize: bytes.length, nonEmpty: Boolean(body.trim()) };
  } catch (error) {
    return { path: file, state: (error as NodeJS.ErrnoException).code === "ENOENT" ? "missing" : "unverified" };
  } finally { await handle?.close(); }
}

/** Called only by the controller after binding the actual run workspace. */
export async function captureReportDeliveryBaseline(db: Db, input: Input): Promise<ReportDeliveryBaseline | null> {
  const scope = await current(db, input);
  if (!scope?.policy?.reportDelivery) return null;
  const { issue, run, workspace, policy } = scope;
  if (!workspace?.cwd) throw new Error("report_delivery_workspace_not_bound");
  if (workspace.projectId !== issue.projectId) throw new Error("report_delivery_workspace_project_changed");
  if (!["local_fs", "git_worktree"].includes(workspace.providerType)) throw new Error("report_delivery_workspace_not_local");
  if (issue.assigneeAgentId !== run.agentId) throw new Error("report_delivery_assignee_changed");
  const root = await fs.realpath(workspace.cwd);
  const runCwd = object(object(run.contextSnapshot).paperclipWorkspace).cwd;
  if (typeof runCwd !== "string" || await fs.realpath(runCwd).catch(() => null) !== root)
    throw new Error("report_delivery_run_workspace_missing");
  const identity = await fs.stat(root, { bigint: true });
  const outputs = await Promise.all(policy.reportDelivery!.files.map(file => observe(root, file)));
  if (outputs.some(output => output.state === "unverified")) throw new Error("report_delivery_baseline_unverified");
  return { version: 1, ...input, agentId: run.agentId, workspaceId: workspace.id, issueWorkspaceId: issue.executionWorkspaceId, root,
    rootDevice: String(identity.dev), rootInode: String(identity.ino), contractHash: contractHash(policy), outputs };
}

/** Real outputs submit a report, never certify the inspected source or auto-approve it. */
export async function submitReportDelivery(db: Db, input: Input): Promise<Submission> {
  if (!await current(db, input)) return { state: "stale", code: "report_source_scope_changed" };
  const result: Submission = await db.transaction(async tx => {
    // Match other issue/run writers' lock order. A newer owner or operator disposition wins.
    await tx.select({ id: issues.id }).from(issues).where(and(eq(issues.id, input.issueId), eq(issues.companyId, input.companyId))).for("update");
    await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId))).for("update");
    const scope = await current(tx as unknown as Db, input);
    if (!scope) return { state: "stale", code: "report_source_scope_changed" };
    const { issue, run, policy, workspace } = scope;
    const existingReview = parseIssueExecutionState(issue.executionState);
    const nativeReview = run.runtimeMode === "native" && run.nativePhase === "committed" && issue.status === "in_review" &&
      existingReview?.status === "pending" && existingReview.returnAssignee?.type === "agent" && existingReview.returnAssignee.agentId === run.agentId;
    const [committed] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityId, issue.id), eq(activityLog.runId, run.id),
      eq(activityLog.actorType, "system"), eq(activityLog.actorId, "report-delivery-observer"), eq(activityLog.action, "issue.report_delivery_submitted"))).limit(1);
    if (committed) return { state: "submitted", workProductIds: object(committed.details).workProductIds, reviewer: object(committed.details).reviewer };
    if (!policy?.reportDelivery) return { state: "not_configured" };
    if (run.status !== "succeeded") return { state: "not_ready", code: "report_run_not_succeeded" };
    const [successor] = run.startedAt ? await tx.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, input.companyId),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${issue.id}`,
      isNotNull(heartbeatRuns.startedAt), gt(heartbeatRuns.startedAt, run.startedAt))).limit(1) : [];
    if (successor) return { state: "stale", code: "report_source_run_superseded" };
    const baseline = object(run.contextSnapshot).reportDeliveryBaseline as ReportDeliveryBaseline | undefined;
    if (!baseline || baseline.version !== 1 || baseline.companyId !== input.companyId || baseline.issueId !== issue.id ||
        baseline.runId !== run.id || baseline.agentId !== run.agentId || baseline.contractHash !== contractHash(policy) ||
        baseline.issueWorkspaceId !== issue.executionWorkspaceId || baseline.workspaceId !== workspace?.id || (!nativeReview && issue.assigneeAgentId !== run.agentId) ||
        (!nativeReview && issue.status !== "in_progress") || (issue.executionRunId && issue.executionRunId !== run.id) ||
        !workspace?.cwd || workspace.projectId !== issue.projectId || !["local_fs", "git_worktree"].includes(workspace.providerType))
      return { state: "stale", code: "report_delivery_binding_changed" };
    const [finalized] = await tx.select({ id: workspaceOperations.id }).from(workspaceOperations).where(and(
      eq(workspaceOperations.companyId, input.companyId), eq(workspaceOperations.issueId, issue.id),
      eq(workspaceOperations.heartbeatRunId, run.id), eq(workspaceOperations.executionWorkspaceId, workspace.id),
      eq(workspaceOperations.phase, "workspace_finalize"), eq(workspaceOperations.status, "succeeded"))).limit(1);
    const held = await tx.select({ state: workspaceWriteOwners.state }).from(workspaceWriteOwners).where(and(
      eq(workspaceWriteOwners.companyId, input.companyId), eq(workspaceWriteOwners.runId, run.id),
      inArray(workspaceWriteOwners.state, run.runtimeMode === "native"
        ? ["launching", "active", "stopping", "unknown"] : ["launching", "active", "stopping", "unknown", "unprotected"])));
    if (!finalized || held.length) return { state: "not_ready", code: "report_execution_not_settled" };
    // A successor writer cannot supply this run's report bytes during recovery.
    const rootOwners = await tx.select({ runId: workspaceWriteOwners.runId, state: workspaceWriteOwners.state }).from(workspaceWriteOwners).where(and(
      eq(workspaceWriteOwners.canonicalRoot, baseline.root),
      inArray(workspaceWriteOwners.state, ["reserved", "launching", "active", "stopping", "unknown", "unprotected"]))).for("share");
    if (rootOwners.some(owner => owner.runId !== run.id)) return { state: "not_ready", code: "report_workspace_owned_by_successor" };
    if (run.runtimeMode === "native") {
      const [native] = await tx.select({ phase: nativeRunFinalizations.phase, decisionId: nativeRunFinalizations.decisionId }).from(nativeRunFinalizations).where(and(
        eq(nativeRunFinalizations.companyId, input.companyId), eq(nativeRunFinalizations.issueId, issue.id), eq(nativeRunFinalizations.runId, run.id)));
      const leases = await tx.select({ status: environmentLeases.status, releasedAt: environmentLeases.releasedAt }).from(environmentLeases).where(and(
        eq(environmentLeases.companyId, input.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
      if (native?.phase !== "committed" || !native.decisionId || issue.lastStatusDecisionId !== native.decisionId ||
          !leases.length || leases.some(lease => !lease.releasedAt || ["active", "pending_cleanup"].includes(lease.status)))
        return { state: "not_ready", code: "report_native_execution_not_settled" };
    }
    const root = await fs.realpath(workspace.cwd).catch(() => null);
    const identity = root ? await fs.stat(root, { bigint: true }).catch(() => null) : null;
    const runCwd = object(object(run.contextSnapshot).paperclipWorkspace).cwd;
    if (root !== baseline.root || typeof runCwd !== "string" || await fs.realpath(runCwd).catch(() => null) !== root ||
        !identity || String(identity.dev) !== baseline.rootDevice || String(identity.ino) !== baseline.rootInode)
      return { state: "stale", code: "report_workspace_changed" };
    if (baseline.outputs.length !== policy.reportDelivery.files.length || baseline.outputs.some((file, i) => file.path !== policy.reportDelivery!.files[i]))
      return { state: "stale", code: "report_baseline_invalid" };
    const outputs = await Promise.all(policy.reportDelivery.files.map(file => observe(root!, file)));
    if (outputs.some(file => file.state !== "present" || !file.nonEmpty)) return { state: "not_ready", code: "report_outputs_incomplete" };
    if (outputs.some((file, i) => file.sha256 === baseline.outputs[i].sha256)) return { state: "not_ready", code: "report_outputs_unchanged" };
    const [seal] = await tx.select({ details: activityLog.details }).from(activityLog).where(and(
      eq(activityLog.companyId, input.companyId), eq(activityLog.entityId, issue.id), eq(activityLog.runId, run.id),
      eq(activityLog.actorType, "system"), eq(activityLog.actorId, "report-delivery-observer"), eq(activityLog.action, "issue.report_delivery_outputs_sealed")))
      .orderBy(desc(activityLog.createdAt)).limit(1);
    const sealed = object(seal?.details);
    const outputsVerified = sealed.version === 2
      ? sealed.outputsDigest === outputsDigest(outputs)
      // Preserve only exact, undamaged historical seals. A damaged display log
      // is not permission to invent past verification or bypass a new digest.
      : sealed.version === 1 && Array.isArray(sealed.outputs) && JSON.stringify(sealed.outputs) === JSON.stringify(outputs);
    if (sealed.contractHash !== baseline.contractHash || sealed.workspaceId !== workspace.id || !outputsVerified)
      return { state: "not_ready", code: "report_settled_outputs_not_verified" };
    const workProductIds: string[] = [];
    for (const output of outputs) {
      const product = await workProductService(tx as unknown as Db).createForIssue(issue.id, issue.companyId, {
      type: "document", provider: "paperclip", externalId: `report:${run.id}:${output.path}`, title: path.posix.basename(output.path),
      createdByRunId: run.id, executionWorkspaceId: workspace.id, status: "ready_for_review", reviewState: "needs_board_review",
      metadata: { sha256: output.sha256, byteSize: output.byteSize,
        resourceRef: { kind: "workspace_file", issueId: issue.id, ...(issue.projectId ? { projectId: issue.projectId } : {}),
          workspaceKind: "execution_workspace", workspaceId: workspace.id, relativePath: output.path, displayPath: output.path },
        reportDelivery: { version: 1, sourceRunId: run.id, contractHash: baseline.contractHash, baselineSha256: baseline.outputs.find(file => file.path === output.path)?.sha256 ?? null } },
      }, { agentId: run.agentId, runId: run.id });
      if (!product) throw new Error("report_work_product_not_committed");
      workProductIds.push(product.id);
    }
    const transition = nativeReview ? { patch: {} } : applyIssueExecutionPolicyTransition({ issue, policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
      requestedStatus: "in_review", requestedAssigneePatch: {}, actor: { agentId: run.agentId },
      reviewRequest: { instructions: "Inspect the registered report work products and decide the next action. Report submission does not certify the inspected source or project delivery." } });
    const submitted = nativeReview ? issue : await issueService(db).update(issue.id, { companyGuard: issue.companyId, actorAgentId: run.agentId,
      status: "in_review", ...transition.patch }, tx);
    const reviewState = parseIssueExecutionState(submitted?.executionState);
    if (submitted?.status !== "in_review" || !reviewState?.currentParticipant) throw new Error("report_review_path_not_committed");
    if (reviewState.currentParticipant.type === "agent" && reviewState.currentParticipant.agentId) {
      const executionStage = { wakeRole: "reviewer", stageId: reviewState.currentStageId, stageType: "review",
        currentParticipant: reviewState.currentParticipant, returnAssignee: reviewState.returnAssignee,
        reviewRequest: reviewState.reviewRequest, allowedActions: ["approve", "request_changes"] };
      await tx.insert(agentWakeupRequests).values({ companyId: issue.companyId, agentId: reviewState.currentParticipant.agentId,
        source: "assignment", triggerDetail: "system", reason: "execution_review_requested", status: "queued",
        requestedByActorType: "system", requestedByActorId: "report-delivery-observer", idempotencyKey: `report-review:${run.id}`,
        payload: { issueId: issue.id, sourceRunId: run.id, _paperclipWakeContext: { issueId: issue.id, taskId: issue.id,
          wakeReason: "execution_review_requested", source: "issue.report_delivery", executionStage } } });
    }
    await logActivity(tx as unknown as Db, { companyId: issue.companyId, actorType: "system", actorId: "report-delivery-observer", runId: run.id,
      action: "issue.report_delivery_submitted", entityType: "issue", entityId: issue.id,
      details: { version: 1, sourceRunId: run.id, contractHash: baseline.contractHash, workProductIds, outputs, acceptance: "unreviewed", reviewer: reviewState.currentParticipant } });
    return { state: "submitted", workProductIds, reviewer: reviewState.currentParticipant };
  });
  const [previousObservation] = await db.select({ details: activityLog.details }).from(activityLog).where(and(
    eq(activityLog.companyId, input.companyId), eq(activityLog.runId, input.runId), eq(activityLog.actorType, "system"),
    eq(activityLog.actorId, "report-delivery-observer"), eq(activityLog.action, "issue.report_delivery_observed")))
    .orderBy(desc(activityLog.createdAt)).limit(1);
  const attempt = Number(object(previousObservation?.details).attempt ?? 0) + 1;
  const terminal = result.state === "submitted" || result.state === "stale" || result.state === "not_configured" || attempt >= 3;
  await logActivity(db, { companyId: input.companyId, actorType: "system", actorId: "report-delivery-observer", runId: input.runId,
    action: "issue.report_delivery_observed", entityType: "issue", entityId: input.issueId,
    details: { version: 1, state: result.state, code: result.code ?? null, terminal, attempt,
      ...(terminal && result.state !== "submitted" ? { nextAction: "The task owner must inspect the preserved run and declared report files, then record a truthful disposition or explicit scoped continuation. No report acceptance or additional provider attempt was granted." } : {}) } });
  await db.update(heartbeatRuns).set({ resultJson: sql`coalesce(${heartbeatRuns.resultJson}, '{}'::jsonb) || ${JSON.stringify({ reportDeliveryObservation: {
    version: 1, state: result.state, code: result.code ?? null, terminal, attempt, observedAt: new Date().toISOString(),
  } })}::jsonb` }).where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId)));
  return result;
}
