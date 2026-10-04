import { createHash, randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, assets, companies, companyMemberships, completionContracts, createDb, heartbeatRuns, issueAttachments, issueComments, issueWorkProducts, issues, projects } from "@paperclipai/db";
import { issueDeliveryDecisions } from "@paperclipai/db/schema/issue_delivery_decisions";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { classifyNativeEvidence } from "../services/native-runtime/evidence-classifier.js";
import { ensureNativeCompletionContract } from "../services/native-runtime/completion-contracts.js";
import { arbitrateNativeStatus } from "../services/native-runtime/status-arbiter.js";
import { eq } from "drizzle-orm";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("delivery authority API boundary", () => {
  let db!: ReturnType<typeof createDb>;
  let temp!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { temp = await startEmbeddedPostgresTestDatabase("paperclip-delivery-authority-"); db = createDb(temp.connectionString); }, 30_000);
  afterAll(async () => { await temp?.cleanup(); });
  afterEach(async () => { await db.delete(issueDeliveryDecisions); await db.delete(completionContracts); await db.delete(activityLog); await db.delete(issueComments); await db.delete(issueWorkProducts); await db.delete(issueAttachments); await db.delete(assets); await db.delete(heartbeatRuns); await db.delete(issues); await db.delete(projects); await db.delete(agents); await db.delete(companyMemberships); await db.delete(companies); });

  async function seedExecutor() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Isolated delivery authority", issuePrefix: `A${companyId.slice(0, 6).toUpperCase()}`, requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Executor", role: "engineer", status: "active", adapterType: "process", adapterConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Deliver inspected report", status: "todo", assigneeAgentId: agentId, createdAt: new Date(Date.now() - 60_000) });
    // A real persisted legacy run provides request attribution. No native
    // assessment/finalization row is manufactured to satisfy an unrelated FK.
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, runtimeMode: "legacy", status: "running", contextSnapshot: { issueId } });
    const appForActor = (actor: Record<string, unknown>) => {
      const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).actor = actor; next(); });
      app.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null, deliveryEnqueueWakeup: null } as any)); app.use(errorHandler); return app;
    };
    const app = appForActor({ type: "agent", agentId, companyId, runId, source: "agent_jwt" });
    return { app, appForActor, companyId, agentId, issueId, runId };
  }

  it("executor-written approved display fields cannot become authoritative criterion evidence", async () => {
    const s = await seedExecutor();
    const create = await request(s.app).post(`/api/issues/${s.issueId}/work-products`).send({ type: "document", provider: "custom", title: "Report", summary: "Unreviewed report content", status: "draft", reviewState: "none" });
    expect(create.status, JSON.stringify(create.body)).toBe(201);
    const update = await request(s.app).patch(`/api/work-products/${create.body.id}`).send({ status: "approved", reviewState: "approved" });
    expect(update.status, JSON.stringify(update.body)).toBe(200);
    expect(update.body).toMatchObject({ status: "approved", reviewState: "approved" });
    const assessment = await classifyNativeEvidence({ db, companyId: s.companyId, issueId: s.issueId, runId: s.runId,
      contract: { revision: "1", objective: "Deliver report", criteria: [{ id: "report", requirement: "Deliver independently inspected report" }] },
      result: { summary: "Executor claims report accepted", reportedWorkDisposition: "done", completionClaim: { contractRevision: "1", objectiveSatisfied: true, criteria: [{ criterionId: "report", status: "satisfied", evidenceRefs: [`work_product:${create.body.id}`] }] }, verification: [], remainingWork: [] },
    });
    expect(assessment.criterionAssessments[0]!.evidenceRefs[0]!.outcome).toBe("unverifiable");
    expect(assessment.allCriteriaSatisfied).toBe(false);
  });

  async function verifiedFixture() {
    const s = await seedExecutor(), reviewerId = randomUUID(), reviewerRunId = randomUUID();
    await db.insert(agents).values({ id: reviewerId, companyId: s.companyId, name: "Independent QA", role: "qa", status: "active", adapterType: "process", adapterConfig: {} });
    await db.insert(heartbeatRuns).values({ id: reviewerRunId, companyId: s.companyId, agentId: reviewerId, status: "running", runtimeMode: "legacy", contextSnapshot: { issueId: s.issueId } });
    await db.insert(companyMemberships).values({ companyId: s.companyId, principalType: "user", principalId: "authority-board", status: "active", membershipRole: "owner" });
    const board = s.appForActor({ type: "board", userId: "authority-board", companyIds: [s.companyId], source: "cloud_tenant", memberships: [{ companyId: s.companyId, membershipRole: "owner", status: "active" }], isInstanceAdmin: false });
    const reviewer = s.appForActor({ type: "agent", agentId: reviewerId, companyId: s.companyId, runId: reviewerRunId, source: "agent_jwt" });
    const policy = { version: 1, mode: "verified_delivery", criteria: [{ id: "report", requirement: "Report meets declared content", artifactType: "document" }, { id: "format", requirement: "Report is readable", artifactType: "document" }], reviewerAgentIds: [reviewerId, s.agentId], managerAgentIds: [] };
    const configured = await request(board).put(`/api/issues/${s.issueId}/delivery-policy`).send(policy);
    expect(configured.status, JSON.stringify(configured.body)).toBe(200);
    const created = await request(s.app).post(`/api/issues/${s.issueId}/work-products`).send({ type: "document", provider: "custom", title: "Report", summary: "Current report content v1", status: "approved", reviewState: "approved", isPrimary: true });
    expect(created.status).toBe(201);
    const assessment = await request(board).get(`/api/issues/${s.issueId}/delivery-assessment`).expect(200);
    const decisionBody = (criterionId: string, current = assessment.body) => {
      const criterion = current.criteria.find((entry: any) => entry.id === criterionId);
      return { requestId: randomUUID(), criterionId, workProductId: created.body.id, expectedContractHash: current.contractHash, expectedCriterionDigest: criterion.criterionDigest, expectedMaterialVersion: criterion.materialVersion, expectedContentDigest: criterion.contentDigest, verdict: "accepted", reason: "Independent QA inspected this exact criterion and content." };
    };
    return { ...s, board, reviewer, reviewerId, reviewerRunId, policy, productId: created.body.id, assessment: assessment.body, decisionBody };
  }

  it("admits configured independent AI decisions while executor self-acceptance and early closure remain denied", async () => {
    const s = await verifiedFixture(); const url = `/api/issues/${s.issueId}/delivery-decisions`;
    await request(s.app).post(url).send(s.decisionBody("report")).expect(403);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(409);
    const body = s.decisionBody("report");
    const accepted = await request(s.reviewer).post(url).send(body).expect(201);
    expect(accepted.body).toMatchObject({ actorType: "agent", actorId: s.reviewerId, runId: s.reviewerRunId, criterionId: "report", verdict: "accepted" });
    const retry = await request(s.reviewer).post(url).send(body).expect(200);
    expect(retry.body).toEqual(accepted.body);
    await request(s.board).post(url).send(s.decisionBody("format")).expect(201);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(200);
  });

  it("preserves unaffected acceptance when one criterion changes and invalidates changed material", async () => {
    const s = await verifiedFixture(); const url = `/api/issues/${s.issueId}/delivery-decisions`;
    await request(s.reviewer).post(url).send(s.decisionBody("report")).expect(201);
    await request(s.reviewer).post(url).send(s.decisionBody("format")).expect(201);
    await request(s.board).put(`/api/issues/${s.issueId}/delivery-policy`).send({ ...s.policy, criteria: [s.policy.criteria[0], { ...s.policy.criteria[1], requirement: "Report must include a new format section" }] }).expect(200);
    const changed = await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`).expect(200);
    expect(changed.body.criteria.find((entry: any) => entry.id === "report").state).toBe("accepted");
    expect(changed.body.criteria.find((entry: any) => entry.id === "format").state).not.toBe("accepted");
    await request(s.reviewer).post(url).send(s.decisionBody("format", changed.body)).expect(201);
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ summary: "Changed report content v2" }).expect(200);
    const materialChanged = await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`).expect(200);
    expect(materialChanged.body.criteria.every((entry: any) => entry.state !== "accepted")).toBe(true);
    await request(s.reviewer).post(url).send(s.decisionBody("report", changed.body)).expect(409);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(409);
  });

  it("keeps ordinary low-risk legacy completion easy", async () => {
    const s = await seedExecutor();
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(200);
  });

  it("prevents executor policy erasure and project relocation from washing out required acceptance", async () => {
    const s = await verifiedFixture();
    await request(s.app).put(`/api/issues/${s.issueId}/delivery-policy`).send({ ...s.policy, mode: "agent_claim_policy" }).expect(403);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ executionPolicy: null }).expect(403);
    // Changing project identity changes the delivery authority scope even when
    // the task still retains its own policy. It cannot reuse old decisions.
    const projectId = randomUUID();
    const { projects } = await import("@paperclipai/db");
    await db.insert(projects).values({ id: projectId, companyId: s.companyId, name: "Escape project" });
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ projectId }).expect(403);
    await db.delete(projects).where(eq(projects.id, projectId));
  });

  it("reuses the real native contract and refuses claim-policy bypass until independent receipts exist", async () => {
    const s = await verifiedFixture();
    const [issue] = await db.select().from(issues).where(eq(issues.id, s.issueId));
    const native = await ensureNativeCompletionContract({ db, companyId: s.companyId, issue: issue!, actorId: s.agentId });
    expect(native.row.completionAuthority).toBe("server_arbiter");
    expect(native.contract.criteria.map((criterion) => criterion.id)).toEqual(["report", "format"]);
    const report = { summary: "Goal claimed complete", reportedWorkDisposition: "done", completionClaim: { contractRevision: native.contract.revision, objectiveSatisfied: true, criteria: native.contract.criteria.map((criterion) => ({ criterionId: criterion.id, status: "satisfied", evidenceRefs: [`work_product:${s.productId}`] })) }, verification: [], remainingWork: [] };
    const initial = await classifyNativeEvidence({ db, companyId: s.companyId, issueId: s.issueId, runId: s.runId, contract: native.row.contractJson, result: report });
    expect(arbitrateNativeStatus({ assessment: initial, terminalState: "succeeded", workspaceFinalizeStatus: "succeeded", completionClaimPolicyAccepted: true, agentId: s.agentId, priorIssueStatus: "in_progress" }).toStatus).not.toBe("done");
    await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report")).expect(201);
    await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("format")).expect(201);
    const accepted = await classifyNativeEvidence({ db, companyId: s.companyId, issueId: s.issueId, runId: s.runId, contract: native.row.contractJson, result: report });
    expect(arbitrateNativeStatus({ assessment: accepted, terminalState: "succeeded", workspaceFinalizeStatus: "succeeded", completionClaimPolicyAccepted: false, agentId: s.agentId, priorIssueStatus: "in_progress" }).toStatus).toBe("done");
  });

  it("derives review permissions on the server and honors human-only review policy", async () => {
    const s = await verifiedFixture();
    expect((await request(s.app).get(`/api/issues/${s.issueId}/delivery-assessment`)).body.permissions).toEqual({ canReview: false, canManagePolicy: false });
    expect((await request(s.reviewer).get(`/api/issues/${s.issueId}/delivery-assessment`)).body.permissions).toEqual({ canReview: true, canManagePolicy: false });
    expect((await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body.permissions).toEqual({ canReview: true, canManagePolicy: true });
    await db.update(issues).set({ reviewPolicy: "human_only" }).where(eq(issues.id, s.issueId));
    const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report", current)).expect(403);
    await request(s.board).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report", current)).expect(201);
  });

  it("retries an already recorded decision after run termination without minting another verdict", async () => {
    const s = await verifiedFixture(), body = s.decisionBody("report"), url = `/api/issues/${s.issueId}/delivery-decisions`;
    const accepted = await request(s.reviewer).post(url).send(body).expect(201);
    await db.update(heartbeatRuns).set({ status: "succeeded" }).where(eq(heartbeatRuns.id, s.reviewerRunId));
    expect((await request(s.reviewer).post(url).send(body).expect(200)).body.id).toBe(accepted.body.id);
    await request(s.reviewer).post(url).send({ ...body, requestId: randomUUID() }).expect(403);
    await request(s.board).post(url).send(body).expect(409);
  });

  it("does not trust an unchanged workspace reference after its actual file changes", async () => {
    const s = await verifiedFixture();
    const { projects, projectWorkspaces } = await import("@paperclipai/db");
    const root = await mkdtemp(join(tmpdir(), "delivery-material-")), projectId = randomUUID(), workspaceId = randomUUID();
    try {
      await writeFile(join(root, "report.md"), "Actual report v1");
      await db.insert(projects).values({ id: projectId, companyId: s.companyId, name: "Actual inspected workspace" });
      await db.insert(projectWorkspaces).values({ id: workspaceId, projectId, companyId: s.companyId, name: "Owned scratch", cwd: root, isPrimary: true });
      await db.update(issues).set({ projectId, projectWorkspaceId: workspaceId }).where(eq(issues.id, s.issueId));
      await request(s.app).patch(`/api/work-products/${s.productId}`).send({ metadata: { resourceRef: { kind: "workspace_file", issueId: s.issueId, workspaceKind: "project_workspace", projectId, workspaceId, relativePath: "report.md", displayPath: "report.md" } } }).expect(200);
      const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
      await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report", current)).expect(201);
      await writeFile(join(root, "report.md"), "Actual report v2");
      const changed = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
      expect(changed.criteria[0].state).toBe("stale");
      expect(changed.criteria[0].contentDigest).not.toBe(current.criteria[0].contentDigest);
      await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("format", current)).expect(409);
    } finally {
      await db.update(issues).set({ projectId: null, projectWorkspaceId: null }).where(eq(issues.id, s.issueId));
      await db.delete(projectWorkspaces).where(eq(projectWorkspaces.id, workspaceId)); await db.delete(projects).where(eq(projects.id, projectId)); await rm(root, { recursive: true });
    }
  });

  it("rejects executor-created self-manager policy and initial verified done bypass", async () => {
    const s = await verifiedFixture();
    await request(s.app).post(`/api/companies/${s.companyId}/issues`).send({ title: "Forged self authority", assigneeAgentId: s.agentId, executionPolicy: { stages: [], deliveryPolicy: { ...s.policy, managerAgentIds: [s.agentId] } } }).expect(403);
    await request(s.board).post(`/api/companies/${s.companyId}/issues`).send({ title: "Cannot start accepted", status: "done", assigneeAgentId: s.agentId, executionPolicy: { stages: [], deliveryPolicy: s.policy } }).expect(409);
  });

  it("inherits project verification through an ancestor with an unprojected child", async () => {
    const s = await seedExecutor(), projectId = randomUUID(), childId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: s.companyId, name: "Verified scope", deliveryPolicy: { version: 1, mode: "verified_delivery" } });
    await db.update(issues).set({ projectId }).where(eq(issues.id, s.issueId));
    await db.insert(issues).values({ id: childId, companyId: s.companyId, parentId: s.issueId, title: "Inherited work", assigneeAgentId: s.agentId, status: "todo", projectId: null });
    expect((await request(s.app).get(`/api/issues/${childId}/delivery-assessment`).expect(200)).body.mode).toBe("verified_delivery");
    await request(s.app).patch(`/api/issues/${childId}`).send({ status: "done" }).expect(409);
    await request(s.app).patch(`/api/issues/${childId}`).send({ parentId: null }).expect(403);
  });

  it("persists rejection feedback on the source once with its concrete owner", async () => {
    const s = await verifiedFixture(), body = { ...s.decisionBody("report"), verdict: "rejected", reason: "The required measurements are missing." }, url = `/api/issues/${s.issueId}/delivery-decisions`;
    await request(s.reviewer).post(url).send(body).expect(201);
    await request(s.reviewer).post(url).send(body).expect(200);
    const comments = await db.select().from(issueComments).where(eq(issueComments.issueId, s.issueId));
    expect(comments).toHaveLength(1);
    expect(comments[0]!.body).toContain("The required measurements are missing.");
    expect(comments[0]!.body).toContain("Executor");
    expect((await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body.criteria[0].state).toBe("rejected");
  });

  it("serializes concurrent content mutation and completion without accepting old material", async () => {
    const s = await verifiedFixture(), url = `/api/issues/${s.issueId}/delivery-decisions`;
    await request(s.reviewer).post(url).send(s.decisionBody("report")).expect(201);
    await request(s.reviewer).post(url).send(s.decisionBody("format")).expect(201);
    let entered!: () => void, release!: () => void;
    const ready = new Promise<void>((resolve) => { entered = resolve; }), gate = new Promise<void>((resolve) => { release = resolve; });
    const writer = db.transaction(async (tx) => {
      await tx.select().from(issues).where(eq(issues.id, s.issueId)).for("update");
      await tx.update(issueWorkProducts).set({ summary: "Concurrent material v2", materialVersion: 2 }).where(eq(issueWorkProducts.id, s.productId));
      entered(); await gate;
    });
    await ready;
    try { await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`).expect(409); } finally { release(); }
    await writer;
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(409);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!.status).toBe("todo");
  });

  it("reopens a completed verified task only when its accepted criterion or selected material changes", async () => {
    const s = await verifiedFixture(), url = `/api/issues/${s.issueId}/delivery-decisions`;
    await request(s.reviewer).post(url).send(s.decisionBody("report")).expect(201);
    await request(s.reviewer).post(url).send(s.decisionBody("format")).expect(201);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(200);
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ reviewState: "approved", healthStatus: "healthy" }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!.status).toBe("done");
    await request(s.board).put(`/api/issues/${s.issueId}/delivery-policy`).send({ ...s.policy, criteria: [s.policy.criteria[0], { ...s.policy.criteria[1], requirement: "New format condition" }] }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!.status).toBe("in_review");
    const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    expect(current.criteria[0].state).toBe("accepted");
    await request(s.reviewer).post(url).send(s.decisionBody("format", current)).expect(201);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(200);
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ summary: "New selected material after completion" }).expect(200);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!.status).toBe("in_review");
  });

  it("retains review lineage and denies deleting a run still referenced by its audit record", async () => {
    const s = await verifiedFixture();
    const result = await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report")).expect(201);
    await expect(db.delete(heartbeatRuns).where(eq(heartbeatRuns.id, s.reviewerRunId))).rejects.toMatchObject({ cause: { code: "23503" } });
    const [decision] = await db.select().from(issueDeliveryDecisions).where(eq(issueDeliveryDecisions.id, result.body.id));
    expect(decision!.runId).toBe(s.reviewerRunId);
    expect(decision!.actorId).toBe(s.reviewerId);
  });

  it("reopens completed work when an independent reviewer revokes current acceptance", async () => {
    const s = await verifiedFixture(), url = `/api/issues/${s.issueId}/delivery-decisions`;
    await request(s.reviewer).post(url).send(s.decisionBody("report")).expect(201);
    await request(s.reviewer).post(url).send(s.decisionBody("format")).expect(201);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(200);
    await request(s.reviewer).post(url).send({ ...s.decisionBody("report"), verdict: "rejected", reason: "Independent review found a reproducible error in the current report." }).expect(201);
    const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    expect(current.canComplete).toBe(false);
    expect(current.criteria[0].state).toBe("rejected");
    expect(current.criteria[1].state).toBe("accepted");
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!.status).toBe("in_review");
  });

  it("excludes the real managed asset producer even when another executor relays its work product", async () => {
    const s = await verifiedFixture(), assetId = randomUUID(), attachmentId = randomUUID(), body = Buffer.from("Material made by the reviewer, relayed by the executor");
    await db.insert(assets).values({ id: assetId, companyId: s.companyId, provider: "fixture", objectKey: assetId, contentType: "text/plain", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"), createdByAgentId: s.reviewerId });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId: s.companyId, issueId: s.issueId, assetId, originatingRunId: s.reviewerRunId });
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ metadata: { attachmentId } }).expect(200);
    const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report", current)).expect(403);
    expect(await db.select().from(issueDeliveryDecisions).where(eq(issueDeliveryDecisions.issueId, s.issueId))).toHaveLength(0);
  });

  it.each(["commit", "artifact"])("does not authenticate a claimed %s from its narration alone", async (artifactType) => {
    const s = await verifiedFixture();
    await request(s.board).put(`/api/issues/${s.issueId}/delivery-policy`).send({ ...s.policy, criteria: [{ id: "report", requirement: "Inspect tangible implementation content", artifactType }] }).expect(200);
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ type: artifactType, summary: "I implemented the code and all checks passed." }).expect(200);
    const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    expect(current.criteria[0].workProductId).toBeNull();
    expect(current.canComplete).toBe(false);
  });

  it("preserves immutable asset acceptance across display metadata and label edits", async () => {
    const s = await verifiedFixture(), assetId = randomUUID(), attachmentId = randomUUID(), body = Buffer.from("Immutable inspected report bytes");
    await db.insert(assets).values({ id: assetId, companyId: s.companyId, provider: "fixture", objectKey: assetId, contentType: "text/plain", byteSize: body.length, sha256: createHash("sha256").update(body).digest("hex"), createdByAgentId: s.agentId });
    await db.insert(issueAttachments).values({ id: attachmentId, companyId: s.companyId, issueId: s.issueId, assetId, originatingRunId: s.runId });
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ metadata: { attachmentId, displayLabel: "Before", healthStatus: "unknown", lastHealthCheckAt: "before" } }).expect(200);
    const initial = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("report", initial)).expect(201);
    await request(s.reviewer).post(`/api/issues/${s.issueId}/delivery-decisions`).send(s.decisionBody("format", initial)).expect(201);
    await request(s.app).patch(`/api/issues/${s.issueId}`).send({ status: "done" }).expect(200);
    await request(s.app).patch(`/api/work-products/${s.productId}`).send({ title: "New display title", summary: "New display summary", metadata: { attachmentId, displayLabel: "After", healthStatus: "healthy", lastHealthCheckAt: "after" } }).expect(200);
    const current = (await request(s.board).get(`/api/issues/${s.issueId}/delivery-assessment`)).body;
    expect(current.criteria.every((criterion: any) => criterion.state === "accepted")).toBe(true);
    expect(current.criteria[0].contentDigest).toBe(initial.criteria[0].contentDigest);
    expect((await db.select().from(issues).where(eq(issues.id, s.issueId)))[0]!.status).toBe("done");
  });
});
