import { randomUUID } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { activityLog, agentWakeupRequests, agents, companies, costEvents, createDb, heartbeatRunEvents, heartbeatRuns, issueComments, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getIssueResourceBlock } from "./issue-resource-limits.js";
import { issueService } from "./issues.js";

const support = await getEmbeddedPostgresTestSupport();
(support.supported ? describe : describe.skip)("durable task resource admission", () => {
  let db!: ReturnType<typeof createDb>;
  let fixture: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { fixture = await startEmbeddedPostgresTestDatabase("paperclip-resources-"); db = createDb(fixture.connectionString); }, 20000);
  afterEach(async () => {
    await db.delete(activityLog); await db.delete(issueComments); await db.delete(costEvents); await db.delete(heartbeatRunEvents);
    await db.delete(issues); await db.delete(heartbeatRuns); await db.delete(agentWakeupRequests); await db.delete(agents); await db.delete(companies);
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

  it.each(["user", "agent", "system"])("counts manual-labelled %s wakes using trusted actor provenance", async (actorType) => {
    const s = await seed({ maxAutomaticRuns: 1 });
    const id = await run(s, s.childId, 10), wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.agentId,
      source: "on_demand", triggerDetail: "manual", status: "completed", runId: id,
      requestedByActorType: actorType, requestedByActorId: actorType === "user" ? "board" : s.agentId,
    });
    await db.update(heartbeatRuns).set({ invocationSource: "on_demand", triggerDetail: "manual", wakeupRequestId: wakeId }).where(eq(heartbeatRuns.id, id));
    const block = await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId });
    if (actorType === "user") expect(block).toBeNull();
    else expect(block).toMatchObject({ code: "issue_automatic_run_limit" });
  });

  it("counts an automatic retry of a manual user wake against the automatic limit", async () => {
    const s = await seed({ maxAutomaticRuns: 1 });
    const id = await run(s, s.childId, 10), wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.agentId,
      source: "on_demand", triggerDetail: "manual", status: "completed", runId: id,
      requestedByActorType: "user", requestedByActorId: "board",
    });
    await db.update(heartbeatRuns).set({ invocationSource: "on_demand", triggerDetail: "manual", wakeupRequestId: wakeId,
      contextSnapshot: { issueId: s.childId, retryOfRunId: randomUUID() } }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_automatic_run_limit" });
  });

  it("does not treat an unproven manual label as an operator exemption", async () => {
    const s = await seed({ maxAutomaticRuns: 1 });
    const id = await run(s, s.childId, 10);
    await db.update(heartbeatRuns).set({ invocationSource: "on_demand", triggerDetail: "manual" }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_automatic_run_limit" });
  });

  it("counts an inconsistent user receipt whose run lacks its manual trigger", async () => {
    const s = await seed({ maxAutomaticRuns: 1 });
    const id = await run(s, s.childId, 10), wakeId = randomUUID();
    await db.insert(agentWakeupRequests).values({ id: wakeId, companyId: s.companyId, agentId: s.agentId,
      source: "on_demand", triggerDetail: "manual", status: "completed", runId: id,
      requestedByActorType: "user", requestedByActorId: "board",
    });
    await db.update(heartbeatRuns).set({ invocationSource: "on_demand", triggerDetail: null, wakeupRequestId: wakeId }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_automatic_run_limit" });
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

  async function reportedLegacyRun(s: Awaited<ReturnType<typeof seed>>, command: string, adapterType = "codex_local") {
    const id = await run(s, s.childId, 10);
    await db.update(heartbeatRuns).set({ runtimeMode: "legacy", sessionIdAfter: "fixture-session",
      runnerProfileJson: { adapterDispatch: { adapterType } },
      usageJson: { totalTokens: 62077, usageSource: "per_run", persistedSessionId: "fixture-session" },
      resultJson: { mode: "persistent", status: "completed", stopReason: "completed" },
    }).where(eq(heartbeatRuns.id, id));
    await db.insert(heartbeatRunEvents).values({ companyId: s.companyId, agentId: s.agentId, runId: id,
      seq: 1, eventType: "adapter.invoke", stream: "system", payload: { command, adapterType } });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: s.childId, heartbeatRunId: id,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 1894, cachedInputTokens: 60032, outputTokens: 151, totalTokens: 62077, occurredAt: new Date() });
    return id;
  }

  it("holds historical ACP window totals despite a numeric settled ledger without rewriting history", async () => {
    const s = await seed({ maxTokensPerIssue: 1500000 });
    const id = await reportedLegacyRun(s, "/isolated/adapter/node_modules/.bin/codex-acp");
    const [beforeRun] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id));
    const [beforeCost] = await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId }))
      .toMatchObject({ code: "issue_token_usage_unknown", resourceIssueId: s.rootId });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, id))).toEqual([beforeRun]);
    expect(await db.select().from(costEvents).where(eq(costEvents.heartbeatRunId, id))).toEqual([beforeCost]);
  });

  it("preserves genuine CLI totals for the same adapter type", async () => {
    const s = await seed({ maxTokensPerIssue: 62078 });
    await reportedLegacyRun(s, "/isolated/bin/codex");
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
    await db.update(issues).set({ executionPolicy: { mode: "normal", stages: [], commentRequired: true,
      resourceLimits: { maxTokensPerIssue: 62077 } } }).where(eq(issues.id, s.rootId));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
  });

  it("allows historical ACP without an aggregate token policy while retaining other limits", async () => {
    const s = await seed({ maxAutomaticRuns: 2, maxRunSeconds: 600, maxTokensPerRun: 250000 });
    await reportedLegacyRun(s, "/isolated/bin/codex-acp");
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
    await db.update(issues).set({ executionPolicy: { mode: "normal", stages: [], commentRequired: true,
      resourceLimits: { maxAutomaticRuns: 1, maxRunSeconds: 600, maxTokensPerRun: 250000 } } }).where(eq(issues.id, s.rootId));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_automatic_run_limit" });
  });

  function completeAcpAccounting(id: string) {
    return { version: 1, source: "codex_session_cumulative_delta", completeness: "complete",
      runId: id, sessionId: "fixture-session", scopeHash: "a".repeat(64), bindingVerified: true,
      baselineVerified: true, boundary: "typed_prompt_reply" };
  }

  it("counts bound current ACP complete totals exactly once", async () => {
    const s = await seed({ maxTokensPerIssue: 62078 });
    const id = await reportedLegacyRun(s, "/isolated/bin/codex-acp");
    await db.update(heartbeatRuns).set({ usageJson: { totalTokens: 62077, usageUnknown: false, usageSource: "per_run",
      persistedSessionId: "fixture-session", usageAccounting: completeAcpAccounting(id) } }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
    await db.update(issues).set({ executionPolicy: { mode: "normal", stages: [], commentRequired: true,
      resourceLimits: { maxTokensPerIssue: 62077 } } }).where(eq(issues.id, s.rootId));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
  });

  it("accepts genuine Claude prompt-reset completeness without inventing a cumulative baseline", async () => {
    const s = await seed({ maxTokensPerIssue: 62078 });
    await db.update(agents).set({ adapterType: "claude_local" }).where(eq(agents.id, s.agentId));
    const id = await reportedLegacyRun(s, "/isolated/bin/claude-agent-acp", "claude_local");
    const accounting = { ...completeAcpAccounting(id), source: "claude_prompt_usage", baselineVerified: false,
      baselineSource: "producer_prompt_usage_reset" };
    await db.update(heartbeatRuns).set({ usageJson: { totalTokens: 62077, usageUnknown: false, usageSource: "per_run",
      usageAccounting: accounting } }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
    await db.update(heartbeatRuns).set({ usageJson: { totalTokens: 62077, usageUnknown: false, usageSource: "per_run",
      usageAccounting: { ...accounting, baselineSource: "unverified" } } }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown" });
  });

  it.each(["partial", "foreign run", "foreign session", "foreign scope", "foreign source", "missing binding", "missing baseline", "missing boundary"])
    ("keeps %s ACP accounting unknown despite numeric usage and ledger", async invalid => {
      const s = await seed({ maxTokensPerIssue: 1500000 });
      const id = await reportedLegacyRun(s, "/isolated/bin/codex-acp");
      const accounting: Record<string, unknown> = completeAcpAccounting(id);
      if (invalid === "partial") accounting.completeness = "partial";
      if (invalid === "foreign run") accounting.runId = randomUUID();
      if (invalid === "foreign session") accounting.sessionId = "foreign-session";
      if (invalid === "foreign scope") accounting.scopeHash = "b".repeat(64);
      if (invalid === "foreign source") accounting.source = "claude_prompt_usage";
      if (invalid === "missing binding") accounting.bindingVerified = false;
      if (invalid === "missing baseline") accounting.baselineVerified = false;
      if (invalid === "missing boundary") delete accounting.boundary;
      const expected = completeAcpAccounting(id);
      await db.update(heartbeatRuns).set({ runnerProfileJson: { legacyUsageScope: { version: 1,
        source: expected.source, sessionId: expected.sessionId, scopeHash: expected.scopeHash } },
        usageJson: { totalTokens: 62077, usageUnknown: false, usageSource: "per_run",
        persistedSessionId: "fixture-session", usageAccounting: accounting } }).where(eq(heartbeatRuns.id, id));
      expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId }))
        .toMatchObject({ code: "issue_token_usage_unknown" });
    });

  it.each(["company", "agent", "provider event"])("does not borrow %s ACP invocation authority", async foreign => {
    const s = await seed({ maxTokensPerIssue: 62078 });
    const id = await reportedLegacyRun(s, "/isolated/bin/codex");
    let companyId = s.companyId, agentId = s.agentId;
    if (foreign === "company") {
      companyId = randomUUID();
      await db.insert(companies).values({ id: companyId, name: "Foreign", issuePrefix: "FOR" });
    }
    if (foreign !== "provider event") {
      agentId = randomUUID();
      await db.insert(agents).values({ id: agentId, companyId, name: "Foreign", role: "engineer", adapterType: "codex_local" });
    }
    await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId: id, seq: 2, eventType: "adapter.invoke", stream: "system",
      ...(foreign === "provider event" ? { sourceEventId: "provider-event", sourceInstanceId: "provider" } : {}),
      payload: { command: "/isolated/bin/codex-acp", adapterType: "codex_local" } });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
  });

  it("counts trustworthy active usage above a partial ledger publication", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    const id = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: s.companyId, agentId: s.agentId,
      invocationSource: "automation", status: "running", startedAt: new Date(), contextSnapshot: { issueId: s.childId },
      usageJson: { totalTokens: 1000 }, resultJson: { nativeUsageCheckpoint: { version: 1, totalTokens: 1000, usageUnknown: false } },
    });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: s.childId, heartbeatRunId: id,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 100, outputTokens: 0, cachedInputTokens: 0, totalTokens: 100, occurredAt: new Date() });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
  });

  it("keeps an active canonical checkpoint's incomplete usage unknown", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    await db.insert(heartbeatRuns).values({ companyId: s.companyId, agentId: s.agentId,
      invocationSource: "automation", status: "running", startedAt: new Date(), contextSnapshot: { issueId: s.childId },
      usageJson: { totalTokens: null }, resultJson: { nativeUsageCheckpoint: { version: 1, totalTokens: null, usageUnknown: true } },
    });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown" });
  });

  function legacyCheckpoint(s: Awaited<ReturnType<typeof seed>>, id: string, boot: string) {
    const scope = { version: 1, source: "codex_session_cumulative_delta", sessionId: "fixture-session", scopeHash: "a".repeat(64) };
    return { runnerProfileJson: { legacyUsageScope: scope }, resultJson: { legacyUsageCheckpoint: {
      ...scope, companyId: s.companyId, agentId: s.agentId, runId: id, controllerBootId: boot, adapterType: "codex_local",
      bindingVerified: true, baselineVerified: true, observedTotalTokens: 1000, usageUnknown: true, observedAt: new Date().toISOString(),
    } } };
  }

  it("keeps active legacy reported usage unknown despite a partial known ledger row", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    const id = randomUUID(), boot = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: s.companyId, agentId: s.agentId,
      controllerBootId: boot, runtimeMode: "legacy", invocationSource: "automation", status: "running", startedAt: new Date(), contextSnapshot: { issueId: s.childId },
      usageJson: { observedTotalTokens: 1000, usageUnknown: true }, ...legacyCheckpoint(s, id, boot),
    });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: s.childId, heartbeatRunId: id,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 100, outputTokens: 0, totalTokens: 100, occurredAt: new Date() });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown", resourceIssueId: s.rootId });
  });

  it("retains legacy lower bounds while reconciling completed ledger attribution exactly once", async () => {
    const s = await seed({ maxTokensPerIssue: 1100 });
    const id = randomUUID(), boot = randomUUID();
    await db.insert(heartbeatRuns).values({ id, companyId: s.companyId, agentId: s.agentId,
      controllerBootId: boot, runtimeMode: "legacy", invocationSource: "automation", status: "succeeded", startedAt: new Date(Date.now() - 1000), finishedAt: new Date(), contextSnapshot: { issueId: s.childId },
      usageJson: { totalTokens: 1000, observedTotalTokens: 1000, usageUnknown: false }, ...legacyCheckpoint(s, id, boot),
    });
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: s.childId, heartbeatRunId: id,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 100, outputTokens: 0, totalTokens: 100, occurredAt: new Date() });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
    await db.update(issues).set({ executionPolicy: { mode: "normal", stages: [], commentRequired: true, resourceLimits: { maxTokensPerIssue: 1000 } } }).where(eq(issues.id, s.rootId));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
  });

  it("does not accept a foreign legacy pin or a partial numeric total as complete usage", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    const id = randomUUID(), boot = randomUUID();
    const binding = legacyCheckpoint(s, id, boot);
    binding.resultJson.legacyUsageCheckpoint.scopeHash = "b".repeat(64);
    await db.insert(heartbeatRuns).values({ id, companyId: s.companyId, agentId: s.agentId,
      controllerBootId: boot, runtimeMode: "legacy", invocationSource: "automation", status: "running", startedAt: new Date(), contextSnapshot: { issueId: s.childId },
      usageJson: { totalTokens: 0, usageUnknown: false }, ...binding,
    });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown" });
    await db.update(heartbeatRuns).set({ ...legacyCheckpoint(s, id, boot), usageJson: { totalTokens: 1000, usageUnknown: true } }).where(eq(heartbeatRuns.id, id));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_usage_unknown" });
  });

  it("does not count a scoped ledger twice for a completed ordinary run", async () => {
    const s = await seed({ maxTokensPerIssue: 1100 });
    const id = await run(s, s.childId, 10);
    await db.update(heartbeatRuns).set({ usageJson: { totalTokens: 1000 } }).where(eq(heartbeatRuns.id, id));
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: s.childId, heartbeatRunId: id,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 100, outputTokens: 0, totalTokens: 100, occurredAt: new Date() });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toBeNull();
    await db.update(issues).set({ executionPolicy: { mode: "normal", stages: [], commentRequired: true, resourceLimits: { maxTokensPerIssue: 1000 } } }).where(eq(issues.id, s.rootId));
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
  });

  it("reconciles known finished run usage even if its ledger publication lacks issue attribution", async () => {
    const s = await seed({ maxTokensPerIssue: 1000 });
    const id = await run(s, s.childId, 10);
    await db.update(heartbeatRuns).set({ usageJson: { totalTokens: 1000 } }).where(eq(heartbeatRuns.id, id));
    await db.insert(costEvents).values({ companyId: s.companyId, agentId: s.agentId, issueId: null, heartbeatRunId: id,
      provider: "openai", model: "fixture", billingType: "subscription", costCents: 0,
      inputTokens: 1000, outputTokens: 0, cachedInputTokens: 0, totalTokens: 1000, occurredAt: new Date() });
    expect(await getIssueResourceBlock(db, { companyId: s.companyId, issueId: s.childId })).toMatchObject({ code: "issue_token_limit" });
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
