import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agents, companies, costEvents, createDb, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getIssueResourceBlock } from "./issue-resource-limits.js";
import { issueService } from "./issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable task resource admission", () => {
  let db!: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("paperclip-resources-"); db = createDb(fixture.connectionString); }, 20000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueComments); await db.delete(costEvents);
    await db.delete(issues); await db.delete(heartbeatRuns); await db.delete(agents); await db.delete(companies);
  });
  afterAll(async () => { await fixture?.cleanup(); });
  async function seed(resourceLimits: Record<string, number>) {
    const companyId = randomUUID(), agentId = randomUUID(), rootId = randomUUID(), childId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Resource fixture", issuePrefix: "RES", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {} });
    await db.insert(issues).values([
      { id: rootId, companyId, title: "Root", status: "in_progress", assigneeAgentId: agentId, executionPolicy: { mode: "normal", commentRequired: true, stages: [], resourceLimits } },
      { id: childId, companyId, title: "Child", parentId: rootId, status: "in_progress", assigneeAgentId: agentId },
    ]);
    return { companyId, agentId, rootId, childId };
  }
  async function run(s: Awaited<ReturnType<typeof seed>>, issueId: string, secondsAgo: number) {
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: s.companyId, agentId: s.agentId,
      invocationSource: "automation", status: "succeeded", startedAt: new Date(Date.now() - (secondsAgo + 5) * 1000),
      finishedAt: new Date(Date.now() - secondsAgo * 1000), contextSnapshot: { issueId }, livenessState: "needs_followup" });
    return id;
  }
  it("retains the same ancestor attempt budget across tasks and database clients", async () => {
    const s = await seed({ maxAutomaticRuns: 2 });
    await run(s, s.rootId, 20); await run(s, s.childId, 10);
    const input = { companyId: s.companyId, issueId: s.childId };
    expect(await getIssueResourceBlock(db, input)).toMatchObject({ code: "issue_automatic_run_limit", resourceIssueId: s.rootId });
    expect(await getIssueResourceBlock(createDb(fixture.connectionString), input)).toMatchObject({ code: "issue_automatic_run_limit", resourceIssueId: s.rootId });
  });

  it("persists resource-only limits through ordinary issue creation and update", async () => {
    const s = await seed({ maxAutomaticRuns: 2 });
    const created = await issueService(db).create(s.companyId, { title: "Ordinary API policy", status: "backlog", createdByUserId: "board",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], resourceLimits: { maxAutomaticRuns: 1, maxRunSeconds: 120 } },
    });
    expect(created.executionPolicy?.resourceLimits).toEqual({ maxAutomaticRuns: 1, maxRunSeconds: 120 });
    const updated = await issueService(db).update(created.id, { companyGuard: s.companyId, actorUserId: "board",
      executionPolicy: { mode: "normal", commentRequired: true, stages: [], resourceLimits: { maxAutomaticRuns: 2 } },
    });
    expect(updated?.executionPolicy?.resourceLimits).toEqual({ maxAutomaticRuns: 2 });
  });
  it("counts known subscription tokens, and refuses to turn missing totals into zero", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: s.childId,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 800, outputTokens: 200, cachedInputTokens: 400, totalTokens: 1000, occurredAt: new Date() });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
    await db.update(costEvents).set({ totalTokens: null }).where(eq(costEvents.companyId, s.companyId));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown" });
  });
  it("keeps completed model runs with no usage report unknown", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    await run(s, s.childId, 10);
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown" });
  });
  it("accepts real new human input for no-progress recovery without resetting lifetime attempts", async () => {
    const s = await seed({ maxNoProgressRuns: 2 });
    await run(s, s.rootId, 20); await run(s, s.childId, 10);
    const input = { companyId: s.companyId, issueId: s.childId };
    expect(await getIssueResourceBlock(db, input)).toMatchObject({ code: "issue_no_progress_limit" });
    await db.insert(issueComments).values({ companyId: s.companyId, issueId: s.rootId, authorUserId: "board", body: "New requirement", createdAt: new Date() });
    expect(await getIssueResourceBlock(db, input)).toBeNull();
    await db.update(issues).set({ executionPolicy: { mode: "normal", commentRequired: true, stages: [], resourceLimits: { maxNoProgressRuns: 2, maxAutomaticRuns: 2 } } }).where(eq(issues.id, s.rootId));
    expect(await getIssueResourceBlock(db, input)).toMatchObject({ code: "issue_automatic_run_limit" });
  });
  it("prevents an executor from dropping resource limits through ordinary policy updates", async () => {
    const s = await seed({ maxAutomaticRuns: 2 });
    await expect(issueService(db).update(s.rootId, { executionPolicy: null, actorAgentId: s.agentId, companyGuard: s.companyId })).rejects.toMatchObject({ status: 403 });
    const [row] = await db.select().from(issues).where(and(eq(issues.id, s.rootId), eq(issues.companyId, s.companyId)));
    expect(row.executionPolicy?.resourceLimits).toEqual({ maxAutomaticRuns: 2 });
  });
  it("prevents an executor from escaping an ancestor budget by reparenting", async () => {
    const s = await seed({ maxAutomaticRuns: 2 });
    await expect(issueService(db).update(s.childId, { parentId: null, actorAgentId: s.agentId, companyGuard: s.companyId })).rejects.toMatchObject({ status: 403 });
    const [row] = await db.select().from(issues).where(eq(issues.id, s.childId));
    expect(row.parentId).toBe(s.rootId);
  });
});
