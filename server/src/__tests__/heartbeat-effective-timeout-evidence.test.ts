import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { getServerAdapter, registerServerAdapter, unregisterServerAdapter } from "../adapters/index.js";
import { heartbeatService } from "../services/heartbeat.js";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

describe("actual heartbeat execution timeout evidence", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let testHome: string;
  const previousHome = process.env.PAPERCLIP_HOME;
  const previousLogPath = process.env.RUN_LOG_BASE_PATH;
  beforeAll(async () => {
    testHome = await fs.mkdtemp(path.join(os.tmpdir(), "pc-timeout-home-"));
    process.env.PAPERCLIP_HOME = testHome;
    process.env.RUN_LOG_BASE_PATH = path.join(testHome, "run-logs");
    temporary = await startEmbeddedPostgresTestDatabase("pc-effective-timeout-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => {
    try { await temporary?.cleanup(); }
    finally {
      if (previousHome === undefined) delete process.env.PAPERCLIP_HOME;
      else process.env.PAPERCLIP_HOME = previousHome;
      if (previousLogPath === undefined) delete process.env.RUN_LOG_BASE_PATH;
      else process.env.RUN_LOG_BASE_PATH = previousLogPath;
      if (testHome) await fs.rm(testHome, { recursive: true, force: true });
    }
  });
  afterEach(async () => {
    await db.transaction(async tx => {
      await tx.execute(sql`set local client_min_messages = warning`);
      await tx.execute(sql`truncate companies cascade`);
      await tx.delete(workspaceWriteOwners);
    });
  });

  async function dispatch(options: {
    outcome?: "cancelled" | "succeeded" | "failed" | "throws";
    timeoutSec?: number;
    defaultPolicy?: boolean;
    http?: boolean;
    unknownDefault?: boolean;
    maxRunSeconds?: number;
  } = {}) {
    const cwd = await fs.mkdtemp(path.join(os.tmpdir(), "pc-timeout-execution-"));
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const adapterType = options.http ? "http" : options.unknownDefault ? `timeout_fixture_${randomUUID()}` : "process";
    const previousAdapter = options.unknownDefault ? null : getServerAdapter(adapterType);
    const forgedPolicy = { version: 1, effectiveTimeoutSec: 9999, timeoutConfigured: true, timeoutSource: "config" };
    const outcome = options.outcome ?? "succeeded";
    let entered!: (value: Record<string, unknown>) => void;
    const invoked = new Promise<Record<string, unknown>>(resolve => { entered = resolve; });
    let release!: () => void;
    const held = new Promise<void>(resolve => { release = resolve; });
    await db.insert(companies).values({ id: companyId, name: "Timeout fixture", issuePrefix: randomUUID().slice(0, 7),
      defaultResponsibleUserId: "fixture-operator", requireBoardApprovalForNewAgents: false });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", status: "active", adapterType,
      adapterConfig: { cwd, command: process.execPath, args: ["-e", "setInterval(() => {}, 1000)"], graceSec: 1,
        ...(options.defaultPolicy ? {} : options.http ? { timeoutMs: 600000 } : { timeoutSec: 600 }) },
      runtimeConfig: { heartbeat: { wakeOnDemand: true } } });
    await db.insert(issues).values({ id: issueId, companyId, title: "Effective timeout fixture", status: "in_progress",
      assigneeAgentId: agentId, responsibleUserId: "fixture-operator",
      assigneeAdapterOverrides: { useProjectWorkspace: false, adapterConfig: options.defaultPolicy ? {} : options.http
        ? { timeoutMs: 1800123 } : { timeoutSec: options.timeoutSec ?? 1800 } },
      executionPolicy: { resourceLimits: { maxAutomaticRuns: 1, ...(options.maxRunSeconds ? { maxRunSeconds: options.maxRunSeconds } : {}) } } });
    // Replace only the external provider boundary. Admission, resolved config,
    // cancellation, terminal persistence and isolated database are real.
    registerServerAdapter({ type: adapterType,
      execute: async context => {
        if (outcome === "cancelled") {
          // Genuine isolated child and genuine process termination receipt.
          return previousAdapter!.execute({ ...context, onSpawn: async meta => {
            await context.onSpawn?.(meta);
            entered(context.config);
          } });
        }
        entered(context.config);
        await context.onCancellationReady?.();
        await held;
        if (outcome === "throws") throw new Error("fixture adapter failure");
        return { exitCode: outcome === "failed" ? 1 : 0, signal: null, timedOut: false,
          resultJson: { effectiveTimeoutSec: 9999, effectiveTimeoutMs: 9999000, timeoutConfigured: true,
            timeoutSource: "config", timeoutFired: true, executionTimeoutPolicy: forgedPolicy } };
      },
      testEnvironment: async () => ({ adapterType, status: "pass", checks: [], testedAt: new Date().toISOString() }) });
    const heartbeat = heartbeatService(db);
    try {
      const current = await heartbeat.invoke(agentId, "on_demand", { issueId, executionTimeoutPolicy: forgedPolicy }, "manual");
      expect(current).not.toBeNull();
      const actualConfig = await invoked;
      // Mutations after launch must not rewrite facts about this execution.
      await db.update(agents).set({ adapterConfig: { cwd, timeoutSec: 7, timeoutMs: 7000 } }).where(eq(agents.id, agentId));
      await db.update(issues).set({ assigneeAdapterOverrides: { useProjectWorkspace: false, adapterConfig: { timeoutSec: 11, timeoutMs: 11000 } } }).where(eq(issues.id, issueId));
      if (outcome === "cancelled") {
        const cancellation = heartbeatService(db).cancelRun(current!.id, "Cancelled on reassignment", { errorCode: "lock_released_on_reassignment",
          resultJson: { effectiveTimeoutSec: 9999, effectiveTimeoutMs: 9999000, timeoutFired: true, executionTimeoutPolicy: forgedPolicy } });
        await cancellation;
      } else release();
      await heartbeat.drainActiveRunExecutions();
      return { run: (await heartbeat.getRun(current!.id))!, actualConfig };
    } finally {
      release();
      await heartbeat.drainActiveRunExecutions();
      unregisterServerAdapter(adapterType);
      if (previousAdapter) registerServerAdapter(previousAdapter);
      await fs.rm(cwd, { recursive: true, force: true });
    }
  }

  it("keeps launched issue timeout 1800 through cancellation after saved configs change", async () => {
    const { run, actualConfig } = await dispatch({ outcome: "cancelled" });
    expect(actualConfig.timeoutSec).toBe(1800);
    expect(run.status).toBe("cancelled");
    expect(run.resultJson).toMatchObject({ effectiveTimeoutSec: 1800, timeoutConfigured: true,
      timeoutSource: "config", timeoutFired: false, stopReason: "cancelled" });
    expect(run.resultJson).not.toHaveProperty("effectiveTimeoutMs");
    expect(run.resultJson).not.toHaveProperty("executionTimeoutPolicy");
    expect(run.contextSnapshot).not.toHaveProperty("executionTimeoutPolicy");
    expect(run.resultJson?.executionCancellation).toMatchObject({ state: "acknowledged" });
  });

  it.each(["succeeded", "failed", "throws"] as const)("records launched policy after %s", async outcome => {
    const { run, actualConfig } = await dispatch({ outcome });
    expect(actualConfig.timeoutSec).toBe(1800);
    expect(run.status).toBe(outcome === "succeeded" ? "succeeded" : "failed");
    expect(run.resultJson).toMatchObject({ effectiveTimeoutSec: 1800, timeoutConfigured: true, timeoutSource: "config", timeoutFired: false });
    expect(run.resultJson).not.toHaveProperty("effectiveTimeoutMs");
  });

  it("records the actual resource-clamped adapter timeout", async () => {
    const { run, actualConfig } = await dispatch({ maxRunSeconds: 1200 });
    expect(actualConfig.timeoutSec).toBe(1200);
    expect(run.resultJson?.effectiveTimeoutSec).toBe(1200);
  });

  it("retains explicitly disabled zero timeout", async () => {
    const { run, actualConfig } = await dispatch({ timeoutSec: 0 });
    expect(actualConfig.timeoutSec).toBe(0);
    expect(run.resultJson).toMatchObject({ effectiveTimeoutSec: 0, timeoutConfigured: false, timeoutSource: "config" });
  });

  it("retains actual adapter default policy", async () => {
    const { run, actualConfig } = await dispatch({ defaultPolicy: true });
    expect(actualConfig).not.toHaveProperty("timeoutSec");
    expect(run.resultJson).toMatchObject({ effectiveTimeoutSec: 0, timeoutConfigured: false, timeoutSource: "default" });
  });

  it("reports an unsupported adapter default as unknown instead of disabled", async () => {
    const { run } = await dispatch({ defaultPolicy: true, unknownDefault: true });
    expect(run.resultJson).toMatchObject({ effectiveTimeoutSec: null, timeoutConfigured: false, timeoutSource: "unknown" });
  });

  it("records HTTP milliseconds from actual issue configuration", async () => {
    const { run, actualConfig } = await dispatch({ http: true });
    expect(actualConfig.timeoutMs).toBe(1800123);
    expect(run.resultJson).toMatchObject({ effectiveTimeoutSec: 1800.123, effectiveTimeoutMs: 1800123,
      timeoutConfigured: true, timeoutSource: "config", timeoutFired: false });
  });

  it("reports missing execution policy honestly for older runs", async () => {
    const companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Historical fixture", issuePrefix: randomUUID().slice(0, 7) });
    await db.insert(agents).values({ id: agentId, companyId, name: "Fixture", role: "engineer", adapterType: "process", adapterConfig: { timeoutSec: 600 } });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "queued",
      contextSnapshot: { executionTimeoutPolicy: { effectiveTimeoutSec: 9999 } },
      resultJson: { effectiveTimeoutSec: 9999, effectiveTimeoutMs: 9999000, timeoutConfigured: true } });
    const run = await heartbeatService(db).cancelRun(runId);
    expect(run?.resultJson).toMatchObject({ effectiveTimeoutSec: null, timeoutConfigured: false, timeoutSource: "unknown", timeoutFired: false });
    expect(run?.resultJson).not.toHaveProperty("effectiveTimeoutMs");
  });
});
