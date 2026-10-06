import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import express from "express";
import request from "supertest";
import { and, eq, inArray, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  agents,
  approvals,
  issueApprovals,
  issueThreadInteractions,
  issueRecoveryActions,
  agentRuntimeState,
  agentWakeupRequests,
  activityLog,
  budgetPolicies,
  companies,
  companySkills,
  createDb,
  environmentLeases,
  environments,
  instanceSettings,
  executionWorkspaces,
  heartbeatRunEvents,
  heartbeatRuns,
  issueRelations,
  issues,
  projects,
  workspaceWriteOwners,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { drainHeartbeatRunsToQuiescence } from "./helpers/drain-heartbeat-runs.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { createPostgresRunDispatchAdapter } from "../modules/run-dispatch/adapters/postgres.js";
import { issueRecoveryActionReadModelSchema } from "../../../packages/shared/src/validators/issue.js";

const profileDispatchHooks = vi.hoisted(() => ({ afterCheckpoint: null as null | (() => Promise<void>), afterAcquire: null as null | (() => Promise<void>), beforeAcquire: null as null | (() => Promise<void>) }));
vi.mock("../services/execution-checkpoint.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/execution-checkpoint.js")>();
  return { ...actual, buildExecutionCheckpoint: async (...args: Parameters<typeof actual.buildExecutionCheckpoint>) => {
    const result = await actual.buildExecutionCheckpoint(...args);
    const hook = profileDispatchHooks.afterCheckpoint;
    profileDispatchHooks.afterCheckpoint = null;
    await hook?.();
    return result;
  } };
});
vi.mock("../services/environment-run-orchestrator.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/environment-run-orchestrator.js")>();
  return { ...actual, environmentRunOrchestrator: (...args: Parameters<typeof actual.environmentRunOrchestrator>) => {
    const service = actual.environmentRunOrchestrator(...args);
    return { ...service, acquireForRun: async (...input: Parameters<typeof service.acquireForRun>) => {
      const before = profileDispatchHooks.beforeAcquire;
      profileDispatchHooks.beforeAcquire = null;
      await before?.();
      const result = await service.acquireForRun(...input);
      const hook = profileDispatchHooks.afterAcquire;
      profileDispatchHooks.afterAcquire = null;
      await hook?.();
      return result;
    } };
  } };
});

const mockTelemetryClient = vi.hoisted(() => ({ track: vi.fn() }));
const mockTrackAgentTaskRun = vi.hoisted(() => vi.fn());

vi.mock("../telemetry.js", () => ({
  getTelemetryClient: () => mockTelemetryClient,
}));

vi.mock("@paperclipai/shared/telemetry", async () => {
  const actual = await vi.importActual<typeof import("@paperclipai/shared/telemetry")>(
    "@paperclipai/shared/telemetry",
  );
  return {
    ...actual,
    trackAgentTaskRun: mockTrackAgentTaskRun,
  };
});

// Wraps the real implementation so most tests exercise genuine transactional
// writes; a test that needs to prove a rollback overrides one call with
// `mockRejectedValueOnce` and lets every other call fall through untouched.
vi.mock("../services/heartbeat-run-events.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../services/heartbeat-run-events.js")>();
  return { ...actual, appendHeartbeatRunEvent: vi.fn(actual.appendHeartbeatRunEvent) };
});

import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import { deriveQuotaProbeIdentity } from "../services/quota-probe-identity.js";
import { selectQuotaFallbackAgent } from "../services/agent-quota-fallback-policy.js";
import { subscribeCompanyLiveEvents } from "../services/live-events.js";
import {
  BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS,
  INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
  INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
  MAX_TURN_CONTINUATION_RETRY_REASON,
  MAX_TURN_CONTINUATION_WAKE_REASON,
  heartbeatService,
} from "../services/heartbeat.ts";

const mockedAppendHeartbeatRunEvent = vi.mocked(appendHeartbeatRunEvent);

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;
const PROVIDER_QUOTA_TEST_ADAPTER = "provider_quota_test";
const SUPPRESSED_RETRY_TEST_ADAPTER = "suppressed_retry_test";
let suppressedRetryPhysicalInvocations = 0;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres heartbeat retry scheduling tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

async function waitForRunToFinish(
  heartbeat: ReturnType<typeof heartbeatService>,
  runId: string,
  timeoutMs = 5_000,
) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const run = await heartbeat.getRun(runId);
    if (run && !["queued", "running"].includes(run.status)) return run;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return await heartbeat.getRun(runId);
}

