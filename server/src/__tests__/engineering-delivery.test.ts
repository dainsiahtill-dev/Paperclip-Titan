import express from "express";
import request from "supertest";
import { executionWorkspaceRoutes } from "../routes/execution-workspaces.js";
import { issueRoutes } from "../routes/issues.js";
import { errorHandler } from "../middleware/index.js";
import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, companies, agents, issues, projects, executionWorkspaces, heartbeatRuns, documents, issueDocuments, issueWorkProducts, workspaceOperations } from "@paperclipai/db";
import { eq } from "drizzle-orm";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { resolvePaperclipInstanceRoot } from "../home-paths.js";
import { getWorkspaceOperationLogStore } from "../services/workspace-operation-log-store.js";
import { workspaceWriteOwnershipService } from "../services/workspace-write-ownership.js";
import { deliveryAuthorityService } from "../services/delivery-authority.js";
import { runWorkspaceJobForControl } from "../services/workspace-runtime.js";
import { workspaceOperationService } from "../services/workspace-operations.js";

// Actual isolated DB, host child, log store, source reader and existing decision authority.
describe("engineering verified delivery", () => {
  let db!: ReturnType<typeof createDb>, database!: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const roots: string[] = [];
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("pc-engineering-"); db = createDb(database.connectionString); }, 30000);
  afterAll(async () => { await database?.cleanup(); await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); });
  async function fixture() {
    const companyId = randomUUID(), projectId = randomUUID(), issueId = randomUUID(), workspaceId = randomUUID(), executorId = randomUUID(), reviewerId = randomUUID(), reviewerRun = randomUUID();
    const root = await mkdtemp(join(tmpdir(), "pc-engineering-source-")); roots.push(root);
    await writeFile(join(root, "implementation"), "42");
    await writeFile(join(root, "test.sh"), 'test "$(cat implementation)" = 42');
    await writeFile(join(root, "harness.sh"), 'if printf fake > implementation; then printf 42 > implementation; exit 42; fi; sh test.sh');
    await writeFile(join(root, "manifest.json"), '{"version":1}');
    const jobs = [{ id: "tests", name: "Tests", command: "sh test.sh" }, { id: "verify", name: "Verifier", command: "sh harness.sh" }];
    const engineeringEvidence = { version: 1 as const, sourceScope: { projectId, executionWorkspaceId: workspaceId, files: [
      { path: "implementation", role: "implementation" as const }, { path: "test.sh", role: "test" as const }, { path: "harness.sh", role: "harness" as const }, { path: "manifest.json", role: "manifest" as const },
    ] }, requiredJobs: [{ id: "tests", role: "test" as const }, { id: "verify", role: "verifier" as const }] };
    await db.insert(companies).values({ id: companyId, name: "Private engineering", issuePrefix: `E${companyId.slice(0,6)}` });
    await db.insert(agents).values([executorId, reviewerId].map(id => ({ id, companyId, name: id === executorId ? "Author" : "Reviewer", role: "engineer", status: "active", adapterType: "process" })));
    await db.insert(projects).values({ id: projectId, companyId, name: "Engineering", deliveryPolicy: { version: 1, mode: "verified_delivery", reviewerAgentIds: [reviewerId, executorId], criteria: [{ id: "engineering", requirement: "Implementation meets requirements and meaningful tests pass", scope: "issue" }], engineeringEvidence } });
    await db.insert(issues).values({ id: issueId, companyId, projectId, title: "Engineering", assigneeAgentId: executorId, status: "in_progress" });
    await db.insert(executionWorkspaces).values({ id: workspaceId, companyId, projectId, sourceIssueId: issueId, name: "Local source", mode: "isolated_workspace", strategyType: "directory", cwd: root, metadata: { config: { workspaceRuntime: { jobs } } } });
    await db.update(issues).set({ executionWorkspaceId: workspaceId }).where(eq(issues.id, issueId));
    await db.insert(heartbeatRuns).values({ id: reviewerRun, companyId, agentId: reviewerId, status: "running", contextSnapshot: { issueId } });
    const recorder = workspaceOperationService(db).createRecorder({ companyId, executionWorkspaceId: workspaceId, issueId });
    const run = (job = jobs[0]!, auth?: { actorType: string; actorId: string; agentId: string | null; runId: string | null; issueId: string }) => runWorkspaceJobForControl({ db, actor: { id: auth?.agentId ?? null, companyId, name: "Board" }, issue: { id: issueId, title: "Engineering", identifier: null }, workspace: { cwd: root, projectId, workspaceId: null } as any, command: job, recorder: auth ? workspaceOperationService(db).createRecorder({ companyId, executionWorkspaceId: workspaceId, issueId, heartbeatRunId: auth.runId }) : recorder,
      authorization: auth ?? { actorType: "board", actorId: "private-board", agentId: null, runId: null, issueId },
      metadata: { executionWorkspaceId: workspaceId, workspaceCommandId: job.id },
    } as any);
    const authority = deliveryAuthorityService(db);
    const bundle = async (body: unknown) => {
      const [doc] = await db.insert(documents).values({ companyId, title: "Engineering references", latestBody: JSON.stringify(body), createdByAgentId: executorId }).returning();
      await db.insert(issueDocuments).values({ companyId, issueId, documentId: doc!.id, key: "engineering" });
      const [product] = await db.insert(issueWorkProducts).values({ companyId, issueId, type: "document", provider: "paperclip", title: "Engineering bundle", status: "draft", isPrimary: true, producerAgentId: executorId, metadata: { documentId: doc!.id } }).returning();
      return product!;
    };
    const accept = async (criterionId?: string) => {
      const current = await authority.assessment(companyId, issueId), criterion = (criterionId ? current.criteria.find(item => item.id === criterionId) : current.criteria[0])!;
      return authority.recordDecision(companyId, issueId, { type: "agent", agentId: reviewerId, runId: reviewerRun }, {
        requestId: randomUUID(), criterionId: criterion.id, workProductId: criterion.workProductId!, expectedContractHash: current.contractHash!, expectedCriterionDigest: criterion.criterionDigest, expectedContentDigest: criterion.contentDigest!, expectedMaterialVersion: criterion.materialVersion!, verdict: "accepted", reason: "Independent reviewer inspected implementation and meaningful assertions against requirement 42.",
      });
    };
    return { companyId, projectId, issueId, workspaceId, executorId, reviewerId, reviewerRun, root, jobs, run, bundle, accept, authority, engineeringEvidence };
  }
  it("refuses a well-shaped self-reported successful manifest", async () => {
    const f = await fixture();
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [randomUUID(), randomUUID()], unresolvedLimits: "", exitCode: 0, passed: true });
    await expect(f.accept()).rejects.toThrow(/engineering/i);
  });
  it("real readonly approved host jobs plus independent review complete, source drift invalidates unchanged bundle", async () => {
    const f = await fixture();
    const first = await f.run(), second = await f.run(f.jobs[1]);
    expect(first?.exitCode).toBe(0); expect(second?.exitCode).toBe(0);
    expect(second?.stderrExcerpt).toMatch(/Read-only file system/);
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [first!.id, second!.id], unresolvedLimits: "Only the Board-selected source scope is covered." });
    expect((await f.authority.assessment(f.companyId, f.issueId)).canComplete).toBe(false);
    await f.accept();
    await expect(f.authority.assertCanComplete(f.companyId, f.issueId)).resolves.toBeUndefined();
    await writeFile(join(f.root, "implementation"), "43");
    expect((await f.authority.assessment(f.companyId, f.issueId)).canComplete).toBe(false);
    await expect(f.authority.assertCanComplete(f.companyId, f.issueId)).rejects.toThrow();
  });
  it("shares the same immutable bundle across multiple engineering criteria", async () => {
    const f = await fixture();
    await db.update(projects).set({ deliveryPolicy: { version: 1, mode: "verified_delivery", engineeringEvidence: f.engineeringEvidence, reviewerAgentIds: [f.reviewerId], criteria: [{ id: "implementation", requirement: "Implementation meets requirements" }, { id: "tests", requirement: "Tests have meaningful assertions" }] } }).where(eq(projects.id, f.projectId));
    const first = await f.run(), second = await f.run(f.jobs[1]);
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [first!.id, second!.id], unresolvedLimits: "" });
    expect((await f.authority.assessment(f.companyId, f.issueId)).criteria.every(item => item.engineeringEvidence?.verified)).toBe(true);
    await f.accept("implementation"); await f.accept("tests");
    await expect(f.authority.assertCanComplete(f.companyId, f.issueId)).resolves.toBeUndefined();
  });

  it("refuses empty or missing implementation and test inputs before dispatch", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "implementation"), "   ");
    await expect(f.run()).rejects.toThrow(/empty/);
    await writeFile(join(f.root, "implementation"), "42");
    await rm(join(f.root, "test.sh"));
    await expect(f.run()).rejects.toThrow();
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.issueId, f.issueId))).toHaveLength(0);
  });

  it("records real child failure and refuses outer success, missing and foreign operations", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "implementation"), "wrong");
    await expect(f.run()).rejects.toThrow(/failed/);
    const rows = await db.select().from(workspaceOperations).where(eq(workspaceOperations.issueId, f.issueId));
    expect(rows[0]?.exitCode).toBe(1);
    const recorder = workspaceOperationService(db).createRecorder({ companyId: f.companyId, issueId: f.issueId, executionWorkspaceId: f.workspaceId });
    const outer = await recorder.recordOperation({ phase: "workspace_provision", run: async () => ({ status: "succeeded", exitCode: 0, metadata: { nestedOperationId: rows[0]!.id } }) });
    const product = await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [outer.id, rows[0]!.id], unresolvedLimits: "" });
    await expect(f.accept()).rejects.toThrow(/Engineering/);
    for (const operationIds of [[rows[0]!.id, randomUUID()], [randomUUID(), randomUUID()]]) {
      await db.update(documents).set({ latestBody: JSON.stringify({ version: 1, executionWorkspaceId: f.workspaceId, operationIds, unresolvedLimits: "" }) }).where(eq(documents.id, String(product.metadata!.documentId)));
      await expect(f.accept()).rejects.toThrow(/Engineering/);
    }
  });

  it("invalidates unchanged accepted bundle on job rule, owner, receipt and log drift", async () => {
    const f = await fixture(); const first = await f.run(), second = await f.run(f.jobs[1]);
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [first!.id, second!.id], unresolvedLimits: "" });
    await f.accept();
    const stale = async () => expect((await f.authority.assessment(f.companyId, f.issueId)).canComplete).toBe(false);
    await db.update(executionWorkspaces).set({ metadata: { config: { workspaceRuntime: { jobs: [{ ...f.jobs[0], command: "true" }, f.jobs[1]] } } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    await stale(); await expect(f.accept()).rejects.toThrow(/definition/);
    await db.update(executionWorkspaces).set({ metadata: { config: { workspaceRuntime: { jobs: f.jobs } } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    const original = first!.metadata!;
    const receipt = original.engineeringReceipt as Record<string, unknown>;
    await db.update(workspaceOperations).set({ metadata: { ...original, engineeringReceipt: { ...receipt, ownerId: randomUUID() } } }).where(eq(workspaceOperations.id, first!.id));
    await stale(); await expect(f.accept()).rejects.toThrow(/drain/);
    await db.update(workspaceOperations).set({ metadata: original }).where(eq(workspaceOperations.id, first!.id));
    await getWorkspaceOperationLogStore().append({ store: "local_file", logRef: first!.logRef! }, { stream: "stdout", chunk: "tampered", ts: new Date().toISOString() });
    await stale(); await expect(f.accept()).rejects.toThrow(/log/);
  });

  it("keeps required inherited scope and roles despite a child reducing its own fields", async () => {
    const f = await fixture();
    const inherited = await f.authority.materializeContract(f.companyId, f.issueId);
    await db.update(issues).set({ executionPolicy: { deliveryPolicy: { version: 1, mode: "verified_delivery", criteria: [{ id: "weak", requirement: "true" }] } } }).where(eq(issues.id, f.issueId));
    const child = await f.authority.materializeContract(f.companyId, f.issueId);
    expect(child.definition.engineeringEvidence).toEqual(inherited.definition.engineeringEvidence);
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [randomUUID(), randomUUID()], unresolvedLimits: "" });
    await expect(f.accept()).rejects.toThrow(/Engineering/);
  });

  it("denies secret source paths and jobs on an active physical writer without replacing its identity", async () => {
    const f = await fixture(), ownership = workspaceWriteOwnershipService(db);
    const owner = await ownership.claim({ cwd: f.root, companyId: f.companyId, issueId: f.issueId, runId: randomUUID() });
    expect(owner.outcome).toBe("claimed");
    await expect(f.run()).rejects.toThrow(/undrained physical writer/);
    if (owner.outcome === "claimed") await ownership.releaseIfStopped(owner.owner);
    await writeFile(join(f.root, ".env"), "PRIVATE=fixture");
    await db.update(projects).set({ deliveryPolicy: { version: 1, mode: "verified_delivery", engineeringEvidence: { ...f.engineeringEvidence, sourceScope: { ...f.engineeringEvidence.sourceScope, files: f.engineeringEvidence.sourceScope.files.map(file => file.role === "implementation" ? { ...file, path: ".env" } : file) } } } }).where(eq(projects.id, f.projectId));
    await expect(f.run()).rejects.toThrow();
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.issueId, f.issueId))).toHaveLength(0);
  });

  it("binds current authenticated agent runs and excludes the actual job executor from semantic acceptance", async () => {
    const f = await fixture(), runId = randomUUID();
    const auth = { actorType: "agent", actorId: f.executorId, agentId: f.executorId, runId, issueId: f.issueId };
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.executorId, status: "succeeded", contextSnapshot: { issueId: f.issueId } });
    await expect(f.run(f.jobs[0], auth)).rejects.toThrow(/current authenticated/);
    await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, runId));
    const first = await f.run(f.jobs[0], auth), second = await f.run(f.jobs[1], auth);
    expect(first!.heartbeatRunId).toBe(runId);
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [first!.id, second!.id], unresolvedLimits: "" });
    const current = await f.authority.assessment(f.companyId, f.issueId), criterion = current.criteria[0]!;
    await expect(f.authority.recordDecision(f.companyId, f.issueId, { type: "agent", agentId: f.executorId, runId }, { requestId: randomUUID(), criterionId: criterion.id, workProductId: criterion.workProductId!, expectedContractHash: current.contractHash!, expectedCriterionDigest: criterion.criterionDigest, expectedMaterialVersion: criterion.materialVersion!, expectedContentDigest: criterion.contentDigest!, verdict: "accepted", reason: "I claim success" })).rejects.toThrow(/own deliverable/);
    await f.accept();
    expect((await f.authority.assessment(f.companyId, f.issueId)).canComplete).toBe(true);
  });

  it("rejects another company's real job, not-run receipts, missing logs and policy role drift", async () => {
    const f = await fixture(), foreign = await fixture();
    const first = await f.run(), second = await f.run(f.jobs[1]), other = await foreign.run();
    const product = await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [other!.id, second!.id], unresolvedLimits: "" });
    await expect(f.accept()).rejects.toThrow(/foreign/);
    await db.update(documents).set({ latestBody: JSON.stringify({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [first!.id, second!.id], unresolvedLimits: "" }) }).where(eq(documents.id, String(product.metadata!.documentId)));
    await db.update(workspaceOperations).set({ status: "running", finishedAt: null }).where(eq(workspaceOperations.id, first!.id));
    await expect(f.accept()).rejects.toThrow(/not-run/);
    await db.update(workspaceOperations).set({ status: "succeeded", finishedAt: new Date() }).where(eq(workspaceOperations.id, first!.id));
    await f.accept();
    await db.update(projects).set({ deliveryPolicy: { version: 1, mode: "verified_delivery", reviewerAgentIds: [f.reviewerId], engineeringEvidence: { ...f.engineeringEvidence, requiredJobs: [...f.engineeringEvidence.requiredJobs, { id: "build", role: "build" }] } } }).where(eq(projects.id, f.projectId));
    expect((await f.authority.assessment(f.companyId, f.issueId)).canComplete).toBe(false);
    await db.update(projects).set({ deliveryPolicy: { version: 1, mode: "verified_delivery", reviewerAgentIds: [f.reviewerId], engineeringEvidence: f.engineeringEvidence } }).where(eq(projects.id, f.projectId));
    const logRoot = process.env.WORKSPACE_OPERATION_LOG_BASE_PATH ?? join(resolvePaperclipInstanceRoot(), "data", "workspace-operation-logs");
    await rm(join(logRoot, first!.logRef!));
    await expect(f.accept()).rejects.toThrow(/log/);
  });

  it("does not treat real successful trivial commands as semantic approval and rejects an actual failed verifier", async () => {
    const f = await fixture();
    await writeFile(join(f.root, "harness.sh"), "exit 1");
    const first = await f.run();
    await expect(f.run(f.jobs[1])).rejects.toThrow(/failed/);
    const operations = await db.select().from(workspaceOperations).where(eq(workspaceOperations.issueId, f.issueId));
    const verifier = operations.find(operation => operation.id !== first!.id)!;
    expect(verifier.exitCode).toBe(1);
    const product = await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [first!.id, verifier.id], unresolvedLimits: "" });
    await expect(f.accept()).rejects.toThrow(/failed/);
    const jobs = f.jobs.map(job => ({ ...job, command: "true" }));
    await db.update(executionWorkspaces).set({ metadata: { config: { workspaceRuntime: { jobs } } } }).where(eq(executionWorkspaces.id, f.workspaceId));
    const trueTest = await f.run(jobs[0]), trueVerifier = await f.run(jobs[1]);
    await db.update(documents).set({ latestBody: JSON.stringify({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: [trueTest!.id, trueVerifier!.id], unresolvedLimits: "No semantic proof." }) }).where(eq(documents.id, String(product.metadata!.documentId)));
    const assessment = await f.authority.assessment(f.companyId, f.issueId);
    expect(assessment.criteria[0]!.engineeringEvidence?.verified).toBe(true);
    expect(assessment.canComplete).toBe(false);
    await expect(f.authority.assertCanComplete(f.companyId, f.issueId)).rejects.toThrow(/independent acceptance/);
  });

  it.each(["ordinary", "none", "different_engineering"])("HTTP jobs use current issue B when workspace creation issue is %s", async (origin) => {
    const f = await fixture(), originalIssueId = randomUUID(), runId = randomUUID();
    const policy = { version: 1, mode: "verified_delivery", engineeringEvidence: f.engineeringEvidence, reviewerAgentIds: [f.reviewerId], criteria: [{ id: "engineering", requirement: "Implementation and meaningful tests meet requirement 42" }] };
    await db.update(projects).set({ deliveryPolicy: null }).where(eq(projects.id, f.projectId));
    await db.update(issues).set({ executionPolicy: { deliveryPolicy: policy } }).where(eq(issues.id, f.issueId));
    await db.insert(issues).values({ id: originalIssueId, companyId: f.companyId, projectId: f.projectId, title: "Original issue A", status: "todo", executionPolicy: origin === "different_engineering" ? { deliveryPolicy: { ...policy, engineeringEvidence: { ...f.engineeringEvidence, requiredJobs: [{ id: "other-tests", role: "test" }, { id: "other-verifier", role: "verifier" }] } } } : null });
    await db.update(executionWorkspaces).set({ sourceIssueId: origin === "none" ? null : originalIssueId }).where(eq(executionWorkspaces.id, f.workspaceId));
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.executorId, status: "running", contextSnapshot: { issueId: f.issueId } });
    const app = (agentId: string, actorRunId: string) => {
      const server = express(); server.use(express.json());
      server.use((req, _res, next) => { (req as any).actor = { type: "agent", companyId: f.companyId, agentId, runId: actorRunId, source: "agent_jwt" }; next(); });
      server.use("/api", executionWorkspaceRoutes(db));
      server.use("/api", issueRoutes(db, {} as any, { taskWatchdogEnqueueWakeup: null, deliveryEnqueueWakeup: null } as any));
      server.use(errorHandler); return server;
    };
    const executor = app(f.executorId, runId), reviewer = app(f.reviewerId, f.reviewerRun);
    const operationIds: string[] = [];
    for (const job of f.jobs) {
      const response = await request(executor).post(`/api/execution-workspaces/${f.workspaceId}/runtime-commands/run`).send({ workspaceCommandId: job.id });
      const effects = response.status === 200 ? [] : await db.select({ command: workspaceOperations.command, exitCode: workspaceOperations.exitCode, status: workspaceOperations.status }).from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId));
      expect(response.status, JSON.stringify({ response: response.body, effects })).toBe(200);
      operationIds.push(response.body.operation.metadata.nestedOperationId);
    }
    const inner = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operationIds[1]!));
    expect(inner[0]!.stderrExcerpt).toMatch(/Read-only file system/);
    for (const operationId of operationIds) {
      const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, operationId));
      expect(operation).toMatchObject({ issueId: f.issueId, heartbeatRunId: runId, exitCode: 0 });
      expect(operation!.metadata!.engineeringReceipt).toMatchObject({ authorization: { actorType: "agent", issueId: f.issueId, agentId: f.executorId, runId }, kind: "host_readonly_job" });
    }
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds, unresolvedLimits: "Fixture-only requirement 42." });
    const assessed = await request(reviewer).get(`/api/issues/${f.issueId}/delivery-assessment`).expect(200);
    const criterion = assessed.body.criteria[0];
    await request(reviewer).post(`/api/issues/${f.issueId}/delivery-decisions`).send({ requestId: randomUUID(), criterionId: criterion.id, workProductId: criterion.workProductId, expectedContractHash: assessed.body.contractHash, expectedCriterionDigest: criterion.criterionDigest, expectedMaterialVersion: criterion.materialVersion, expectedContentDigest: criterion.contentDigest, verdict: "accepted", reason: "Independent reviewer inspected implementation 42, tests and actual read-only verifier." }).expect(201);
    const completed = await request(executor).patch(`/api/issues/${f.issueId}`).send({ status: "done" });
    expect(completed.status, JSON.stringify(completed.body)).toBe(200);
    expect(completed.body.status).toBe("done");
  });

  it("keeps ordinary source-less Board jobs and requires explicit issue selection for engineering", async () => {
    const f = await fixture();
    await db.update(executionWorkspaces).set({ sourceIssueId: null }).where(eq(executionWorkspaces.id, f.workspaceId));
    const server = express(); server.use(express.json());
    server.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "private-board", companyIds: [f.companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    server.use("/api", executionWorkspaceRoutes(db)); server.use(errorHandler);
    const url = `/api/execution-workspaces/${f.workspaceId}/runtime-commands/run`;
    const unbound = await request(server).post(url).send({ workspaceCommandId: "tests" });
    expect(unbound.status, JSON.stringify(unbound.body)).toBe(422);
    const ids: string[] = [];
    for (const job of f.jobs) {
      const response = await request(server).post(url).send({ workspaceCommandId: job.id, issueId: f.issueId });
      expect(response.status, JSON.stringify(response.body)).toBe(200);
      ids.push(response.body.operation.metadata.nestedOperationId);
    }
    const [verifier] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, ids[1]!));
    expect(verifier!.stderrExcerpt).toMatch(/Read-only file system/);
    expect(verifier).toMatchObject({ issueId: f.issueId, heartbeatRunId: null });
    expect(verifier!.metadata!.engineeringReceipt).toMatchObject({ authorization: { actorType: "board", issueId: f.issueId, runId: null } });
    await f.bundle({ version: 1, executionWorkspaceId: f.workspaceId, operationIds: ids, unresolvedLimits: "" });
    await f.accept(); await expect(f.authority.assertCanComplete(f.companyId, f.issueId)).resolves.toBeUndefined();
    await db.update(projects).set({ deliveryPolicy: null }).where(eq(projects.id, f.projectId));
    await db.update(issues).set({ executionPolicy: { deliveryPolicy: { version: 1, mode: "verified_delivery", engineeringEvidence: f.engineeringEvidence } } }).where(eq(issues.id, f.issueId));
    await request(server).post(url).send({ workspaceCommandId: "tests" }).expect(422);
    await db.update(issues).set({ executionPolicy: null }).where(eq(issues.id, f.issueId));
    const ordinary = await request(server).post(url).send({ workspaceCommandId: "tests" });
    expect(ordinary.status, JSON.stringify(ordinary.body)).toBe(200);
    const [operation] = await db.select().from(workspaceOperations).where(eq(workspaceOperations.id, ordinary.body.operation.metadata.nestedOperationId));
    expect(operation).toMatchObject({ issueId: null, heartbeatRunId: null });
    expect(operation!.metadata!.engineeringReceipt).toBeUndefined();
  });

  it("rejects cross-company or unrelated Board issue targets and agent issue substitution before job effects", async () => {
    const f = await fixture(), foreign = await fixture(), unrelatedId = randomUUID(), runId = randomUUID();
    await db.insert(issues).values({ id: unrelatedId, companyId: f.companyId, projectId: f.projectId, title: "Unrelated", status: "todo" });
    const server = (board: boolean) => { const app = express(); app.use(express.json()); app.use((req, _res, next) => { (req as any).actor = board ? { type: "board", userId: "private-board", companyIds: [f.companyId], source: "local_implicit", isInstanceAdmin: true } : { type: "agent", agentId: f.executorId, runId, companyId: f.companyId, source: "agent_jwt" }; next(); }); app.use("/api", executionWorkspaceRoutes(db)); app.use(errorHandler); return app; };
    for (const issueId of [foreign.issueId, unrelatedId]) {
      const response = await request(server(true)).post(`/api/execution-workspaces/${f.workspaceId}/runtime-commands/run`).send({ workspaceCommandId: "tests", issueId });
      expect(response.status, JSON.stringify(response.body)).toBe(422);
    }
    await db.insert(heartbeatRuns).values({ id: runId, companyId: f.companyId, agentId: f.executorId, status: "running", contextSnapshot: { issueId: f.issueId } });
    const substituted = await request(server(false)).post(`/api/execution-workspaces/${f.workspaceId}/runtime-commands/run`).send({ workspaceCommandId: "tests", issueId: unrelatedId });
    expect(substituted.status, JSON.stringify(substituted.body)).toBe(422);
    expect(await db.select().from(workspaceOperations).where(eq(workspaceOperations.executionWorkspaceId, f.workspaceId))).toHaveLength(0);
  });

});
