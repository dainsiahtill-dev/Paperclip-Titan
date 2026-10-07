import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, agentWakeupRequests, authUsers, companies, companyMemberships, completionContracts, createDb, environmentLeases, executionWorkspaces, heartbeatRuns, issueWorkProducts, issues, nativeRunFinalizations, nativeRunResults, projects, projectWorkspaces, statusDecisions, workAssessments, workspaceOperations, workspaceWriteOwners } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { captureReportDeliveryBaseline, prepareNativeReportReview, sealReportDeliveryOutputs, submitReportDelivery } from "./report-delivery.js";
import { issueService } from "./issues.js";
import { applyIssueExecutionPolicyTransition, normalizeIssueExecutionPolicy } from "./issue-execution-policy.js";
import { createIssueWorkProductSchema } from "@paperclipai/shared";
import { workProductMaterialSnapshot } from "./work-product-material.js";
import { workspaceFileResourceService } from "./workspace-file-resources.js";
import { heartbeatService } from "./heartbeat.js";
import { PaperclipControlPlanePort } from "./native-runtime/paperclip-control-plane-port.js";
import { finalizeNativeRun } from "./native-runtime/native-run-finalizer.js";
import { commitNativeStatusDecision, NativeStatusRaceError } from "./native-runtime/status-decision-committer.js";
import { CONTROL_PLANE_CONFORMANCE_RESULT, CONTROL_PLANE_CONFORMANCE_TERMINAL } from "../vendor/paperclip-runner/testing.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("controller-observed report delivery", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  const roots: string[] = [];
  beforeAll(async () => {
    database = await startEmbeddedPostgresTestDatabase("paperclip-report-delivery-");
    db = createDb(database.connectionString);
    await db.insert(authUsers).values({ id: "report-board", name: "Review owner", email: "report-board@example.test", emailVerified: true, createdAt: new Date(), updatedAt: new Date() });
  }, 20000);
  afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
  afterAll(async () => { await database?.cleanup(); });
  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), runId = randomUUID(), workspaceId = randomUUID();
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "report-output-")); roots.push(root);
    await fs.mkdir(path.join(root, "reports"));
    await db.insert(companies).values({ id: companyId, name: "Report fixture", issuePrefix: "R" + companyId.replace(/-/g, "").slice(0, 7), defaultResponsibleUserId: "report-board", requireBoardApprovalForNewAgents: false });
    await db.insert(companyMemberships).values({ companyId, principalType: "user", principalId: "report-board", status: "active", membershipRole: "owner" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Independent audit", role: "qa", adapterType: "codex_local", status: "idle" });
    await db.insert(projects).values({ id: projectId, companyId, name: "Reports" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, mode: "shared_workspace", strategyType: "project_primary", name: "Reports", cwd: root });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "running", invocationSource: "on_demand", runtimeMode: "legacy", contextSnapshot: { issueId, paperclipWorkspace: { cwd: root } } });
    await db.insert(issues).values({ id: issueId, companyId, projectId, executionWorkspaceId: workspaceId, title: "Independent review", status: "in_progress", assigneeAgentId: agentId, executionRunId: runId, responsibleUserId: "report-board",
      executionPolicy: { mode: "normal", commentRequired: true, resourceLimits: { maxNoProgressRuns: 1, maxAutomaticRuns: 1 },
        reportDelivery: { version: 1, files: ["reports/REPORT.md", "reports/REPORT.json"] },
        stages: [{ id: randomUUID(), type: "review", approvalsNeeded: 1, participants: [{ id: randomUUID(), type: "user", userId: "report-board" }] }] } });
    return { companyId, agentId, projectId, issueId, runId, workspaceId, root };
  }
  async function prepare(s: Awaited<ReturnType<typeof seed>>) {
    const baseline = await captureReportDeliveryBaseline(db, s);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: s.issueId, paperclipWorkspace: { cwd: s.root }, reportDeliveryBaseline: baseline } }).where(eq(heartbeatRuns.id, s.runId));
  }
  async function finish(s: Awaited<ReturnType<typeof seed>>, status = "succeeded") {
    await db.update(heartbeatRuns).set({ status, finishedAt: new Date() }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(workspaceOperations).values({ companyId: s.companyId, issueId: s.issueId, executionWorkspaceId: s.workspaceId, heartbeatRunId: s.runId,
      phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
    if (status === "succeeded") await sealReportDeliveryOutputs(db, s);
  }
  async function write(s: Awaited<ReturnType<typeof seed>>) {
    await fs.writeFile(path.join(s.root, "reports/REPORT.md"), "# Review complete\nFound a defect; source acceptance is rejected.\n");
    await fs.writeFile(path.join(s.root, "reports/REPORT.json"), JSON.stringify({ status: "completed_with_findings", acceptance: "FAIL", runId: s.runId }));
  }
  it("submits actual adverse findings for human review without approving the source or spending another run", async () => {
    const s = await seed(); await prepare(s); await write(s); await finish(s);
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    expect(issue).toMatchObject({ status: "in_review", assigneeAgentId: null, assigneeUserId: "report-board",
      executionState: { status: "pending", currentParticipant: { type: "user", userId: "report-board" }, returnAssignee: { type: "agent", agentId: s.agentId } } });
    expect(issue.executionPolicy?.resourceLimits).toEqual({ maxNoProgressRuns: 1, maxAutomaticRuns: 1 });
    const products = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId));
    expect(products).toHaveLength(2);
    for (const product of products) {
      expect(product).toMatchObject({ createdByRunId: s.runId, reviewState: "needs_board_review", metadata: { resourceRef: { kind: "workspace_file" } } });
      expect(createIssueWorkProductSchema.safeParse(product).success).toBe(true);
      expect(await workProductMaterialSnapshot(db, product)).toMatchObject({ workProductId: product.id });
      const ref = product.metadata?.resourceRef as { relativePath: string; projectId: string; workspaceId: string };
      expect(await workspaceFileResourceService(db).readContent(s.issueId, { path: ref.relativePath, workspace: "execution",
        projectId: ref.projectId, workspaceId: ref.workspaceId })).toMatchObject({ resource: { workspaceId: s.workspaceId }, content: { encoding: "utf8" } });
    }
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId)))).toHaveLength(1);
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted" });
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(2);
  });
  it("creates a Board review with a real human owner when no reviewer stage was declared", async () => {
    const s = await seed();
    const created = await issueService(db).create(s.companyId, { title: "Board review creation", status: "in_review", projectId: s.projectId,
      assigneeAgentId: s.agentId, createdByUserId: "report-board", responsibleUserId: "report-board",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], resourceLimits: { maxAutomaticRuns: 1 } } });
    expect(created).toMatchObject({ status: "in_review", assigneeAgentId: null, assigneeUserId: "report-board" });
    expect(created.executionPolicy?.resourceLimits).toEqual({ maxAutomaticRuns: 1 });
  });
  it.each(["missing_project", "missing_workspace", "self_review", "review_before_production"] as const)("rejects an unusable declared report task before creation: %s", async kind => {
    const s = await seed();
    if (kind === "self_review" || kind === "review_before_production") await db.insert(projectWorkspaces).values({ companyId: s.companyId, projectId: s.projectId, name: "Local reports", cwd: s.root, isPrimary: true });
    const policy = { mode: "normal" as const, commentRequired: true, resourceLimits: { maxAutomaticRuns: 1 }, reportDelivery: { version: 1 as const, files: ["reports/REPORT.md"] },
      stages: [{ id: randomUUID(), type: "review" as const, approvalsNeeded: 1 as const, participants: [kind === "self_review" ? { id: randomUUID(), type: "agent" as const, agentId: s.agentId } : { id: randomUUID(), type: "user" as const, userId: "report-board" }] }] };
    await expect(issueService(db).create(s.companyId, { title: "Invalid declaration", status: kind === "review_before_production" ? "in_review" : "backlog", projectId: kind === "missing_project" ? null : s.projectId,
      assigneeAgentId: s.agentId, createdByUserId: "report-board", executionPolicy: policy })).rejects.toMatchObject({ status: 422,
        details: { code: kind === "self_review" ? "report_review_participant_required" : kind === "review_before_production" ? "report_delivery_start_status_invalid" : "report_workspace_required" } });
    expect(await db.select().from(issues).where(eq(issues.companyId, s.companyId))).toHaveLength(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).toHaveLength(1);
  });
  it("rejects editing an existing report contract into a producer-only review", async () => {
    const s = await seed();
    const before = (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0];
    const policy = { ...before.executionPolicy!, stages: [{ id: randomUUID(), type: "review" as const, approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "agent" as const, agentId: s.agentId }] }] };
    await expect(issueService(db).update(s.issueId, { executionPolicy: policy, actorUserId: "report-board" })).rejects.toMatchObject({ status: 422,
      details: { code: "report_review_participant_required" } });
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0].executionPolicy).toEqual(before.executionPolicy);
  });
  it("preflights an invalid report producer before mutation and repeats rejection under the update lock", async () => {
    const s = await seed();
    const before = (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0];
    const svc = issueService(db);
    const policy = { ...before.executionPolicy!, stages: [{ id: randomUUID(), type: "review" as const, approvalsNeeded: 1 as const,
      participants: [{ id: randomUUID(), type: "agent" as const, agentId: s.agentId }] }] };
    await expect(svc.assertReportReviewers(s.companyId, { ...policy, mode: "normal", commentRequired: true }, s.agentId)).rejects.toMatchObject({ status: 422,
      details: { code: "report_review_participant_required" } });
    await expect(svc.assertReportReassignmentAdmission(before, { executionPolicy: policy, assigneeAgentId: s.agentId })).rejects.toMatchObject({ status: 422,
      details: { code: "report_review_participant_required" } });
    await expect(svc.assertReportReassignmentAdmission(before, { projectId: randomUUID() })).rejects.toMatchObject({ status: 422,
      details: { code: "report_workspace_required" } });
    await expect(svc.update(s.issueId, { executionPolicy: policy, assigneeAgentId: s.agentId, actorUserId: "report-board" })).rejects.toMatchObject({ status: 422 });
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]).toEqual(before);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, s.runId)))[0].status).toBe("running");
  });
  it("keeps the original producer when a first agent review transition includes its report policy", async () => {
    const s = await seed();
    const reviewerId = randomUUID();
    await db.insert(agents).values({ id: reviewerId, companyId: s.companyId, name: "Report reviewer", role: "qa", adapterType: "codex_local", status: "idle" });
    const issue = (await db.select().from(issues).where(eq(issues.id, s.issueId)))[0];
    const policy = normalizeIssueExecutionPolicy({ ...issue.executionPolicy!, stages: [{ id: randomUUID(), type: "review", participants: [{ type: "agent", agentId: reviewerId }] }] })!;
    const transition = applyIssueExecutionPolicyTransition({ issue, policy, requestedStatus: "in_review", requestedAssigneePatch: {}, actor: { userId: "report-board" }, allowBoardOverride: true });
    await expect(issueService(db).assertReportReassignmentAdmission(issue, { ...transition.patch, executionPolicy: { ...policy } })).resolves.toBeUndefined();
    const updated = await issueService(db).update(s.issueId, { ...transition.patch, executionPolicy: { ...policy }, actorUserId: "report-board" });
    expect(updated).toMatchObject({ status: "in_review", assigneeAgentId: reviewerId,
      executionState: { returnAssignee: { type: "agent", agentId: s.agentId }, currentParticipant: { type: "agent", agentId: reviewerId } } });
  });
  it("recovers a terminal run's pending report without another provider attempt", async () => {
    const s = await seed(); await prepare(s); await write(s); await finish(s);
    await db.update(issues).set({ executionRunId: null }).where(eq(issues.id, s.issueId));
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]?.status).toBe("in_review");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).toHaveLength(1);
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(2);
  });
  it("reads products from the run-bound workspace when issue isolation pointers are disabled", async () => {
    const s = await seed();
    await db.update(issues).set({ executionWorkspaceId: null }).where(eq(issues.id, s.issueId));
    await db.update(executionWorkspaces).set({ sourceIssueId: s.issueId }).where(eq(executionWorkspaces.id, s.workspaceId));
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: s.issueId, executionWorkspaceId: s.workspaceId, paperclipWorkspace: { cwd: s.root } } }).where(eq(heartbeatRuns.id, s.runId));
    const baseline = await captureReportDeliveryBaseline(db, s);
    await db.update(heartbeatRuns).set({ contextSnapshot: { issueId: s.issueId, executionWorkspaceId: s.workspaceId, paperclipWorkspace: { cwd: s.root }, reportDeliveryBaseline: baseline } }).where(eq(heartbeatRuns.id, s.runId));
    await write(s); await finish(s);
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted" });
    const products = await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId));
    for (const product of products) expect(await workProductMaterialSnapshot(db, product)).toMatchObject({ workProductId: product.id });
  });
  it("prevents the executor from removing its declared report contract", async () => {
    const s = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    await expect(issueService(db).update(s.issueId, { companyGuard: s.companyId, actorAgentId: s.agentId,
      executionPolicy: { ...issue.executionPolicy, reportDelivery: null } })).rejects.toMatchObject({ status: 403 });
  });
  it("requires board authority to create a controller-observed report contract", async () => {
    const s = await seed();
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    await expect(issueService(db).create(s.companyId, { title: "Agent-owned observer policy", createdByAgentId: s.agentId,
      executionPolicy: issue.executionPolicy })).rejects.toMatchObject({ status: 403 });
  });
  it("does not attribute a prior unchanged JSON report to the current run", async () => {
    const s = await seed(); await write(s); await prepare(s);
    await fs.writeFile(path.join(s.root, "reports/REPORT.md"), "# A new review\nNew findings.\n");
    await finish(s);
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "not_ready", code: "report_outputs_unchanged" });
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(0);
  });
  it("rejects files changed after the host sealed the source output", async () => {
    const s = await seed(); await prepare(s); await write(s); await finish(s);
    await fs.writeFile(path.join(s.root, "reports/REPORT.md"), "Another writer's later report\n");
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "not_ready", code: "report_settled_outputs_not_verified" });
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(0);
  });
  it("cannot use provider result markers as a host output seal", async () => {
    const s = await seed(); await prepare(s); await write(s);
    await db.update(heartbeatRuns).set({ status: "succeeded", resultJson: { reportDeliveryObservation: { terminal: true, state: "submitted" } } }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(workspaceOperations).values({ companyId: s.companyId, issueId: s.issueId, executionWorkspaceId: s.workspaceId,
      heartbeatRunId: s.runId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "not_ready", code: "report_settled_outputs_not_verified" });
  });
  it("does not let an old native finalizer take a newer run's execution ownership", async () => {
    const s = await seed(); await prepare(s); await write(s); await finish(s);
    const nextRunId = randomUUID();
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: s.issueId, startedAt: new Date(Date.now() - 10000) }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: s.companyId, agentId: s.agentId, status: "running", runtimeMode: "native",
      nativeIssueId: s.issueId, invocationSource: "on_demand", startedAt: new Date(), contextSnapshot: { issueId: s.issueId } });
    await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, s.issueId));
    expect(await prepareNativeReportReview(db, s)).toBe(false);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]).toMatchObject({ status: "in_progress", executionRunId: nextRunId, assigneeAgentId: s.agentId });
  });
  it("can replace known empty placeholders without granting progress for empty final outputs", async () => {
    const s = await seed();
    await fs.writeFile(path.join(s.root, "reports/REPORT.md"), "");
    await fs.writeFile(path.join(s.root, "reports/REPORT.json"), "\n");
    await prepare(s); await write(s); await finish(s);
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted" });
  });
  it("commits one recoverable review wake intent with the report transaction", async () => {
    const s = await seed(); const reviewerId = randomUUID();
    await db.insert(agents).values({ id: reviewerId, companyId: s.companyId, name: "Reviewer", role: "qa", status: "idle", adapterType: "codex_local" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    const policy = normalizeIssueExecutionPolicy(issue.executionPolicy)!;
    policy.stages[0].participants = [{ id: randomUUID(), type: "agent", agentId: reviewerId }];
    await db.update(issues).set({ executionPolicy: { ...policy } }).where(eq(issues.id, s.issueId));
    await prepare(s); await write(s); await finish(s);
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted", reviewer: { type: "agent", agentId: reviewerId } });
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted", reviewer: { type: "agent", agentId: reviewerId } });
    const intents = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, s.companyId));
    expect(intents).toHaveLength(1);
    expect(intents[0]).toMatchObject({ status: "queued", runId: null, requestedByActorId: "report-delivery-observer", agentId: reviewerId,
      payload: { _paperclipWakeContext: { source: "issue.report_delivery", executionStage: { stageId: policy.stages[0].id } } } });
    await db.update(agents).set({ runtimeConfig: { heartbeat: { enabled: false, wakeOnDemand: false } } }).where(eq(agents.id, reviewerId));
    const resumed = await heartbeatService(db).dispatchPendingNativeStatusWakeups({ companyId: s.companyId });
    expect(resumed.dispatched).toBe(0);
    const [receipt] = await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.id, intents[0].id));
    expect(receipt.status).toBe("skipped");
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, s.companyId))).toHaveLength(1);
  });
  it("uses native settlement without rewriting its unprotected ownership history", async () => {
    const s = await seed(); await prepare(s); await write(s); await finish(s);
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    const transition = applyIssueExecutionPolicyTransition({ issue, policy: normalizeIssueExecutionPolicy(issue.executionPolicy),
      actor: { agentId: s.agentId }, requestedStatus: "in_review", requestedAssigneePatch: {} });
    await issueService(db).update(s.issueId, { ...transition.patch, actorAgentId: s.agentId }, db);
    const contractId = randomUUID(), resultId = randomUUID(), assessmentId = randomUUID(), decisionId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: s.companyId, issueId: s.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "low", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: {}, canonicalSha256: contractId, createdByActorType: "system", createdByActorId: "fixture" });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: s.issueId, nativePhase: "committed", completionContractId: contractId }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(nativeRunResults).values({ id: resultId, companyId: s.companyId, issueId: s.issueId, runId: s.runId,
      completionContractId: contractId, serverFingerprint: resultId, schemaStatus: "accepted", resultJson: {}, canonicalSha256: resultId });
    await db.insert(workAssessments).values({ id: assessmentId, companyId: s.companyId, issueId: s.issueId, runId: s.runId,
      contractId, resultId, triggerKind: "turn_finished", triggerActorCompanyId: s.companyId, priorIssueStatus: "in_progress", priorStatusVersion: 0,
      policyVersion: "fixture", assessmentJson: {}, inputDigest: assessmentId });
    await db.insert(statusDecisions).values({ id: decisionId, companyId: s.companyId, issueId: s.issueId, runId: s.runId,
      assessmentId, decisionVersion: 1, policyVersion: "fixture", fromStatus: "in_progress", toStatus: "in_review", reasonCode: "review_required",
      decisionJson: {}, decisionDigest: decisionId, applicationState: "applied", appliedAt: new Date() });
    await db.update(issues).set({ lastStatusDecisionId: decisionId }).where(eq(issues.id, s.issueId));
    await db.insert(nativeRunFinalizations).values({ companyId: s.companyId, issueId: s.issueId, runId: s.runId, phase: "committed",
      resultId, assessmentId, decisionId });
    await db.insert(environmentLeases).values({ companyId: s.companyId, heartbeatRunId: s.runId, status: "released", releasedAt: new Date() });
    const [owner] = await db.insert(workspaceWriteOwners).values({ companyId: s.companyId, runId: s.runId, issueId: s.issueId,
      resourceKey: randomUUID(), realm: "native-fixture", canonicalRoot: s.root, device: "fixture", inode: "fixture", generation: randomUUID(), state: "unprotected", history: [] }).returning();
    expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted" });
    expect((await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, owner.id)))[0]).toMatchObject({ state: "unprotected", history: [], stopReceipt: null });
    const [beforeRace] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    const racingRunId = randomUUID();
    await db.insert(heartbeatRuns).values({ id: racingRunId, companyId: s.companyId, agentId: s.agentId, status: "running",
      runtimeMode: "native", nativeIssueId: s.issueId, invocationSource: "on_demand", contextSnapshot: { issueId: s.issueId } });
    await db.update(issues).set({ executionRunId: racingRunId }).where(eq(issues.id, s.issueId));
    await expect(commitNativeStatusDecision({ db, companyId: s.companyId, issueId: s.issueId, runId: s.runId,
      assessmentId: randomUUID(), supersedesCommittedDecisionId: decisionId, priorStatus: beforeRace.status,
      priorStatusVersion: beforeRace.statusVersion, priorDecisionId: beforeRace.lastStatusDecisionId,
      requireReportBinding: { executionRunId: beforeRace.executionRunId, executionState: beforeRace.executionState,
        assigneeAgentId: beforeRace.assigneeAgentId, assigneeUserId: beforeRace.assigneeUserId },
      decision: { policyVersion: "phase6-v5", statusAction: "in_review", toStatus: "in_review", reasonCode: "report-race-fixture",
        unblockDescriptor: null, effects: [] } })).rejects.toBeInstanceOf(NativeStatusRaceError);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]?.executionRunId).toBe(racingRunId);
  });
  it.each(["sealed", "missing_seal", "changed_contract", "newer_owner"])("native initial completion cannot bypass report governance (%s)", async scenario => {
    const sealed = scenario !== "missing_seal";
    const s = await seed();
    const contractId = randomUUID(), sessionId = randomUUID(), runnerInstanceId = randomUUID();
    await db.insert(completionContracts).values({ id: contractId, companyId: s.companyId, issueId: s.issueId, revision: 1,
      schemaVersion: "paperclip.completion-contract.v1", policyVersion: "fixture", risk: "standard", completionAuthority: "server_arbiter",
      incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: { revision: "1", objective: "Produce an independent report", criteria: [{ id: "objective", requirement: "Produce a report" }] },
      canonicalSha256: "report-contract", createdByActorType: "system", createdByActorId: "fixture" });
    await db.update(heartbeatRuns).set({ runtimeMode: "native", nativeIssueId: s.issueId, nativeSessionId: sessionId,
      runnerInstanceId, completionContractId: contractId, completionContractSha256: "report-contract" }).where(eq(heartbeatRuns.id, s.runId));
    await prepare(s); await write(s);
    await db.insert(workspaceOperations).values({ companyId: s.companyId, issueId: s.issueId, executionWorkspaceId: s.workspaceId,
      heartbeatRunId: s.runId, phase: "workspace_finalize", status: "succeeded", finishedAt: new Date() });
    if (sealed) await sealReportDeliveryOutputs(db, s);
    const port = new PaperclipControlPlanePort(db, { companyId: s.companyId, issueId: s.issueId, runId: s.runId, agentId: s.agentId,
      sessionId, completionContractId: contractId, completionContractSha256: "report-contract", sourceInstanceId: runnerInstanceId, controlPlaneSourceInstanceId: "report-controller" });
    await port.openRun({ identity: { companyId: s.companyId, issueId: s.issueId, runId: s.runId, agentId: s.agentId, sessionId }, backendKind: "mock", sourceInstanceId: runnerInstanceId });
    await port.completeRun({ result: CONTROL_PLANE_CONFORMANCE_RESULT, terminal: CONTROL_PLANE_CONFORMANCE_TERMINAL, callerResultId: "initial-report-result" });
    let nextRunId: string | null = null;
    if (scenario === "changed_contract") {
      const [currentIssue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
      await db.update(issues).set({ executionPolicy: { ...currentIssue.executionPolicy, reportDelivery: { version: 1, files: ["reports/OTHER.md"] } } }).where(eq(issues.id, s.issueId));
    }
    if (scenario === "newer_owner") {
      nextRunId = randomUUID();
      await db.insert(heartbeatRuns).values({ id: nextRunId, companyId: s.companyId, agentId: s.agentId, status: "running", runtimeMode: "native",
        nativeIssueId: s.issueId, invocationSource: "on_demand", startedAt: new Date(), contextSnapshot: { issueId: s.issueId } });
      await db.update(issues).set({ executionRunId: nextRunId }).where(eq(issues.id, s.issueId));
    }
    await finalizeNativeRun({ db, runId: s.runId, workspaceFinalizeStatus: "succeeded" });
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    if (scenario === "changed_contract" || scenario === "newer_owner") {
      expect(issue.status).toBe("in_progress");
      if (nextRunId) expect(issue.executionRunId).toBe(nextRunId);
      expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(0);
      return;
    }
    expect(issue).toMatchObject({ status: "in_review", assigneeUserId: "report-board", executionState: { status: "pending" } });
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.runId));
    await db.insert(environmentLeases).values({ companyId: s.companyId, heartbeatRunId: s.runId, status: "released", releasedAt: new Date() });
    if (sealed) expect(await submitReportDelivery(db, s)).toMatchObject({ state: "submitted" });
    else {
      expect(await submitReportDelivery(db, s)).toMatchObject({ state: "not_ready", code: "report_settled_outputs_not_verified" });
      expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(0);
      expect(JSON.stringify(issue.executionState)).toContain("not verified");
    }
  });
  it.each(["missing", "empty", "unchanged", "failed", "unfinished_workspace", "reassigned", "policy_changed", "cross_company", "symlink"])("does not submit %s evidence", async scenario => {
    const s = await seed();
    if (scenario === "unchanged") await write(s);
    await prepare(s);
    if (scenario !== "missing") await write(s);
    if (scenario === "empty") await fs.writeFile(path.join(s.root, "reports/REPORT.md"), "   \n");
    if (scenario === "symlink") { await fs.unlink(path.join(s.root, "reports/REPORT.md")); await fs.symlink("REPORT.json", path.join(s.root, "reports/REPORT.md")); }
    await finish(s, scenario === "failed" ? "failed" : "succeeded");
    if (scenario === "unfinished_workspace") await db.update(workspaceOperations).set({ status: "failed" }).where(eq(workspaceOperations.heartbeatRunId, s.runId));
    if (scenario === "reassigned") await db.update(issues).set({ assigneeAgentId: null, assigneeUserId: "report-board" }).where(eq(issues.id, s.issueId));
    if (scenario === "policy_changed") await db.update(issues).set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [] } }).where(eq(issues.id, s.issueId));
    const result = await submitReportDelivery(db, { ...s, ...(scenario === "cross_company" ? { companyId: randomUUID() } : {}) });
    expect(result.state).not.toBe("submitted");
    expect(await db.select().from(issueWorkProducts).where(eq(issueWorkProducts.issueId, s.issueId))).toHaveLength(0);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]?.status).toBe("in_progress");
  });
});