describeEmbeddedPostgres("heartbeat bounded retry scheduling", () => {
  let db!: ReturnType<typeof createDb>;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-heartbeat-retry-scheduling-");
    db = createDb(tempDb.connectionString);
    heartbeat = heartbeatService(db);
    registerServerAdapter({ type: SUPPRESSED_RETRY_TEST_ADAPTER,
      execute: async () => { suppressedRetryPhysicalInvocations += 1; return { exitCode: 0, signal: null, timedOut: false, resultJson: { summary: "Fake local completion" } }; },
      testEnvironment: async () => ({ adapterType: SUPPRESSED_RETRY_TEST_ADAPTER, status: "pass", checks: [], testedAt: new Date().toISOString() }),
    });
    registerServerAdapter({
      type: PROVIDER_QUOTA_TEST_ADAPTER,
      execute: async () => ({
        exitCode: 1,
        signal: null,
        timedOut: false,
        errorMessage: "You've hit your session limit - resets at 4pm (America/Chicago).",
        errorCode: "provider_quota",
        errorFamily: "provider_quota",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        retryNotBefore: "2030-04-22T21:00:00.000Z",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
          errorFamily: "provider_quota",
          retryNotBefore: "2030-04-22T21:00:00.000Z",
          providerQuotaRetryNotBefore: "2030-04-22T21:00:00.000Z",
        },
      }),
      testEnvironment: async () => ({
        adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    // Await every in-flight background heartbeat run to quiescence before the
    // cleanup deletes. heartbeat.invoke claims a run and dispatches its
    // execution fire-and-forget, and that run can schedule a follow-up retry
    // wakeup, so a run or wakeup can still write heartbeat_runs and issues rows
    // when teardown starts. The cleanup deletes issues before heartbeat_runs, so
    // a late write races the deletes and can deadlock or break a foreign key.
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    await cleanupRetryFixture();
    await db.update(instanceSettings).set({ defaultEnvironmentId: null });
    await db.update(environments).set({ config: {} }).where(eq(environments.driver, "local"));
    vi.clearAllMocks();
    suppressedRetryPhysicalInvocations = 0;
    profileDispatchHooks.afterCheckpoint = null;
    profileDispatchHooks.afterAcquire = null;
    profileDispatchHooks.beforeAcquire = null;
  });

  afterAll(async () => {
    unregisterServerAdapter(PROVIDER_QUOTA_TEST_ADAPTER);
    unregisterServerAdapter(SUPPRESSED_RETRY_TEST_ADAPTER);
    await tempDb?.cleanup();
  });

  async function cleanupRetryFixture() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        await cleanupRetryFixtureOnce();
        return;
      } catch (error) {
        if (attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    }
  }

  async function cleanupHeartbeatRunDependents() {
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
    await new Promise((resolve) => setTimeout(resolve, 25));
    await db.delete(heartbeatRunEvents);
    await db.delete(activityLog);
  }

  async function cleanupRetryFixtureOnce() {
    await db.delete(activityLog);
    await db.delete(environmentLeases);
    await db.delete(issueRelations);
    await db.delete(issues);
    await db.delete(approvals);
    await db.delete(executionWorkspaces);
    await db.delete(projects);
    await cleanupHeartbeatRunDependents();
    await db.delete(heartbeatRuns);
    await db.delete(agentWakeupRequests);
    await db.delete(agentRuntimeState);
    await db.delete(budgetPolicies);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(companies);
  }

  async function seedRetryFixture(input: {
    runId: string;
    companyId: string;
    agentId: string;
    now: Date;
    errorCode: string;
    errorFamily?: "transient_upstream" | "provider_quota" | null;
    retryNotBefore?: string | null;
    scheduledRetryAttempt?: number;
    resultJson?: Record<string, unknown> | null;
    adapterType?: string;
    agentName?: string;
  }) {
    const adapterType = input.adapterType ?? "codex_local";
    const agentName = input.agentName ?? (adapterType === "claude_local" ? "ClaudeCoder" : "CodexCoder");
    await db.insert(companies).values({
      id: input.companyId,
      name: "Paperclip",
      issuePrefix: `T${input.companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: input.agentId,
      companyId: input.companyId,
      name: agentName,
      role: "engineer",
      status: "active",
      adapterType,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });
    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId: input.companyId, title: "Retry fixture", status: "in_progress", assigneeAgentId: input.agentId });
    await db.insert(heartbeatRuns).values({
      id: input.runId,
      companyId: input.companyId,
      agentId: input.agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: input.errorCode,
      finishedAt: input.now,
      scheduledRetryAttempt: input.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input.scheduledRetryAttempt ? "transient_failure" : null,
      resultJson: input.resultJson ?? { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        ...(input.errorFamily ? { errorFamily: input.errorFamily } : {}),
        ...(input.retryNotBefore
          ? {
              retryNotBefore: input.retryNotBefore,
              transientRetryNotBefore: input.retryNotBefore,
            }
          : {}),
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: input.now,
      createdAt: input.now,
    });
  }

  it("reuses one failure successor across concurrent and repeated scheduling", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "adapter_failed" });
    const outcomes = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 }),
      heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 }),
    ]);
    expect(outcomes.every((outcome) => outcome.outcome === "scheduled")).toBe(true);
    const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId));
    expect(children).toHaveLength(1);
    await db.update(heartbeatRuns).set({ status: "failed" }).where(eq(heartbeatRuns.id, children[0]!.id));
    await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0, retryReason: "execution_review_participant_recovery" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
  });

  it.each([
    ["workspace_busy", "failureRetriesBeforeWorkspaceWait"],
    ["ai_connection_busy", "failureRetriesBeforeAiConnectionWait"],
  ])("retains the failure budget after many pre-provider %s waits", async (reason, countKey) => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "overloaded", errorFamily: "transient_upstream" });
    await db.update(heartbeatRuns).set({ scheduledRetryReason: reason, scheduledRetryAttempt: 12,
      contextSnapshot: { [countKey]: 1 } }).where(eq(heartbeatRuns.id, runId));
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled).toMatchObject({ outcome: "scheduled", run: { scheduledRetryAttempt: 2, scheduledRetryReason: "transient_failure" } });
    if (scheduled.outcome !== "scheduled") throw new Error("Expected a bounded retry");
    await db.update(heartbeatRuns).set({ status: "failed", errorCode: "overloaded",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } } }).where(eq(heartbeatRuns.id, scheduled.run!.id));
    expect(await heartbeat.scheduleBoundedRetry(scheduled.run!.id, { now, random: () => 0 })).toMatchObject({ outcome: "retry_exhausted" });
  });
  it("records pre-provider quota rejection, schedules the reset-time retry, and leaves the agent idle", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Quota Test",
      role: "engineer",
      status: "idle",
      adapterType: PROVIDER_QUOTA_TEST_ADAPTER,
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const [task] = await db.insert(issues).values({ companyId, title: "Observe provider quota", status: "in_progress", assigneeAgentId: agentId,
      assigneeAdapterOverrides: { useProjectWorkspace: false } }).returning();
    const run = await heartbeat.invoke(agentId, "on_demand", { issueId: task.id }, "manual");
    expect(run).not.toBeNull();

    const failedRun = await waitForRunToFinish(heartbeat, run!.id);
    expect(failedRun?.status).toBe("failed");
    expect(failedRun?.errorCode).toBe("provider_quota");
    expect((failedRun?.resultJson as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");

    await expect
      .poll(
        () =>
          db
            .select({ id: heartbeatRuns.id })
            .from(heartbeatRuns)
            .where(eq(heartbeatRuns.retryOfRunId, run!.id))
            .then((rows) => rows.length),
        { timeout: 5_000, interval: 50 },
      )
      .toBe(1);

    const retryRun = await db
      .select({
        id: heartbeatRuns.id,
        status: heartbeatRuns.status,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.retryOfRunId, run!.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.status).toBe("scheduled_retry");
    expect(retryRun?.scheduledRetryReason).toBe("transient_failure");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe("2030-04-22T21:00:00.000Z");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.errorFamily).toBe("provider_quota");
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.providerQuotaRetryNotBefore).toBe(
      "2030-04-22T21:00:00.000Z",
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    await expect
      .poll(
        () =>
          db
            .select({ status: agents.status, errorReason: agents.errorReason })
            .from(agents)
            .where(eq(agents.id, agentId))
            .then((rows) => rows[0] ?? null),
        { timeout: 5_000, interval: 50 },
      )
      .toEqual({ status: "idle", errorReason: null });
  });

  it("waits an hour before retrying provider quota without a reset time", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "provider_quota",
      errorFamily: "provider_quota",
      adapterType: "claude_local",
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.toISOString()).toBe("2026-04-20T13:00:00.000Z");
    expect(scheduled.run.scheduledRetryReason).toBe("transient_failure");
    expect(scheduled.run.contextSnapshot).toMatchObject({ errorFamily: "provider_quota" });
  });

  it("switches a configured quota backup immediately rather than waiting for the primary reset", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");
    await seedRetryFixture({ runId, companyId, agentId, now, adapterType: "claude_local", errorCode: "provider_quota", errorFamily: "provider_quota", retryNotBefore: "2026-04-20T18:00:00.000Z" });
    await db.update(agents).set({ adapterConfig: { model: "MiniMax-M3.1-Flash-Preview" }, runtimeConfig: {
      heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, concurrencyGroup: "minimax" },
      quotaFallback: { enabled: true, backup: { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" }, primaryCheckIntervalSec: 300, recoveryEnabled: true },
    } }).where(eq(agents.id, agentId));
    const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBeLessThanOrEqual(now.getTime() + 1000);
    expect(scheduled.run.contextSnapshot).toMatchObject({ forceFreshSession: true, quotaFallbackHandoff: { sourceRunId: runId, adapterType: "codex_local", model: "gpt-6.1-sol" } });
    const [updated] = await db.select().from(agents).where(eq(agents.id, agentId));
    expect(updated?.adapterType).toBe("claude_local");
    expect(updated?.adapterConfig).toMatchObject({ model: "MiniMax-M3.1-Flash-Preview" });
    expect(JSON.stringify(updated?.metadata)).toContain("quotaFallbackState");
  });

  it("executes the admitted backup with its own model and retains immutable run identity", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date();
    await seedRetryFixture({ runId, companyId, agentId, now, adapterType: "claude_local", errorCode: "provider_quota", errorFamily: "provider_quota" });
    await db.update(agents).set({ adapterConfig: { model: "MiniMax-M3.1-Flash-Preview", env: { ANTHROPIC_BASE_URL: "https://primary.invalid" } }, runtimeConfig: {
      heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 },
      quotaFallback: { enabled: true, backup: { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" }, primaryCheckIntervalSec: 300, recoveryEnabled: true },
    } }).where(eq(agents.id, agentId));
    const execute = vi.fn(async (_context: unknown) => ({ exitCode: 0, signal: null, timedOut: false, summary: "continued" }));
    registerServerAdapter({ type: "codex_local", execute, testEnvironment: async () => ({ adapterType: "codex_local", status: "pass", checks: [], testedAt: now.toISOString() }) });
    registerServerAdapter({ type: "claude_local", execute: async () => { throw new Error("fixture unexpectedly selected primary instead of its bound backup"); }, testEnvironment: async () => ({ adapterType: "claude_local", status: "fail", checks: [{ code: "claude_hello_usage_limited", level: "error", message: "Fixture primary quota remains exhausted" }], testedAt: now.toISOString() }) });
    try {
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;
      await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      await heartbeat.resumeQueuedRuns();
      const finished = await waitForRunToFinish(heartbeat, scheduled.run.id);
      expect(finished?.status).toBe("succeeded");
      expect(execute).toHaveBeenCalledOnce();
      const invocation = execute.mock.calls[0]?.[0] as unknown as { config: Record<string, unknown>; agent: { id: string; adapterType: string } };
      expect(invocation.agent).toMatchObject({ id: agentId, adapterType: "codex_local" });
      expect(invocation.config).toMatchObject({ model: "gpt-6.1-sol", thinkingEffort: "high", dangerouslyBypassSandbox: false });
      expect((invocation.config.env as Record<string, unknown>).ANTHROPIC_BASE_URL).toBeUndefined();
      expect(finished?.runnerProfileJson).toMatchObject({ adapterDispatch: { adapterType: "codex_local" }, quotaFallback: { usingBackup: true, model: "gpt-6.1-sol" } });
    } finally { unregisterServerAdapter("codex_local"); unregisterServerAdapter("claude_local"); }
  });

  it("clears deferred backup session and quota waits when primary availability returns", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID(); const now = new Date();
    await seedRetryFixture({ runId, companyId, agentId, now, adapterType: "claude_local", errorCode: "provider_quota", errorFamily: "provider_quota" });
    await db.update(agents).set({ adapterConfig: { model: "MiniMax-M3.1-Flash-Preview", engine: "cli" }, runtimeConfig: {
      heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 }, quotaFallback: { enabled: true, backup: { adapterType: "codex_local", model: "gpt-6.1-sol" }, recoveryEnabled: true, primaryCheckIntervalSec: 300 },
    } }).where(eq(agents.id, agentId));
    const first = await heartbeat.scheduleBoundedRetry(runId, { now });
    if (first.outcome !== "scheduled") throw new Error("Expected initial backup continuation");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const identity = await deriveQuotaProbeIdentity(db, agent!, "responsible-user", first.run.id);
    const backupPin = selectQuotaFallbackAgent(agent!, "responsible-user", undefined, identity.effectiveFingerprint).pin;
    await db.update(heartbeatRuns).set({ status: "failed", finishedAt: now, errorCode: "provider_quota", resultJson: { errorFamily: "provider_quota", executionRecovery: { kind: "bootstrap", providerWorkStarted: false } }, runnerProfileJson: { quotaFallback: backupPin } }).where(eq(heartbeatRuns.id, first.run.id));
    const second = await heartbeat.scheduleBoundedRetry(first.run.id, { now });
    if (second.outcome !== "scheduled") throw new Error("Expected delayed backup retry");
    await db.update(heartbeatRuns).set({ contextSnapshot: { ...second.run.contextSnapshot, forceFreshSession: false, resumeSessionParams: { sessionId: "backup-old-session" }, resumeSessionDisplayId: "backup-old-session", providerQuotaRetryNotBefore: new Date(now.getTime() + 3_600_000).toISOString() } }).where(eq(heartbeatRuns.id, second.run.id));
    registerServerAdapter({ type: "claude_local", execute: async () => ({ exitCode: 0, signal: null, timedOut: false }), testEnvironment: async () => ({ adapterType: "claude_local", status: "pass", testedAt: now.toISOString(), checks: [{ code: "claude_hello_probe_passed", level: "info", message: "hello" }] }) });
    try {
      expect(await heartbeat.checkQuotaFallbackPrimary(agentId, "responsible-user")).toMatchObject({ usingBackup: false, lastPrimaryCheckResult: "available" });
      const resumed = await heartbeat.getRun(second.run.id);
      expect(resumed?.scheduledRetryAt!.getTime()).toBeLessThanOrEqual(Date.now());
      expect(resumed?.contextSnapshot?.forceFreshSession).toBe(true);
      expect(resumed?.contextSnapshot?.resumeSessionParams).toBeUndefined();
      expect(resumed?.contextSnapshot?.providerQuotaRetryNotBefore).toBeUndefined();
    } finally { unregisterServerAdapter("claude_local"); }
  });

  async function seedMaxTurnFixture(input?: {
    companyId?: string;
    agentId?: string;
    issueId?: string;
    runId?: string;
    now?: Date;
    scheduledRetryAttempt?: number;
    runtimeConfig?: Record<string, unknown>;
    issueStatus?: string;
  }) {
    const companyId = input?.companyId ?? randomUUID();
    const agentId = input?.agentId ?? randomUUID();
    const issueId = input?.issueId ?? randomUUID();
    const runId = input?.runId ?? randomUUID();
    const now = input?.now ?? new Date("2026-04-20T12:00:00.000Z");
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "ClaudeCoder",
      role: "engineer",
      status: "active",
      adapterType: "claude_local",
      adapterConfig: {},
      runtimeConfig: input?.runtimeConfig ?? {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 2,
            delayMs: 1_000,
          },
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "Maximum turns reached",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      scheduledRetryAttempt: input?.scheduledRetryAttempt ?? 0,
      scheduledRetryReason: input?.scheduledRetryAttempt ? MAX_TURN_CONTINUATION_RETRY_REASON : null,
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
        stopReason: "max_turns_exhausted",
      },
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Continue after max turns",
      status: input?.issueStatus ?? "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: agentId,
      executionRunId: runId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `${issuePrefix}-1`,
    });

    return { companyId, agentId, issueId, runId, now };
  }

  it("bounds interrupted conversations across restarts and concurrent scheduling", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
    const resultJson = { conversationContinuation: "continue_conversation_v1" };
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "server_shutdown_interrupted", resultJson })
      .where(eq(heartbeatRuns.id, runId));
    let predecessor = runId;
    for (const attempt of [1, 2]) {
      const restarted = heartbeatService(db);
      const outcomes = await Promise.all([
        restarted.scheduleBoundedRetry(predecessor, { now, random: () => 0 }),
        restarted.scheduleBoundedRetry(predecessor, { now, random: () => 0 }),
      ]);
      expect(outcomes.every(outcome => outcome.outcome === "scheduled")).toBe(true);
      const children = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, predecessor));
      expect(children).toHaveLength(1);
      expect(children[0]).toMatchObject({ scheduledRetryAttempt: attempt });
      predecessor = children[0]!.id;
      await db.update(heartbeatRuns).set({ status: "interrupted", finishedAt: now, resultJson })
        .where(eq(heartbeatRuns.id, predecessor));
    }
    expect(await heartbeatService(db).scheduleBoundedRetry(predecessor, { now }))
      .toMatchObject({ outcome: "retry_exhausted" });
    await heartbeatService(db).reconcileStrandedAssignedIssues();
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(3);
    // Exhaustion leaves the task available to a new explicit request.
    const { getExecutionBlocker } = await import("../services/execution-blocker.js");
    expect(await getExecutionBlocker(db, companyId, issueId)).toBeNull();
  });

  it.each(["dependency", "disabled", "reassigned"])("respects the %s gate for interrupted conversations", async gate => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "process_lost",
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    if (gate === "dependency") {
      const blockerId = randomUUID();
      await db.insert(issues).values({ id: blockerId, companyId, title: "Required work", status: "todo" });
      await db.insert(issueRelations).values({ companyId, issueId: blockerId, relatedIssueId: issueId, type: "blocks" });
    } else if (gate === "disabled") {
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    } else {
      await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    }
    expect(await heartbeat.scheduleBoundedRetry(runId, { now })).toMatchObject({ outcome: "not_scheduled" });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
  });

  it("persists disabled retry suppression across concurrent sweeps, restart and re-enabled wakes", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();
    const resultJson = { conversationContinuation: "continue_conversation_v1", artifacts: ["kept"], summary: "Unverified tests passed" };
    await db.update(agents).set({ adapterType: SUPPRESSED_RETRY_TEST_ADAPTER }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ status: "timed_out", error: "Original timeout", resultJson }).where(eq(heartbeatRuns.id, runId));
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } }).where(eq(agents.id, agentId));
    await Promise.all(Array.from({ length: 3 }, () => heartbeat.scheduleBoundedRetry(runId, { now })));
    for (let cycle = 0; cycle < 3; cycle += 1) await heartbeat.reconcileStrandedAssignedIssues();
    const beforeRestart = await heartbeat.getRun(runId);
    expect(beforeRestart?.resultJson?.retryDisposition).toMatchObject({ version: 1, state: "blocked", sourceRunId: runId, requiresExplicitResume: true });
    expect(beforeRestart).toMatchObject({ status: "timed_out", error: "Original timeout", scheduledRetryAttempt: 0 });
    expect(beforeRestart?.resultJson?.artifacts).toEqual(["kept"]);
    const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId));
    expect(events.filter(event => event.payload?.retrySuppression)).toHaveLength(1);
    const actions = await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    expect(actions).toHaveLength(1);
    expect(issueRecoveryActionReadModelSchema.safeParse(actions[0]).success).toBe(true);
    expect(actions[0]).toMatchObject({ ownerType: "board", cause: "retry_suppressed", status: "active" });
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));
    const restarted = heartbeatService(db);
    for (let cycle = 0; cycle < 3; cycle += 1) {
      expect(await restarted.scheduleBoundedRetry(runId, { now })).toMatchObject({ outcome: "not_scheduled", errorCode: "heartbeat_wake_on_demand_disabled" });
      await restarted.reconcileStrandedAssignedIssues();
    }
    expect((await restarted.getRun(runId))?.updatedAt).toEqual(beforeRestart?.updatedAt);
    expect(await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId))).toHaveLength(events.length);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(await db.select().from(agentWakeupRequests).where(eq(agentWakeupRequests.companyId, companyId))).toHaveLength(0);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it("rolls suppression back completely when its event cannot persist", async () => {
    const { issueId, runId } = await seedMaxTurnFixture({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } });
    mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("event storage unavailable"));
    await expect(heartbeat.scheduleBoundedRetry(runId, { retryReason: MAX_TURN_CONTINUATION_RETRY_REASON })).rejects.toThrow("event storage unavailable");
    expect((await heartbeat.getRun(runId))?.resultJson?.retryDisposition).toBeUndefined();
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_progress");
    expect(await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId))).toHaveLength(0);
  });

  it("preserves another active recovery incident while recording source suppression", async () => {
    const { companyId, agentId, issueId, runId } = await seedMaxTurnFixture({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } });
    await captureFixtureProfile({ companyId, agentId, issueId, runId });
    const [existing] = await db.insert(issueRecoveryActions).values({ companyId, sourceIssueId: issueId, kind: "stranded_assigned_issue",
      ownerType: "board", cause: "legacy_execution_requires_reconciliation", fingerprint: "other-source", evidence: { retained: true }, nextAction: "Inspect other incident" }).returning();
    await heartbeat.scheduleBoundedRetry(runId, { retryReason: MAX_TURN_CONTINUATION_RETRY_REASON });
    expect((await heartbeat.getRun(runId))?.resultJson?.retryDisposition).toMatchObject({ recoveryActionId: null });
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0]).toEqual(existing);
    expect((await db.select().from(issues).where(eq(issues.id, issueId)))[0].status).toBe("in_progress");
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, agentId));
    await expect(heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId,
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board" })).rejects.toThrow("Another recovery incident");
  });

  async function captureFixtureProfile(fixture: { companyId: string; agentId: string; issueId: string; runId: string }) {
    const { environmentService } = await import("../services/environments.js");
    await environmentService(db).ensureLocalEnvironment(fixture.companyId);
    const { readExecutionProfileBinding } = await import("../services/execution-profile-binding.js");
    const [profileAgent] = await db.select().from(agents).where(eq(agents.id, fixture.agentId));
    const [profileIssue] = await db.select().from(issues).where(eq(issues.id, fixture.issueId));
    const executionProfileBinding = await readExecutionProfileBinding(db, profileIssue, profileAgent);
    await db.update(heartbeatRuns).set({ runnerProfileJson: { executionProfileBinding } }).where(eq(heartbeatRuns.id, fixture.runId));
  }

  async function seedSuppressedRetry(input?: { deadlineAt?: string; attempt?: number; status?: string; sourceEnvironmentId?: string; unstamped?: boolean; project?: boolean }) {
    const fixture = await seedMaxTurnFixture({ runtimeConfig: { heartbeat: { wakeOnDemand: false } } });
    await db.update(agents).set({ adapterType: SUPPRESSED_RETRY_TEST_ADAPTER }).where(eq(agents.id, fixture.agentId));
    await db.update(heartbeatRuns).set({ status: input?.status ?? "timed_out", error: "Original timeout",
      ...(input?.deadlineAt ? { contextSnapshot: { issueId: fixture.issueId, resourceDeadline: { runId: fixture.runId, deadlineAt: input.deadlineAt, maxRunSeconds: 600 } } } : {}),
      ...(input?.attempt ? { scheduledRetryAttempt: input.attempt } : {}), resultJson: {
      conversationContinuation: "continue_conversation_v1", artifacts: ["kept"],
      apiToolReceipts: { saved: { state: "completed", operationId: "save_document", result: { documentId: "kept" } } },
    } }).where(eq(heartbeatRuns.id, fixture.runId));
    await db.update(issues).set({ assigneeAdapterOverrides: { useProjectWorkspace: false } }).where(eq(issues.id, fixture.issueId));
    const { environmentService } = await import("../services/environments.js");
    await environmentService(db).ensureLocalEnvironment(fixture.companyId);
    if (input?.sourceEnvironmentId) await db.update(agents).set({ defaultEnvironmentId: input.sourceEnvironmentId }).where(eq(agents.id, fixture.agentId));
    if (input?.project) {
      const [project] = await db.insert(projects).values({ companyId: fixture.companyId, name: "Profile target project", status: "in_progress" }).returning();
      await db.update(issues).set({ projectId: project.id }).where(eq(issues.id, fixture.issueId));
    }
    if (!input?.unstamped) await captureFixtureProfile(fixture);
    await heartbeat.scheduleBoundedRetry(fixture.runId);
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true } } }).where(eq(agents.id, fixture.agentId));
    return fixture;
  }

  async function boardWakeApp(companyId: string) {
    const { agentRoutes } = await import("../routes/agents.js");
    const { errorHandler } = await import("../middleware/index.js");
    const app = express();
    app.use(express.json());
    app.use((req, _res, next) => { (req as any).actor = { type: "board", userId: "local-board", companyIds: [companyId], source: "local_implicit", isInstanceAdmin: true }; next(); });
    app.use("/api", agentRoutes(db));
    app.use(errorHandler);
    return app;
  }

  it.each(["checkpoint", "acquired_environment"])("rejects post-admission profile drift after %s before invoking the adapter", async phase => {
    const { companyId, agentId, runId } = await seedSuppressedRetry();
    let changed = false;
    const drift = async () => {
      changed = true;
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true }, safetyPreset: "testing" } }).where(eq(agents.id, agentId));
    };
    if (phase === "checkpoint") profileDispatchHooks.afterCheckpoint = drift;
    else profileDispatchHooks.afterAcquire = drift;
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(202);
    const successor = await waitForRunToFinish(heartbeat, response.body.id);
    expect(changed).toBe(true);
    expect(successor?.error).toContain("continuation_execution_profile_changed");
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it("rejects target drift inside environment acquisition before creating a lease", async () => {
    const { companyId, agentId, runId } = await seedSuppressedRetry();
    profileDispatchHooks.beforeAcquire = async () => {
      await db.update(environments).set({ config: { profile: "changed-before-acquire" } }).where(eq(environments.driver, "local"));
    };
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(202);
    const successor = await waitForRunToFinish(heartbeat, response.body.id);
    expect(successor?.error).toContain("continuation_execution_profile_changed");
    expect(await db.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, response.body.id))).toHaveLength(0);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each([false, true])("keeps failed pre-dispatch successors bound through generic retry and permits one explicit fresh decision (legacy admission: %s)", async legacyAdmission => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry({ attempt: 1, deadlineAt: "2030-01-01T00:00:00.000Z" });
    profileDispatchHooks.afterCheckpoint = async () => {
      if (legacyAdmission) {
        // An audited decision admitted before v1 profile references existed.
        await db.update(activityLog).set({ details: sql`jsonb_set(${activityLog.details}, '{retryDisposition}', (${activityLog.details}->'retryDisposition') - 'executionProfileFingerprint')` })
          .where(and(eq(activityLog.entityId, runId), inArray(activityLog.action, ["issue.retry_suppressed", "issue.retry_resumed"])));
        await db.update(heartbeatRuns).set({ runnerProfileJson: sql`${heartbeatRuns.runnerProfileJson} - 'retryExecutionProfileAuthorization'` })
          .where(eq(heartbeatRuns.retryOfRunId, runId));
      }
      await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true }, safetyPreset: "testing" } }).where(eq(agents.id, agentId));
    };
    const app = await boardWakeApp(companyId);
    const base = { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run" };
    const first = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ ...base, failedRunId: runId });
    expect(first.status).toBe(202);
    await waitForRunToFinish(heartbeat, first.body.id);
    await drainHeartbeatRunsToQuiescence(db, heartbeat);
    const failed = (await heartbeat.getRun(first.body.id))!;
    expect(failed.error).toContain("continuation_execution_profile_changed");
    expect(suppressedRetryPhysicalInvocations).toBe(0);
    const repeated = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ ...base, failedRunId: failed.id });
    expect(repeated.status).toBe(409);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failed.id))).toHaveLength(0);
    expect((await heartbeat.getRun(failed.id))?.retryDisposition).toMatchObject({ state: "blocked", code: "execution_profile_changed" });
    if (legacyAdmission) expect((await heartbeat.getRun(failed.id))?.retryDisposition?.executionProfileFingerprint).toBeNull();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const body = { ...base, failedRunId: failed.id, retrySupersession: { requestId: randomUUID(), expectedIssueRevision: issue.updatedAt.toISOString(),
      expectedAssigneeAgentId: agentId, residualObjective: "Complete the residual with the explicitly selected current execution profile.", maxRunSeconds: 120 } };
    const [fresh, duplicate] = await Promise.all([request(app).post(`/api/agents/${agentId}/wakeup`).send(body), request(app).post(`/api/agents/${agentId}/wakeup`).send(body)]);
    expect(fresh.status).toBe(202);
    expect(duplicate.body.id).toBe(fresh.body.id);
    const successor = (await waitForRunToFinish(heartbeat, fresh.body.id))!;
    expect(successor.status).toBe("succeeded");
    expect(suppressedRetryPhysicalInvocations).toBe(1);
    expect(successor.scheduledRetryAttempt).toBe(1);
    expect(successor.contextSnapshot?.resourceDeadline).toMatchObject({ maxRunSeconds: 120 });
    expect((await heartbeat.getRun(failed.id))?.contextSnapshot).toEqual(failed.contextSnapshot);
    expect((await heartbeat.getRun(runId))?.scheduledRetryAttempt).toBe(1);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, failed.id))).toHaveLength(1);
  });

  it.each([false, true])("distinguishes authorized workspace bookkeeping from changed effective commands (changed: %s)", async changed => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry({ project: true });
    profileDispatchHooks.afterAcquire = async () => {
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const [local] = await db.select().from(environments).where(eq(environments.driver, "local"));
      const [workspace] = await db.insert(executionWorkspaces).values({ companyId, projectId: issue.projectId!, sourceIssueId: issueId,
        mode: "adapter_managed", strategyType: "cwd", name: "Runtime materialization", metadata: { config: { environmentId: local.id,
          ...(changed ? { provisionCommand: "must-never-run" } : {}) } } }).returning();
      await db.update(issues).set({ executionWorkspaceId: workspace.id }).where(eq(issues.id, issueId));
    };
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(202);
    const successor = await waitForRunToFinish(heartbeat, response.body.id);
    if (changed) {
      expect(successor?.error).toContain("continuation_execution_profile_changed");
      expect(suppressedRetryPhysicalInvocations).toBe(0);
    } else {
      expect(successor?.status).toBe("succeeded");
      expect(suppressedRetryPhysicalInvocations).toBe(1);
    }
  });

  it("captures the actual dispatched profile and never relabels it with later saved settings", async () => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry();
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(202);
    const dispatched = (await waitForRunToFinish(heartbeat, response.body.id))!;
    expect(suppressedRetryPhysicalInvocations).toBe(1);
    const captured = (dispatched.runnerProfileJson as any)?.executionProfileBinding;
    expect(captured).toMatchObject({ version: 1, fingerprint: expect.any(String) });
    await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: false }, safetyPreset: "testing" } }).where(eq(agents.id, agentId));
    await db.update(heartbeatRuns).set({ status: "timed_out", error: "Original profile timeout", errorCode: "adapter_failed" }).where(eq(heartbeatRuns.id, dispatched.id));
    const { persistRetrySuppression } = await import("../services/execution-retry-disposition.js");
    const source = (await heartbeat.getRun(dispatched.id))!;
    const held = await persistRetrySuppression(db, source, "disabled in fixture");
    expect(held?.executionProfileFingerprint).toBe(captured.fingerprint);
    const { readExecutionProfileBinding } = await import("../services/execution-profile-binding.js");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect((await readExecutionProfileBinding(db, issue, agent)).fingerprint).not.toBe(captured.fingerprint);
  });

  it("keeps an unstamped legacy source unsupported instead of capturing current settings at suppression", async () => {
    const { companyId, agentId, runId } = await seedSuppressedRetry({ unstamped: true });
    const source = (await heartbeat.getRun(runId))!;
    expect((source.resultJson?.retryDisposition as any)?.executionProfileFingerprint).toBeNull();
    expect(source.runnerProfileJson?.executionProfileBinding).toBeUndefined();
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(409);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each([false, true])("rejects changed or legacy exact target but accepts one fresh target supersession without resetting source history (unstamped: %s)", async unstamped => {
    const [environmentA] = await db.insert(environments).values({ name: `Stopped A ${randomUUID()}`, driver: "ssh", config: { host: "never-contact.invalid", user: "fixture" } }).returning();
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry({ sourceEnvironmentId: environmentA.id, unstamped, attempt: 1, deadlineAt: "2030-01-01T00:00:00.000Z" });
    const { environmentService } = await import("../services/environments.js");
    const environmentB = await environmentService(db).ensureLocalEnvironment(companyId);
    await db.update(agents).set({ defaultEnvironmentId: environmentB.id }).where(eq(agents.id, agentId));
    const oldSource = (await heartbeat.getRun(runId))!;
    if (unstamped) {
      expect((oldSource.resultJson?.retryDisposition as any)?.executionProfileFingerprint).toBeNull();
      expect(oldSource.runnerProfileJson?.executionProfileBinding).toBeUndefined();
    }
    const app = await boardWakeApp(companyId);
    const base = { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId };
    expect((await request(app).post(`/api/agents/${agentId}/wakeup`).send(base)).status).toBe(409);
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const decision = { ...base, retrySupersession: { requestId: randomUUID(), expectedIssueRevision: issue.updatedAt.toISOString(),
      expectedAssigneeAgentId: agentId, residualObjective: "Complete reviewed residual on the newly selected target B.", maxRunSeconds: 120 } };
    const [first, duplicate] = await Promise.all([request(app).post(`/api/agents/${agentId}/wakeup`).send(decision), request(app).post(`/api/agents/${agentId}/wakeup`).send(decision)]);
    expect(first.status).toBe(202);
    expect(duplicate.body.id).toBe(first.body.id);
    const successor = (await waitForRunToFinish(heartbeat, first.body.id))!;
    expect(suppressedRetryPhysicalInvocations).toBe(1);
    expect(successor.status).toBe("succeeded");
    const { readExecutionProfileBinding } = await import("../services/execution-profile-binding.js");
    const [agent] = await db.select().from(agents).where(eq(agents.id, agentId));
    const [currentIssue] = await db.select().from(issues).where(eq(issues.id, issueId));
    expect((successor.runnerProfileJson as any)?.executionProfileBinding?.fingerprint).toBe((await readExecutionProfileBinding(db, currentIssue, agent)).fingerprint);
    expect((await heartbeat.getRun(runId))?.contextSnapshot).toEqual(oldSource.contextSnapshot);
    expect((await heartbeat.getRun(runId))?.usageJson).toEqual(oldSource.usageJson);
    expect((await heartbeat.getRun(runId))?.scheduledRetryAttempt).toBe(1);
    expect(successor.scheduledRetryAttempt).toBe(1);
    expect(successor.contextSnapshot?.resourceDeadline).toMatchObject({ maxRunSeconds: 120 });
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
  });

  it.each(["environment_selector", "ai_connection", "safety_preset", "environment_config", "instance_selector"])("rejects exact retry after only %s changes, before launch", async change => {
    const { companyId, agentId, runId } = await seedSuppressedRetry();
    const { environmentService } = await import("../services/environments.js");
    const selectedLocal = await environmentService(db).ensureLocalEnvironment(companyId);
    if (change === "environment_selector") await db.update(agents).set({ defaultEnvironmentId: selectedLocal.id }).where(eq(agents.id, agentId));
    if (change === "ai_connection") await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true }, aiConnection: { mode: "agent", connectionId: randomUUID() } } }).where(eq(agents.id, agentId));
    if (change === "safety_preset") await db.update(agents).set({ runtimeConfig: { heartbeat: { wakeOnDemand: true }, safetyPreset: "testing" } }).where(eq(agents.id, agentId));
    if (change === "environment_config") {
      const { environmentService } = await import("../services/environments.js");
      const local = await environmentService(db).ensureLocalEnvironment(companyId);
      await db.update(environments).set({ config: { executionProfile: "changed" } }).where(eq(environments.id, local.id));
    }
    if (change === "instance_selector") {
      const { instanceSettingsService } = await import("../services/instance-settings.js");
      await instanceSettingsService(db).update({ defaultEnvironmentId: selectedLocal.id });
    }
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(409);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each(["interrupted", "cancelled"])("admits the verified suppressed %s source through the public exact retry route", async status => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry({ status });
    const app = await boardWakeApp(companyId);
    const response = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(202);
    expect(response.body.retryOfRunId).toBe(runId);
    await waitForRunToFinish(heartbeat, response.body.id);
    expect((await heartbeat.getRun(runId))?.status).toBe(status);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
  });

  it.each(["scope", "reassigned", "deadline"])("authorizes a new %s residual once through public admission across concurrency and restart", async change => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry({ attempt: 1,
      ...(change === "deadline" ? { deadlineAt: "2020-01-01T00:00:00.000Z" } : {}) });
    let currentAgentId = agentId;
    if (change === "reassigned") {
      currentAgentId = randomUUID();
      await db.insert(agents).values({ id: currentAgentId, companyId, name: "Current owner", role: "engineer", status: "active",
        adapterType: SUPPRESSED_RETRY_TEST_ADAPTER, runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    }
    await db.update(issues).set({ assigneeAgentId: currentAgentId, description: "Newly reviewed scope", updatedAt: new Date(),
      executionPolicy: { resourceLimits: { maxRunSeconds: 600 } } }).where(eq(issues.id, issueId));
    const [current] = await db.select().from(issues).where(eq(issues.id, issueId));
    const oldSource = (await heartbeat.getRun(runId))!;
    const body = { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId,
      retrySupersession: { requestId: randomUUID(), expectedIssueRevision: current.updatedAt.toISOString(), expectedAssigneeAgentId: currentAgentId,
        residualObjective: "Inspect the preserved work and complete the current requested residual.", maxRunSeconds: 120 } };
    const app = await boardWakeApp(companyId);
    const [first, duplicate] = await Promise.all([request(app).post(`/api/agents/${currentAgentId}/wakeup`).send(body), request(app).post(`/api/agents/${currentAgentId}/wakeup`).send(body)]);
    expect(first.status).toBe(202);
    expect(duplicate.status).toBe(202);
    expect(first.body.id).toBe(duplicate.body.id);
    await waitForRunToFinish(heartbeat, first.body.id);
    const restarted = await boardWakeApp(companyId);
    const replay = await request(restarted).post(`/api/agents/${currentAgentId}/wakeup`).send(body);
    expect(replay.status).toBe(202);
    expect(replay.body.id).toBe(first.body.id);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(1);
    const source = (await heartbeat.getRun(runId))!;
    expect(source).toMatchObject({ status: oldSource.status, error: oldSource.error, scheduledRetryAttempt: 1 });
    expect(source.resultJson?.artifacts).toEqual(["kept"]);
    expect(source.contextSnapshot?.resourceDeadline).toEqual(oldSource.contextSnapshot?.resourceDeadline);
    const successor = (await heartbeat.getRun(first.body.id))!;
    expect(successor.scheduledRetryAttempt).toBe(1);
    expect(successor.contextSnapshot?.resourceDeadline).toMatchObject({ runId: successor.id, maxRunSeconds: 120 });
    expect((successor.contextSnapshot?.executionContinuation as any)?.objective).toBe(body.retrySupersession.residualObjective);
    const decisions = await db.select().from(activityLog).where(and(eq(activityLog.companyId, companyId), eq(activityLog.entityId, runId), eq(activityLog.action, "issue.retry_superseded")));
    expect(decisions).toHaveLength(1);
  });

  it.each(["stale", "budget", "owner", "unverified_source"])("refuses a %s new residual decision through public admission", async refusal => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry();
    await db.update(issues).set({ executionPolicy: { resourceLimits: { maxRunSeconds: 60 } }, updatedAt: new Date() }).where(eq(issues.id, issueId));
    const [current] = await db.select().from(issues).where(eq(issues.id, issueId));
    if (refusal === "unverified_source") await db.delete(activityLog).where(eq(activityLog.entityId, runId));
    const decision = { requestId: randomUUID(), expectedIssueRevision: refusal === "stale" ? "2020-01-01T00:00:00.000Z" : current.updatedAt.toISOString(),
      expectedAssigneeAgentId: refusal === "owner" ? randomUUID() : agentId, residualObjective: "Complete only the reviewed and newly requested residual.", maxRunSeconds: refusal === "budget" ? 120 : 30 };
    const app = await boardWakeApp(companyId);
    const response = await request(app).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId, retrySupersession: decision });
    expect(response.status).toBe(409);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each(["verified", "no_owner", "journal", "generation", "launch", "source", "process_event", "cleanup", "cleanup_pending", "cleanup_failed_released"])("authorizes only a proven never-launched failed source (%s)", async mode => {
    const fixture = await seedSuppressedRetry({ status: "failed" });
    const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-never-launched-"));
    const { companyId, agentId, issueId, runId } = fixture;
    try {
      await db.update(heartbeatRuns).set({ startedAt: new Date(Date.now() - 1000), finishedAt: new Date(),
        processPid: null, processGroupId: null, processStartedAt: null,
        contextSnapshot: { issueId, paperclipWorkspace: { cwd: root } } }).where(eq(heartbeatRuns.id, runId));
      const { workspaceWriteOwnershipService } = await import("../services/workspace-write-ownership.js");
      const ownership = workspaceWriteOwnershipService(db);
      const claim = await ownership.claim({ cwd: root, companyId, issueId, runId });
      if (claim.outcome !== "claimed") throw new Error("Expected private fixture ownership");
      await ownership.releaseIfStopped(claim.owner);
      const [owner] = await db.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, claim.owner.id));
      if (mode === "no_owner") await db.delete(workspaceWriteOwners).where(eq(workspaceWriteOwners.id, owner.id));
      if (mode === "journal") await db.update(workspaceWriteOwners).set({ history: [] }).where(eq(workspaceWriteOwners.id, owner.id));
      if (mode === "generation") await db.update(workspaceWriteOwners).set({ history: owner.history.map(event => ({ ...event, generation: randomUUID() })) }).where(eq(workspaceWriteOwners.id, owner.id));
      if (mode === "launch") await db.update(workspaceWriteOwners).set({ history: [...owner.history, { event: "launch_reserved", launchId: randomUUID(), generation: owner.generation }] }).where(eq(workspaceWriteOwners.id, owner.id));
      if (mode === "source") await db.update(heartbeatRuns).set({ contextSnapshot: { issueId, paperclipWorkspace: { cwd: path.dirname(root) } } }).where(eq(heartbeatRuns.id, runId));
      if (mode === "process_event") await db.insert(heartbeatRunEvents).values({ companyId, agentId, runId, seq: 999, eventType: "legacy.process_identity_recorded", stream: "system", payload: { localProcess: true, processPid: 123 } });
      if (mode === "cleanup") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "failed", cleanupStatus: "failed" });
      if (mode === "cleanup_pending" || mode === "cleanup_failed_released") await db.insert(environmentLeases).values({ companyId, heartbeatRunId: runId, provider: "local", status: "failed", releasedAt: new Date(), cleanupStatus: mode === "cleanup_pending" ? "pending" : "failed" });
      const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
      const body = { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId,
        retrySupersession: { requestId: randomUUID(), expectedIssueRevision: issue.updatedAt.toISOString(), expectedAssigneeAgentId: agentId,
          residualObjective: "Complete only the authorized remaining read-only verification after a pre-launch rejection.", maxRunSeconds: 120 } };
      const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send(body);
      if (mode === "verified") {
        expect(response.status, JSON.stringify(response.body)).toBe(202);
        await waitForRunToFinish(heartbeat, response.body.id);
        expect(suppressedRetryPhysicalInvocations).toBe(1);
        expect((await heartbeat.getRun(runId))?.status).toBe("failed");
      } else {
        expect(response.status, JSON.stringify(response.body)).toBe(409);
        expect(suppressedRetryPhysicalInvocations).toBe(0);
      }
    } finally { await fs.rm(root, { recursive: true, force: true }); }
  });

  it("rechecks current scope before committing the superseding decision", async () => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry();
    const [issue] = await db.select().from(issues).where(eq(issues.id, issueId));
    const { validateSuppressedRetryResume, consumeSuppressedRetryResume } = await import("../services/execution-retry-disposition.js");
    await expect(db.transaction(async tx => {
      await tx.execute(sql`select id from issues where company_id = ${companyId} and id = ${issueId} for update`);
      const admission = (await validateSuppressedRetryResume(tx as any, { companyId, agentId, issueId, sourceRunId: runId,
        actorType: "user", actorId: "local-board", reason: "retry_failed_run", retrySupersession: { requestId: randomUUID(),
          expectedIssueRevision: issue.updatedAt.toISOString(), expectedAssigneeAgentId: agentId,
          residualObjective: "Complete only the current reviewed residual.", maxRunSeconds: 120 } }))!;
      await tx.update(agents).set({ adapterConfig: { cwd: "/changed-during-admission" } }).where(eq(agents.id, agentId));
      await consumeSuppressedRetryResume(tx as any, admission.source, admission.disposition, "local-board", randomUUID(), admission.supersession);
    })).rejects.toThrow("scope changed before the decision committed");
    expect((await heartbeat.getRun(runId))?.retryDisposition?.state).toBe("blocked");
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each(["interrupted", "cancelled"])("keeps unverified %s sources outside the public generic retry surface", async status => {
    const { companyId, agentId, runId } = await seedSuppressedRetry({ status });
    await db.delete(activityLog).where(eq(activityLog.entityId, runId));
    const response = await request(await boardWakeApp(companyId)).post(`/api/agents/${agentId}/wakeup`).send({ source: "on_demand", reason: "retry_failed_run", failedRunId: runId });
    expect(response.status).toBe(409);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it("holds automatic wakes and consumes an exact operator retry once", async () => {
    const { companyId, agentId, issueId, runId } = await seedSuppressedRetry();
    const restarted = heartbeatService(db);
    await restarted.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_assignment_recovery", payload: { issueId }, requestedByActorType: "system" });
    expect(suppressedRetryPhysicalInvocations).toBe(0);
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    const retry = () => restarted.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId,
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board" });
    const [first, duplicate] = await Promise.all([retry(), retry()]);
    expect(first?.id).toBe(duplicate?.id);
    expect(first?.retryOfRunId).toBe(runId);
    await waitForRunToFinish(restarted, first!.id);
    expect(suppressedRetryPhysicalInvocations).toBe(1);
    expect((await restarted.getRun(runId))?.resultJson?.retryDisposition).toMatchObject({ state: "resumed", successorRunId: first!.id, resumedByUserId: "local-board" });
    expect((await restarted.getRun(runId))?.resultJson?.artifacts).toEqual(["kept"]);
    expect((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0]).toMatchObject({ status: "resolved" });
    expect(issueRecoveryActionReadModelSchema.safeParse((await db.select().from(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId)))[0]).success).toBe(true);
  });

  it("retains the original source deadline and spent attempt count in its successor", async () => {
    const deadlineAt = "2030-01-01T00:00:00.000Z";
    const { agentId, issueId, runId } = await seedSuppressedRetry({ deadlineAt, attempt: 1 });
    const successor = await heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId,
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board" });
    expect(successor?.scheduledRetryAttempt).toBe(1);
    await waitForRunToFinish(heartbeat, successor!.id);
    expect((await heartbeat.getRun(successor!.id))?.contextSnapshot?.resourceDeadline).toMatchObject({ runId: successor!.id, deadlineAt, maxRunSeconds: 600 });
  });

  it("does not trust matching adapter-shaped suppression event and result without system audit authority", async () => {
    const { agentId, issueId, runId } = await seedSuppressedRetry();
    const original = (await heartbeat.getRun(runId))!;
    // Adapter callbacks can create ordinary lifecycle/system events with null
    // transport fields. Keeping that same-shaped pair is not server authority.
    await db.delete(activityLog).where(eq(activityLog.entityId, runId));
    await db.delete(issueRecoveryActions).where(eq(issueRecoveryActions.sourceIssueId, issueId));
    await db.update(issues).set({ status: "in_progress" }).where(eq(issues.id, issueId));
    expect(original.resultJson?.retryDisposition).toBeDefined();
    expect(await heartbeat.scheduleBoundedRetry(runId)).toMatchObject({ outcome: "scheduled" });
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it("cannot mint a hold from an actual adapter lifecycle callback and matching result", async () => {
    const { companyId, agentId, issueId } = await seedMaxTurnFixture();
    await db.update(issues).set({ assigneeAdapterOverrides: { useProjectWorkspace: false } }).where(eq(issues.id, issueId));
    const adapterType = "forged_suppression_test";
    await db.update(agents).set({ adapterType }).where(eq(agents.id, agentId));
    registerServerAdapter({ type: adapterType, execute: async context => {
      const disposition = { version: 1, state: "blocked", code: "heartbeat_wake_on_demand_disabled", sourceRunId: context.runId,
        issueId, agentId, issueRevision: "2026-10-05T00:00:00.000Z", sourceFingerprint: "adapter-chosen", workspaceFingerprint: "adapter-chosen",
        scopeFingerprint: "adapter-chosen", requiresExplicitResume: true, recoveryActionId: null };
      await context.onEvent!({ eventType: "lifecycle", stream: "system", level: "warn", payload: { retrySuppression: disposition } });
      return { exitCode: 1, signal: null, timedOut: false, errorCode: "configuration_incomplete",
        executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, resultJson: { retryDisposition: disposition,
          configurationIncomplete: { retryable: false }, conversationContinuation: "continue_conversation_v1" } };
    }, testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    try {
      const run = await heartbeat.invoke(agentId, "on_demand", { issueId }, "manual");
      const source = (await waitForRunToFinish(heartbeat, run.id))!;
      expect(source.resultJson?.retryDisposition).toMatchObject({ sourceFingerprint: "adapter-chosen" });
      const events = await db.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, run.id));
      expect(events.some(event => event.eventType === "lifecycle" && event.stream === "system" && event.payload?.retrySuppression && event.sourceEventId === null)).toBe(true);
      const { readVerifiedRetryDisposition, listVerifiedRetryHolds } = await import("../services/execution-retry-disposition.js");
      expect(await readVerifiedRetryDisposition(db, source)).toBeNull();
      expect(await listVerifiedRetryHolds(db, companyId, issueId)).toEqual([]);
    } finally { unregisterServerAdapter(adapterType); }
  });

  it.each(["missing", "forged"])("keeps the authoritative hold across restart with a %s result projection", async projection => {
    const { companyId, issueId, agentId, runId } = await seedSuppressedRetry();
    const source = (await heartbeat.getRun(runId))!;
    const result = { ...source.resultJson };
    if (projection === "missing") delete result.retryDisposition;
    else result.retryDisposition = { ...(source.resultJson!.retryDisposition as object), state: "resumed", sourceFingerprint: "forged" };
    await db.update(heartbeatRuns).set({ resultJson: result }).where(eq(heartbeatRuns.id, runId));
    for (let cycle = 0; cycle < 3; cycle += 1) {
      const restarted = heartbeatService(db);
      expect(await restarted.scheduleBoundedRetry(runId)).toMatchObject({ outcome: "not_scheduled" });
      expect((await restarted.getRun(runId))?.retryDisposition).toMatchObject({ state: "blocked", sourceRunId: runId });
      await restarted.wakeup(agentId, { source: "automation", triggerDetail: "system", reason: "issue_assignment_recovery", payload: { issueId }, requestedByActorType: "system" });
    }
    expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId))).toHaveLength(1);
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each(["terminal", "reassigned", "revision", "scope", "source", "workspace", "deadline", "physical_owner"])("rejects a %s suppressed retry without invoking a provider", async change => {
    const { agentId, issueId, runId } = await seedSuppressedRetry(change === "deadline" ? { deadlineAt: "2020-01-01T00:00:00.000Z" } : undefined);
    if (change === "terminal") await db.update(issues).set({ status: "done" }).where(eq(issues.id, issueId));
    if (change === "reassigned") await db.update(issues).set({ assigneeAgentId: null }).where(eq(issues.id, issueId));
    if (change === "revision") await db.update(issues).set({ updatedAt: new Date() }).where(eq(issues.id, issueId));
    if (change === "scope") await db.update(issues).set({ description: "Different scope" }).where(eq(issues.id, issueId));
    if (change === "source") await db.update(heartbeatRuns).set({ error: "Different incident" }).where(eq(heartbeatRuns.id, runId));
    if (change === "workspace") await db.update(agents).set({ adapterConfig: { cwd: "/different-workspace" } }).where(eq(agents.id, agentId));
    if (change === "physical_owner") await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, runId));
    await expect(heartbeat.wakeup(agentId, { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: runId,
      payload: { issueId }, requestedByActorType: "user", requestedByActorId: "local-board" })).rejects.toThrow();
    expect(suppressedRetryPhysicalInvocations).toBe(0);
  });

  it.each([
    ["interaction", false], ["approval", false], ["interaction", true], ["approval", true],
  ] as const)("waits for a pending %s before continuing (already scheduled: %s)", async (kind, alreadyScheduled) => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
    await db.update(heartbeatRuns).set({ status: "interrupted", errorCode: "process_lost",
      resultJson: { conversationContinuation: "continue_conversation_v1" } }).where(eq(heartbeatRuns.id, runId));
    let retryRunId = runId;
    if (alreadyScheduled) {
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, { now, random: () => 0 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") throw new Error("Expected a retry");
      retryRunId = scheduled.run.id;
    }
    if (kind === "interaction") {
      await db.insert(issueThreadInteractions).values({ companyId, issueId, kind: "ask_user_questions",
        status: "pending", payload: { version: 1, questions: [] } });
    } else {
      const approvalId = randomUUID();
      await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: {} });
      await db.insert(issueApprovals).values({ companyId, issueId, approvalId });
    }
    if (alreadyScheduled) {
      const adapter = createPostgresRunDispatchAdapter(db);
      expect(await adapter.promoteOrCancelDueRetry({ companyId, runId: retryRunId, now: new Date(now.getTime() + 60_000) }))
        .toMatchObject({ outcome: "gate_suppressed", errorCode: "issue_waiting_for_response" });
      const stopped = await heartbeat.getRun(retryRunId);
      expect(stopped?.status).toBe("cancelled");
      const { legacyExecutionNeedsReconciliation } = await import("../services/legacy-execution-recovery.js");
      expect(legacyExecutionNeedsReconciliation(stopped!)).toBe(false);
    } else {
      expect(await heartbeat.scheduleBoundedRetry(runId, { now }))
        .toMatchObject({ outcome: "not_scheduled", errorCode: "issue_waiting_for_response" });
    }
  });

  it("schedules a retry with durable metadata and only promotes it when due", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T12:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    const issueId = randomUUID();
    await db.insert(issues).values({ id: issueId, companyId, title: "Retry promotion", status: "in_progress", assigneeAgentId: agentId });
    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId,
      invocationSource: "assignment",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const expectedDueAt = new Date(now.getTime() + BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS[0]);
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(expectedDueAt.toISOString());

    const retryRun = await db
      .select()
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      status: "scheduled_retry",
      retryOfRunId: sourceRunId,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: "transient_failure",
    });
    expect(retryRun?.contextSnapshot as Record<string, unknown>).not.toHaveProperty("modelProfile");
    expect(retryRun?.scheduledRetryAt?.toISOString()).toBe(expectedDueAt.toISOString());

    const earlyPromotion = await heartbeat.promoteDueScheduledRetries(new Date(expectedDueAt.getTime() - 1));
    expect(earlyPromotion).toEqual({ promoted: 0, runIds: [] });

    const stillScheduled = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(stillScheduled?.status).toBe("scheduled_retry");

    const duePromotion = await heartbeat.promoteDueScheduledRetries(expectedDueAt);
    expect(duePromotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const promotedRun = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(promotedRun?.status).toBe("queued");
  });

  it("schedules max-turn continuations with distinct retry metadata", async () => {
    const { runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.dueAt.toISOString()).toBe(new Date(now.getTime() + 1_000).toISOString());

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
    });
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.wakeReason).toBe(
      MAX_TURN_CONTINUATION_WAKE_REASON,
    );
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(MAX_TURN_CONTINUATION_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      retryOfRunId: runId,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });
  });

  it("schedules accepted interaction continuation infra retries while the issue is in_review", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.attempt).toBe(1);
    expect(scheduled.maxAttempts).toBe(3);

    const retryRun = await db
      .select({
        retryOfRunId: heartbeatRuns.retryOfRunId,
        status: heartbeatRuns.status,
        scheduledRetryAttempt: heartbeatRuns.scheduledRetryAttempt,
        scheduledRetryReason: heartbeatRuns.scheduledRetryReason,
        contextSnapshot: heartbeatRuns.contextSnapshot,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun).toMatchObject({
      retryOfRunId: runId,
      status: "scheduled_retry",
      scheduledRetryAttempt: 1,
      scheduledRetryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
    });
    expect(retryRun?.contextSnapshot).toMatchObject({
      issueId,
      interactionId,
      interactionStatus: "accepted",
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      scheduledRetryAttempt: 1,
    });

    const wakeupRequest = await db
      .select({ reason: agentWakeupRequests.reason, payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);
    expect(wakeupRequest?.reason).toBe(INTERACTION_CONTINUATION_INFRA_WAKE_REASON);
    expect(wakeupRequest?.payload).toMatchObject({
      issueId,
      interactionId,
      retryOfRunId: runId,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      scheduledRetryAttempt: 1,
    });

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(scheduled.run.id);
  });

  it("coalesces duplicate accepted interaction continuation infra retry schedules", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const retryOptions = {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    };
    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;
    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({ id: heartbeatRuns.id, wakeupRequestId: heartbeatRuns.wakeupRequestId })
      .from(heartbeatRuns)
      .where(and(
        eq(heartbeatRuns.retryOfRunId, runId),
        eq(heartbeatRuns.scheduledRetryReason, INTERACTION_CONTINUATION_INFRA_RETRY_REASON),
        eq(heartbeatRuns.scheduledRetryAttempt, 1),
      ));
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, INTERACTION_CONTINUATION_INFRA_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);
  });

  it.each([
    {
      name: "renamed branch",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:renamed",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "clean",
      }),
    },
    {
      name: "dirty worktree",
      workspaceValidation: (workspaceId: string) => ({
        reason: "git_worktree_branch_incoherence",
        fingerprint: "workspace_incoherence:v1:sha256:dirty",
        executionWorkspaceId: workspaceId,
        expectedBranch: "stale-plan-approval-workspace",
        actualBranch: "feat/skill-studio-test-runs",
        cleanliness: "dirty",
        safeRepair: {
          eligible: false,
          attempted: false,
          succeeded: false,
          reason: "worktree is not clean",
        },
      }),
    },
  ])("quarantines a failed $name workspace before scheduling the accepted interaction retry", async ({ workspaceValidation }) => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const executionWorkspaceId = randomUUID();
    const validation = workspaceValidation(executionWorkspaceId);

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values({
      id: executionWorkspaceId,
      companyId,
      projectId,
      sourceIssueId: issueId,
      mode: "isolated_workspace",
      strategyType: "git_worktree",
      name: "stale-plan-approval-workspace",
      status: "active",
      cwd: "/workspace/stale-plan-approval-workspace",
      baseRef: "origin/master",
      branchName: "stale-plan-approval-workspace",
      providerType: "git_worktree",
      providerRef: "/workspace/stale-plan-approval-workspace",
      metadata: { existing: true },
    });
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
        executionWorkspaceSettings: issues.executionWorkspaceSettings,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: null,
      executionWorkspacePreference: null,
      executionWorkspaceSettings: { mode: "isolated_workspace" },
    });

    const workspace = await db
      .select({
        status: executionWorkspaces.status,
        closedAt: executionWorkspaces.closedAt,
        cleanupEligibleAt: executionWorkspaces.cleanupEligibleAt,
        cleanupReason: executionWorkspaces.cleanupReason,
        metadata: executionWorkspaces.metadata,
      })
      .from(executionWorkspaces)
      .where(eq(executionWorkspaces.id, executionWorkspaceId))
      .then((rows) => rows[0] ?? null);
    expect(workspace).toMatchObject({
      status: "archived",
      cleanupEligibleAt: null,
      cleanupReason: "workspace_validation_failed",
    });
    expect(workspace?.closedAt?.toISOString()).toBe(now.toISOString());
    expect(workspace?.metadata).toMatchObject({
      existing: true,
      workspaceValidationQuarantine: {
        reason: "workspace_validation_failed",
        retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
        sourceRunId: runId,
        retryRunId: scheduled.run.id,
        issueId,
        sourceIssueId: issueId,
        workspaceValidation: validation,
      },
    });

    const retryRun = await db
      .select({ contextSnapshot: heartbeatRuns.contextSnapshot })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(retryRun?.contextSnapshot).toMatchObject({
      workspaceValidationRecovery: {
        strategy: "quarantine_failed_workspace_and_retry_clean",
        sourceRunId: runId,
        reason: "git_worktree_branch_incoherence",
        fingerprint: validation.fingerprint,
        failedExecutionWorkspaceId: executionWorkspaceId,
      },
    });

    const activity = await db
      .select({ action: activityLog.action, entityId: activityLog.entityId, details: activityLog.details })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ))
      .then((rows) => rows[0] ?? null);
    expect(activity).toMatchObject({
      action: "execution_workspace.workspace_validation_quarantined",
      entityId: executionWorkspaceId,
      details: expect.objectContaining({
        retryRunId: scheduled.run.id,
        workspaceValidation: validation,
      }),
    });

    const agent = await db
      .select({ id: agents.id })
      .from(agents)
      .where(eq(agents.id, agentId))
      .then((rows) => rows[0] ?? null);
    expect(agent?.id).toBe(agentId);
  });

  it("does not quarantine another issue's workspace when validation payload is stale", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const foreignIssueId = randomUUID();
    const foreignWorkspaceId = randomUUID();
    const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale",
      executionWorkspaceId: foreignWorkspaceId,
      expectedBranch: "current-issue-branch",
      actualBranch: "foreign-issue-branch",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(issues).values({
      id: foreignIssueId,
      companyId,
      title: "Other active issue",
      status: "in_progress",
      priority: "medium",
      responsibleUserId: "responsible-user",
      issueNumber: 2,
      identifier: `${issuePrefix}-2`,
    });
    await db.insert(executionWorkspaces).values([
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-issue-branch",
        status: "active",
        cwd: "/workspace/current-issue-branch",
        baseRef: "origin/master",
        branchName: "current-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/current-issue-branch",
        metadata: { current: true },
      },
      {
        id: foreignWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: foreignIssueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "foreign-issue-branch",
        status: "active",
        cwd: "/workspace/foreign-issue-branch",
        baseRef: "origin/master",
        branchName: "foreign-issue-branch",
        providerType: "git_worktree",
        providerRef: "/workspace/foreign-issue-branch",
        metadata: { foreign: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: foreignWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: foreignWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [currentWorkspaceId, foreignWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
      expect.objectContaining({ id: foreignWorkspaceId, status: "active", metadata: { foreign: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not quarantine an owned workspace that is no longer attached to the issue", async () => {
    const { companyId, issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "in_review" });
    const projectId = randomUUID();
    const staleWorkspaceId = randomUUID();
    const currentWorkspaceId = randomUUID();
    const validation = {
      reason: "git_worktree_branch_incoherence",
      fingerprint: "workspace_incoherence:v1:sha256:stale-owned",
      executionWorkspaceId: staleWorkspaceId,
      expectedBranch: "old-plan-approval-workspace",
      actualBranch: "current-plan-approval-workspace",
      cleanliness: "clean",
    };

    await db.insert(projects).values({
      id: projectId,
      companyId,
      name: "Paperclip App",
      status: "in_progress",
    });
    await db.insert(executionWorkspaces).values([
      {
        id: staleWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "old-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/old-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "old-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/old-plan-approval-workspace",
        metadata: { stale: true },
      },
      {
        id: currentWorkspaceId,
        companyId,
        projectId,
        sourceIssueId: issueId,
        mode: "isolated_workspace",
        strategyType: "git_worktree",
        name: "current-plan-approval-workspace",
        status: "active",
        cwd: "/workspace/current-plan-approval-workspace",
        baseRef: "origin/master",
        branchName: "current-plan-approval-workspace",
        providerType: "git_worktree",
        providerRef: "/workspace/current-plan-approval-workspace",
        metadata: { current: true },
      },
    ]);
    await db
      .update(issues)
      .set({
        projectId,
        executionWorkspaceId: currentWorkspaceId,
        executionWorkspacePreference: "reuse_existing",
        executionWorkspaceSettings: { mode: "isolated_workspace" },
      })
      .where(eq(issues.id, issueId));

    const interactionId = randomUUID();
    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false }, workspaceValidation: validation },
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId,
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionWorkspaceId: issues.executionWorkspaceId,
        executionWorkspacePreference: issues.executionWorkspacePreference,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: scheduled.run.id,
      executionWorkspaceId: currentWorkspaceId,
      executionWorkspacePreference: "reuse_existing",
    });

    const workspaces = await db
      .select({ id: executionWorkspaces.id, status: executionWorkspaces.status, metadata: executionWorkspaces.metadata })
      .from(executionWorkspaces)
      .where(inArray(executionWorkspaces.id, [staleWorkspaceId, currentWorkspaceId]));
    expect(workspaces).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: staleWorkspaceId, status: "active", metadata: { stale: true } }),
      expect.objectContaining({ id: currentWorkspaceId, status: "active", metadata: { current: true } }),
    ]));

    const activity = await db
      .select({ id: activityLog.id })
      .from(activityLog)
      .where(and(
        eq(activityLog.companyId, companyId),
        eq(activityLog.action, "execution_workspace.workspace_validation_quarantined"),
      ));
    expect(activity).toHaveLength(0);
  });

  it("does not schedule accepted interaction continuation infra retries after terminal issue status", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture({ issueStatus: "done" });

    await db
      .update(heartbeatRuns)
      .set({
        error: "workspace validation failed before dispatch",
        errorCode: "workspace_validation_failed",
        resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false },},
        contextSnapshot: {
          issueId,
          taskId: issueId,
          wakeReason: "issue_commented",
          mutation: "interaction",
          interactionId: randomUUID(),
          interactionKind: "request_confirmation",
          interactionStatus: "accepted",
        },
      })
      .where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: INTERACTION_CONTINUATION_INFRA_RETRY_REASON,
      wakeReason: INTERACTION_CONTINUATION_INFRA_WAKE_REASON,
      maxAttempts: 3,
    });

    expect(scheduled).toMatchObject({
      outcome: "not_scheduled",
      errorCode: "issue_terminal_status",
      issueId,
    });
  });

  it("coalesces duplicate max-turn continuation schedules for the same source run and attempt", async () => {
    const { issueId, runId, now } = await seedMaxTurnFixture();
    const retryOptions = {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    };

    const [first, second] = await Promise.all([
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
      heartbeat.scheduleBoundedRetry(runId, retryOptions),
    ]);

    expect(first.outcome).toBe("scheduled");
    expect(second.outcome).toBe("scheduled");
    if (first.outcome !== "scheduled" || second.outcome !== "scheduled") return;

    expect(new Set([first.run.id, second.run.id]).size).toBe(1);

    const retryRuns = await db
      .select({
        id: heartbeatRuns.id,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(
        and(
          eq(heartbeatRuns.retryOfRunId, runId),
          eq(heartbeatRuns.scheduledRetryReason, MAX_TURN_CONTINUATION_RETRY_REASON),
          eq(heartbeatRuns.scheduledRetryAttempt, 1),
        ),
      );
    expect(retryRuns).toHaveLength(1);

    const wakeups = await db
      .select({
        id: agentWakeupRequests.id,
        coalescedCount: agentWakeupRequests.coalescedCount,
        idempotencyKey: agentWakeupRequests.idempotencyKey,
      })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.reason, MAX_TURN_CONTINUATION_WAKE_REASON));
    expect(wakeups).toHaveLength(1);
    expect(wakeups[0]).toMatchObject({
      id: retryRuns[0]?.wakeupRequestId,
      coalescedCount: 1,
    });
    expect(wakeups[0]?.idempotencyKey).toContain(`:${issueId}:${runId}:1`);

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(retryRuns[0]?.id);
  });

  it.each(["schedule", "transaction", "promote", "dispatch"] as const)(
    "suppresses a busy-subscription retry whose task lock was cleared before %s",
    async (phase) => {
      const { companyId, issueId, runId, now } = await seedMaxTurnFixture();
      await db.update(heartbeatRuns).set({
        status: "cancelled", errorCode: "ai_connection_busy",
        resultJson: { executionRecovery: { kind: "ai_connection_wait", providerWorkStarted: false } },
      }).where(eq(heartbeatRuns.id, runId));
      const clearLock = () => db.update(issues).set({ executionRunId: null }).where(eq(issues.id, issueId));
      if (phase === "schedule") await clearLock();
      const transaction = db.transaction.bind(db);
      let raceApplied = false;
      const transactionSpy = phase === "transaction"
        ? vi.spyOn(db, "transaction").mockImplementationOnce(async (callback, config) => {
            await clearLock();
            raceApplied = true;
            return transaction(callback, config);
          })
        : null;
      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now, retryReason: "ai_connection_busy", wakeReason: "ai_connection_busy_retry",
        maxAttempts: 1, delayMs: 1_000,
      }).finally(() => transactionSpy?.mockRestore());
      if (phase === "transaction") expect(raceApplied).toBe(true);
      if (phase === "schedule" || phase === "transaction") {
        expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "issue_execution_lock_changed" });
        expect(await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.retryOfRunId, runId))).toHaveLength(0);
        return;
      }
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;
      if (phase === "promote") await clearLock();
      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      if (phase === "promote") {
        expect(promotion).toEqual({ promoted: 0, runIds: [] });
      } else {
        expect(promotion.runIds).toContain(scheduled.run.id);
        await clearLock();
        const adapter = createPostgresRunDispatchAdapter(db);
        expect(await adapter.cancelStaleQueuedRun({
          companyId, runId: scheduled.run.id, expectedStatus: "queued", now: scheduled.dueAt,
        })).toMatchObject({ outcome: "cancelled", errorCode: "issue_execution_lock_changed" });
      }
      expect(await heartbeat.getRun(scheduled.run.id)).toMatchObject({
        status: "cancelled", errorCode: "issue_execution_lock_changed",
      });
    },
  );

  it("does not promote a duplicate max-turn continuation that does not own the issue lock", async () => {
    const { companyId, agentId, issueId, runId, now } = await seedMaxTurnFixture();

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
      maxAttempts: 2,
      delayMs: 1_000,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    const duplicateWakeupId = randomUUID();
    const duplicateRunId = randomUUID();
    await db.insert(agentWakeupRequests).values({
      id: duplicateWakeupId,
      companyId,
      agentId,
      source: "automation",
      triggerDetail: "system",
      reason: MAX_TURN_CONTINUATION_WAKE_REASON,
      payload: {
        issueId,
        retryOfRunId: runId,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        scheduledRetryAttempt: 1,
      },
      status: "queued",
      requestedByActorType: "system",
    });
    await db.insert(heartbeatRuns).values({
      id: duplicateRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      triggerDetail: "system",
      status: "scheduled_retry",
      wakeupRequestId: duplicateWakeupId,
      retryOfRunId: runId,
      scheduledRetryAt: scheduled.dueAt,
      scheduledRetryAttempt: 1,
      scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      contextSnapshot: {
        issueId,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      },
    });
    await db
      .update(agentWakeupRequests)
      .set({ runId: duplicateRunId })
      .where(eq(agentWakeupRequests.id, duplicateWakeupId));

    const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
    expect(promotion).toEqual({ promoted: 1, runIds: [scheduled.run.id] });

    const duplicate = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, duplicateRunId))
      .then((rows) => rows[0] ?? null);
    expect(duplicate).toEqual({
      status: "cancelled",
      errorCode: "issue_execution_lock_changed",
    });

    const duplicateWakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, duplicateWakeupId))
      .then((rows) => rows[0] ?? null);
    expect(duplicateWakeup?.status).toBe("cancelled");
  });

  it.each(["blocked", "todo", "backlog"] as const)(
    "cancels a due max-turn continuation when the issue moves to %s before retry promotion",
    async (issueStatus) => {
      const { issueId, runId, now } = await seedMaxTurnFixture();

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        retryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeReason: MAX_TURN_CONTINUATION_WAKE_REASON,
        maxAttempts: 2,
        delayMs: 1_000,
      });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      await db.update(issues).set({
        status: issueStatus,
        updatedAt: new Date(now.getTime() + 500),
      }).where(eq(issues.id, issueId));

      const promotion = await heartbeat.promoteDueScheduledRetries(scheduled.dueAt);
      expect(promotion).toEqual({ promoted: 0, runIds: [] });

      const retryRun = await db
        .select({
          status: heartbeatRuns.status,
          errorCode: heartbeatRuns.errorCode,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect(retryRun).toMatchObject({
        status: "cancelled",
        errorCode: "issue_not_in_progress",
      });

      const wakeupRequest = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect(wakeupRequest?.status).toBe("cancelled");

      const issue = await db
        .select({
          executionRunId: issues.executionRunId,
          executionAgentNameKey: issues.executionAgentNameKey,
          executionLockedAt: issues.executionLockedAt,
        })
        .from(issues)
        .where(eq(issues.id, issueId))
        .then((rows) => rows[0] ?? null);
      expect(issue).toEqual({
        executionRunId: null,
        executionAgentNameKey: null,
        executionLockedAt: null,
      });

      const event = await db
        .select({
          message: heartbeatRunEvents.message,
          payload: heartbeatRunEvents.payload,
        })
        .from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, scheduled.run.id))
        .orderBy(sql`${heartbeatRunEvents.seq} desc`)
        .then((rows) => rows[0] ?? null);
      expect(event?.message).toContain("no longer in_progress");
      expect(event?.payload).toMatchObject({
        currentStatus: issueStatus,
        requiredStatus: "in_progress",
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
      });
    },
  );

  it("does not defer a new assignee behind the previous assignee's scheduled retry", async () => {
    const companyId = randomUUID();
    const oldAgentId = randomUUID();
    const newAgentId = randomUUID();
    const issueId = randomUUID();
    const sourceRunId = randomUUID();
    const now = new Date("2026-04-20T13:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values([
      {
        id: oldAgentId,
        companyId,
        name: "ClaudeCoder",
        role: "engineer",
        status: "active",
        adapterType: "claude_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
      {
        id: newAgentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: {
          heartbeat: {
            wakeOnDemand: true,
            maxConcurrentRuns: 1,
          },
        },
        permissions: {},
      },
    ]);

    await db.insert(heartbeatRuns).values({
      id: sourceRunId,
      companyId,
      agentId: oldAgentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "failed",
      error: "upstream overload",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      contextSnapshot: {
        issueId,
        wakeReason: "issue_assigned",
      },
      updatedAt: now,
      createdAt: now,
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Retry reassignment",
      status: "todo",
      priority: "medium",
      responsibleUserId: "responsible-user",
      assigneeAgentId: oldAgentId,
      executionRunId: sourceRunId,
      executionAgentNameKey: "claudecoder",
      executionLockedAt: now,
      issueNumber: 1,
      identifier: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}-1`,
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, {
      now,
      random: () => 0.5,
    });
    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;

    await db.update(issues).set({
      assigneeAgentId: newAgentId,
      updatedAt: now,
    }).where(eq(issues.id, issueId));

    // Keep the new agent's queue from auto-claiming/executing during this unit test.
    await db.insert(heartbeatRuns).values(
      Array.from({ length: 5 }, () => ({
        id: randomUUID(),
        companyId,
        agentId: newAgentId,
        invocationSource: "automation",
        triggerDetail: "system",
        status: "running",
        contextSnapshot: {
          wakeReason: "test_busy_slot",
        },
        startedAt: now,
        updatedAt: now,
        createdAt: now,
      })),
    );

    const newAssigneeRun = await heartbeat.wakeup(newAgentId, {
      source: "assignment",
      triggerDetail: "system",
      reason: "issue_assigned",
      payload: {
        issueId,
        mutation: "update",
      },
      contextSnapshot: {
        issueId,
        source: "issue.update",
      },
      requestedByActorType: "user",
      requestedByActorId: "local-board",
    });

    expect(newAssigneeRun).not.toBeNull();
    expect(newAssigneeRun?.agentId).toBe(newAgentId);
    expect(newAssigneeRun?.status).toBe("queued");

    const oldRetry = await db
      .select({
        status: heartbeatRuns.status,
        errorCode: heartbeatRuns.errorCode,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);
    expect(oldRetry).toEqual({
      status: "cancelled",
      errorCode: "issue_reassigned",
    });

    const deferredWakeups = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.status, "deferred_issue_execution"))
      .then((rows) => rows[0]?.count ?? 0);
    expect(deferredWakeups).toBe(0);

    // The stale-retry cancel runs inside enqueueWakeup's transaction, and
    // the run's own required lifecycle work never awaits the telemetry
    // emission, so wait for it here instead of asserting it fired
    // synchronously.
    await vi.waitFor(() => {
      expect(mockTrackAgentTaskRun).toHaveBeenCalledWith(
        mockTelemetryClient,
        expect.objectContaining({
          agentId: oldAgentId,
          state: "cancelled",
        }),
      );
    });
  });

  it("exhausts bounded retries after the hard cap", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const cappedRunId = randomUUID();
    const now = new Date("2026-04-20T18:00:00.000Z");

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
      defaultResponsibleUserId: "responsible-user",
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "CodexCoder",
      role: "engineer",
      status: "active",
      adapterType: "codex_local",
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: {
          wakeOnDemand: true,
          maxConcurrentRuns: 1,
        },
      },
      permissions: {},
    });

    await db.insert(heartbeatRuns).values({
      id: cappedRunId,
      companyId,
      agentId,
      invocationSource: "automation",
      status: "failed",
      error: "still transient",
      errorCode: "adapter_failed",
      resultJson: { executionRecovery: { kind: "bootstrap", providerWorkStarted: false } },
      finishedAt: now,
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      scheduledRetryReason: "transient_failure",
      contextSnapshot: {
        wakeReason: "transient_failure_retry",
      },
      updatedAt: now,
      createdAt: now,
    });

    const exhausted = await heartbeat.scheduleBoundedRetry(cappedRunId, {
      now,
      random: () => 0.5,
    });

    expect(exhausted).toEqual({
      outcome: "retry_exhausted",
      attempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length + 1,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const runCount = await db
      .select({ count: sql<number>`count(*)::int` })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.companyId, companyId))
      .then((rows) => rows[0]?.count ?? 0);
    expect(runCount).toBe(1);

    const exhaustionEvent = await db
      .select({
        message: heartbeatRunEvents.message,
        payload: heartbeatRunEvents.payload,
      })
      .from(heartbeatRunEvents)
      .where(eq(heartbeatRunEvents.runId, cappedRunId))
      .orderBy(sql`${heartbeatRunEvents.id} desc`)
      .then((rows) => rows[0] ?? null);

    expect(exhaustionEvent?.message).toContain("Bounded retry exhausted");
    expect(exhaustionEvent?.payload).toMatchObject({
      retryReason: "transient_failure",
      scheduledRetryAttempt: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
      maxAttempts: BOUNDED_TRANSIENT_HEARTBEAT_RETRY_DELAYS_MS.length,
    });

    const onLiveEvent = vi.fn();
    const unsubscribe = subscribeCompanyLiveEvents(companyId, onLiveEvent);
    try {
      const restartedHeartbeat = heartbeatService(createDb(tempDb!.connectionString));
      const repeated = await Promise.all(Array.from({ length: 8 }, (_, index) =>
        (index % 2 ? heartbeat : restartedHeartbeat).scheduleBoundedRetry(cappedRunId, {
          now, random: () => 0.5,
        })));
      expect(repeated).toEqual(Array.from({ length: 8 }, () => exhausted));
      expect(await db.select().from(heartbeatRunEvents)
        .where(eq(heartbeatRunEvents.runId, cappedRunId))).toHaveLength(1);
      expect((await heartbeat.getRun(cappedRunId))?.nextEventSeq).toBe(2);
      expect(onLiveEvent).not.toHaveBeenCalled();
    } finally {
      unsubscribe();
    }
  });

  it("advances codex transient fallback stages across bounded retry attempts", async () => {
    const fallbackModes = [
      "same_session",
      "safer_invocation",
    ] as const;

    for (const [index, expectedMode] of fallbackModes.entries()) {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date(`2026-04-20T1${index}:00:00.000Z`);

      await seedRetryFixture({
        runId,
        companyId,
        agentId,
        now,
        errorCode: "adapter_failed",
        errorFamily: "transient_upstream",
        scheduledRetryAttempt: index,
      });

      const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
        now,
        random: () => 0.5,
      });

      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") continue;

      const retryRun = await db
        .select({
          contextSnapshot: heartbeatRuns.contextSnapshot,
          wakeupRequestId: heartbeatRuns.wakeupRequestId,
        })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id))
        .then((rows) => rows[0] ?? null);
      expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      const wakeupRequest = await db
        .select({ payload: agentWakeupRequests.payload })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
        .then((rows) => rows[0] ?? null);
      expect((wakeupRequest?.payload as Record<string, unknown> | null)?.codexTransientFallbackMode).toBe(expectedMode);

      await cleanupRetryFixture();
    await db.update(instanceSettings).set({ defaultEnvironmentId: null });
    await db.update(environments).set({ config: {} }).where(eq(environments.driver, "local"));
    }
  });

  it("requires reconciliation for a classified Codex harness crash", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T12:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: "transient_upstream",
    });

    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });

    await cleanupRetryFixture();
    await db.update(instanceSettings).set({ defaultEnvironmentId: null });
    await db.update(environments).set({ config: {} }).where(eq(environments.driver, "local"));
  });

  it("keeps a permanent provider model rejection on configuration repair instead of retrying", async () => {
    const runId = randomUUID(), companyId = randomUUID(), agentId = randomUUID();
    const now = new Date("2026-10-04T00:00:00Z");
    await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "configuration_incomplete", resultJson: {
      errorFamily: "transient_upstream", executionRecovery: { kind: "bootstrap", providerWorkStarted: false },
      configurationIncomplete: { reason: "provider_model_unsupported", status: 400, code: "invalid_request_error", message: "The model is not supported for this account", retryable: false },
    } });
    try {
      expect(await heartbeat.scheduleBoundedRetry(runId, { now, delayMs: 0 })).toMatchObject({ outcome: "not_scheduled", errorCode: "configuration_incomplete" });
      const rows = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.companyId, companyId));
      expect(rows.map(row => row.id)).toEqual([runId]);
      expect(rows[0]?.resultJson?.configurationIncomplete).toMatchObject({ status: 400, retryable: false });
    } finally { await cleanupRetryFixture(); }
  });

  it("requires reconciliation for an error-code-only Codex harness crash", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date("2026-07-24T13:00:00.000Z");

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "codex_harness_crash",
      errorFamily: null,
    });

    await db.update(heartbeatRuns).set({ resultJson: null }).where(eq(heartbeatRuns.id, runId));

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled).toMatchObject({ outcome: "not_scheduled", errorCode: "legacy_execution_requires_reconciliation" });

    await cleanupRetryFixture();
    await db.update(instanceSettings).set({ defaultEnvironmentId: null });
    await db.update(environments).set({ config: {} }).where(eq(environments.driver, "local"));
  });

  it("honors codex retry-not-before timestamps when they exceed the default bounded backoff", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 22, 29, 0);
    const retryNotBefore = new Date(2026, 3, 22, 23, 31, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    expect((retryRun?.contextSnapshot as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  it("schedules bounded retries for claude_transient_upstream and honors its retry-not-before hint", async () => {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const runId = randomUUID();
    const now = new Date(2026, 3, 22, 10, 0, 0);
    const retryNotBefore = new Date(2026, 3, 22, 16, 0, 0);

    await seedRetryFixture({
      runId,
      companyId,
      agentId,
      now,
      errorCode: "adapter_failed",
      errorFamily: "transient_upstream",
      adapterType: "claude_local",
      retryNotBefore: retryNotBefore.toISOString(),
    });

    const scheduled = await heartbeat.scheduleBoundedRetry(runId, {
      now,
      random: () => 0.5,
    });

    expect(scheduled.outcome).toBe("scheduled");
    if (scheduled.outcome !== "scheduled") return;
    expect(scheduled.dueAt.getTime()).toBe(retryNotBefore.getTime());

    const retryRun = await db
      .select({
        contextSnapshot: heartbeatRuns.contextSnapshot,
        scheduledRetryAt: heartbeatRuns.scheduledRetryAt,
        wakeupRequestId: heartbeatRuns.wakeupRequestId,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, scheduled.run.id))
      .then((rows) => rows[0] ?? null);

    expect(retryRun?.scheduledRetryAt?.getTime()).toBe(retryNotBefore.getTime());
    const contextSnapshot = (retryRun?.contextSnapshot as Record<string, unknown> | null) ?? {};
    expect(contextSnapshot.transientRetryNotBefore).toBe(retryNotBefore.toISOString());
    // Claude does not participate in the Codex fallback-mode ladder.
    expect(contextSnapshot.codexTransientFallbackMode ?? null).toBeNull();

    const wakeupRequest = await db
      .select({ payload: agentWakeupRequests.payload })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, retryRun?.wakeupRequestId ?? ""))
      .then((rows) => rows[0] ?? null);

    expect((wakeupRequest?.payload as Record<string, unknown> | null)?.transientRetryNotBefore).toBe(
      retryNotBefore.toISOString(),
    );
  });

  describe("run-dispatch module transactions", () => {
    it("promotes a due scheduled retry exactly once under concurrent promotion attempts", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-01T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      const [first, second] = await Promise.all([
        heartbeat.promoteDueScheduledRetries(scheduled.dueAt),
        heartbeat.promoteDueScheduledRetries(scheduled.dueAt),
      ]);

      expect(first.promoted + second.promoted).toBe(1);
      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      expect(row?.status).toBe("queued");
    });

    it("rolls back the run-status update when the run-event write fails during promotion", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const now = new Date("2026-05-02T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      const scheduled = await heartbeat.scheduleBoundedRetry(sourceRunId, { now, random: () => 0.5 });
      expect(scheduled.outcome).toBe("scheduled");
      if (scheduled.outcome !== "scheduled") return;

      mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("injected promotion event fault"));

      await expect(heartbeat.promoteDueScheduledRetries(scheduled.dueAt)).rejects.toThrow(
        "injected promotion event fault",
      );

      const [row] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, scheduled.run.id));
      expect(row?.status).toBe("scheduled_retry");
    });

    it("rolls back the wakeup-request update when the run-event write fails during a gate-suppressed cancellation", async () => {
      const companyId = randomUUID();
      const agentId = randomUUID();
      const sourceRunId = randomUUID();
      const cancelledIssueId = randomUUID();
      const now = new Date("2026-05-03T00:00:00.000Z");

      await seedRetryFixture({ runId: sourceRunId, companyId, agentId, now, errorCode: "adapter_failed" });
      await db.insert(issues).values({ id: cancelledIssueId, companyId, title: "Cancelled retry target", status: "cancelled", assigneeAgentId: agentId });

      const wakeupRequestId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: wakeupRequestId,
        companyId,
        agentId,
        source: "retry",
        status: "queued",
      });

      // A cancelled real issue suppresses the continuation and exercises the
      // transactional wakeup cancellation under the resource gate.
      const retryRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: retryRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: now,
        scheduledRetryAttempt: 1,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        wakeupRequestId,
        contextSnapshot: { issueId: cancelledIssueId, wakeReason: "issue_continuation_needed" },
        updatedAt: now,
        createdAt: now,
      });

      mockedAppendHeartbeatRunEvent.mockRejectedValueOnce(new Error("injected cancellation event fault"));

      await expect(heartbeat.promoteDueScheduledRetries(now)).rejects.toThrow(
        "injected cancellation event fault",
      );

      const [run] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, retryRunId));
      expect(run?.status).toBe("scheduled_retry");

      const [wake] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, wakeupRequestId));
      expect(wake?.status).toBe("queued");
    });

    it("keeps promotion and stale-queued-run cancellation company-scoped", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const agentId = randomUUID();
      const runId = randomUUID();
      const now = new Date("2026-05-04T00:00:00.000Z");

      await seedRetryFixture({ runId, companyId, agentId, now, errorCode: "adapter_failed" });
      await db
        .update(heartbeatRuns)
        .set({ status: "scheduled_retry", scheduledRetryAt: now })
        .where(eq(heartbeatRuns.id, runId));

      const wrongCompanyPromotion = await adapter.promoteOrCancelDueRetry({
        runId,
        companyId: otherCompanyId,
        now,
      });
      expect(wrongCompanyPromotion).toEqual({ outcome: "not_promoted" });
      const [afterWrongCompanyPromotion] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, runId));
      expect(afterWrongCompanyPromotion?.status).toBe("scheduled_retry");

      const rightCompanyPromotion = await adapter.promoteOrCancelDueRetry({ runId, companyId, now });
      expect(rightCompanyPromotion.outcome).toBe("promoted");

      const issueId = randomUUID();
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: issueId,
        companyId,
        title: "Stale queued run target",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 2,
        identifier: `${issuePrefix}-2`,
      });
      const queuedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: queuedRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        contextSnapshot: { issueId },
        updatedAt: now,
        createdAt: now,
      });

      await expect(
        adapter.cancelStaleQueuedRun({
          runId: queuedRunId,
          companyId: otherCompanyId,
          expectedStatus: "queued",
          now,
        }),
      ).rejects.toThrow();
      const [afterWrongCompanyCancel] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      expect(afterWrongCompanyCancel?.status).toBe("queued");

      const lostRaceCancel = await adapter.cancelStaleQueuedRun({
        runId: queuedRunId,
        companyId,
        expectedStatus: "running",
        now,
      });
      expect(lostRaceCancel).toEqual({ outcome: "lost_race" });
      const [afterLostRaceCancel] = await db
        .select({ status: heartbeatRuns.status })
        .from(heartbeatRuns)
        .where(eq(heartbeatRuns.id, queuedRunId));
      expect(afterLostRaceCancel?.status).toBe("queued");

      const rightCompanyCancel = await adapter.cancelStaleQueuedRun({
        runId: queuedRunId,
        companyId,
        expectedStatus: "queued",
        now,
      });
      expect(rightCompanyCancel.outcome).toBe("cancelled");
    });

    it("never writes another company's wakeup request during suppressed-retry or stale-queued-run cancellation", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const otherCompanyId = randomUUID();
      const agentId = randomUUID();
      const otherAgentId = randomUUID();
      const now = new Date("2026-05-05T00:00:00.000Z");

      await seedRetryFixture({ runId: randomUUID(), companyId, agentId, now, errorCode: "adapter_failed" });
      await db.insert(companies).values({
        id: otherCompanyId,
        name: "Other Co",
        issuePrefix: `T${otherCompanyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: otherAgentId,
        companyId: otherCompanyId,
        name: "OtherCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Each wakeup request belongs to `otherCompanyId`, standing in for a
      // mismatched cross-company reference on the run — the scenario the
      // company predicate on the wakeup write must guard against.
      const suppressedWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: suppressedWakeupId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        source: "retry",
        status: "queued",
      });
      const suppressedIssueId = randomUUID();
      await db.insert(issues).values({ id: suppressedIssueId, companyId, title: "Suppressed company-scoped retry", status: "cancelled", assigneeAgentId: agentId });
      const suppressedRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: suppressedRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: now,
        wakeupRequestId: suppressedWakeupId,
        scheduledRetryReason: MAX_TURN_CONTINUATION_RETRY_REASON,
        contextSnapshot: { issueId: suppressedIssueId },
        updatedAt: now,
        createdAt: now,
      });

      const suppressedCancel = await adapter.promoteOrCancelDueRetry({
        runId: suppressedRunId,
        companyId,
        now,
      });
      expect(suppressedCancel.outcome).toBe("gate_suppressed");

      const [suppressedWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, suppressedWakeupId));
      expect(suppressedWakeup?.status).toBe("queued");

      const staleWakeupId = randomUUID();
      await db.insert(agentWakeupRequests).values({
        id: staleWakeupId,
        companyId: otherCompanyId,
        agentId: otherAgentId,
        source: "assignment",
        status: "queued",
      });
      const staleIssueId = randomUUID();
      const staleIssuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;
      await db.insert(issues).values({
        id: staleIssueId,
        companyId,
        title: "Stale queued run target",
        status: "cancelled",
        priority: "medium",
        responsibleUserId: "responsible-user",
        issueNumber: 3,
        identifier: `${staleIssuePrefix}-3`,
      });
      const staleRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: staleRunId,
        companyId,
        agentId,
        invocationSource: "assignment",
        status: "queued",
        wakeupRequestId: staleWakeupId,
        contextSnapshot: { issueId: staleIssueId },
        updatedAt: now,
        createdAt: now,
      });

      const staleCancel = await adapter.cancelStaleQueuedRun({
        runId: staleRunId,
        companyId,
        expectedStatus: "queued",
        now,
      });
      expect(staleCancel.outcome).toBe("cancelled");

      const [staleWakeup] = await db
        .select({ status: agentWakeupRequests.status })
        .from(agentWakeupRequests)
        .where(eq(agentWakeupRequests.id, staleWakeupId));
      expect(staleWakeup?.status).toBe("queued");
    });

    it("orders due retries by due time, honors the cutoff, and caps a sweep at 50 runs", async () => {
      const adapter = createPostgresRunDispatchAdapter(db);
      const companyId = randomUUID();
      const agentId = randomUUID();
      const now = new Date("2026-05-05T00:00:00.000Z");
      const issuePrefix = `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`;

      await db.insert(companies).values({
        id: companyId,
        name: "Paperclip",
        issuePrefix,
        requireBoardApprovalForNewAgents: false,
        defaultResponsibleUserId: "responsible-user",
      });
      await db.insert(agents).values({
        id: agentId,
        companyId,
        name: "CodexCoder",
        role: "engineer",
        status: "active",
        adapterType: "codex_local",
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1 } },
        permissions: {},
      });

      // Due, but created well before the cutoff: the cutoff must exclude it
      // even though it is the single most-overdue run in the table.
      const beforeCutoffRunId = randomUUID();
      await db.insert(heartbeatRuns).values({
        id: beforeCutoffRunId,
        companyId,
        agentId,
        invocationSource: "retry",
        status: "scheduled_retry",
        scheduledRetryAt: new Date(now.getTime() - 1_000),
        contextSnapshot: {},
        createdAt: new Date(now.getTime() - 1_000_000),
        updatedAt: now,
      });

      // 52 due, in-cutoff runs, strictly ordered by scheduledRetryAt/createdAt.
      const dueRunIds = Array.from({ length: 52 }, () => randomUUID());
      for (let i = 0; i < dueRunIds.length; i += 1) {
        const dueAt = new Date(now.getTime() - (dueRunIds.length - i) * 1_000);
        await db.insert(heartbeatRuns).values({
          id: dueRunIds[i],
          companyId,
          agentId,
          invocationSource: "retry",
          status: "scheduled_retry",
          scheduledRetryAt: dueAt,
          contextSnapshot: {},
          createdAt: dueAt,
          updatedAt: now,
        });
      }

      const cutoff = new Date(now.getTime() - 500_000);
      const result = await adapter.listDueRetries({ now, cutoff, limit: 50 });

      expect(result).toHaveLength(50);
      expect(result.map((r) => r.runId)).toEqual(dueRunIds.slice(0, 50));
      const resultIds = new Set(result.map((r) => r.runId));
      expect(resultIds.has(beforeCutoffRunId)).toBe(false);
      expect(resultIds.has(dueRunIds[50])).toBe(false);
      expect(resultIds.has(dueRunIds[51])).toBe(false);
    });
  });
});
