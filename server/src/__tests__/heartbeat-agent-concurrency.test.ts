import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb, environmentLeases, heartbeatRunEvents, heartbeatRuns, issues, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { registerServerAdapter, unregisterServerAdapter } from "../adapters/index.ts";
import { heartbeatService, persistHeartbeatRunProcessMetadata } from "../services/heartbeat.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";
import { admitQueuedRunCapacity } from "../services/run-capacity.ts";
import { legacyControllerBootId } from "../services/legacy-controller-lease.ts";
import { recordLegacyLocalProcessStop } from "../services/legacy-process-capacity.ts";

const support = await getEmbeddedPostgresTestSupport();
const describePostgres = support.supported ? describe : describe.skip;
const ADAPTER = "agent_capacity_test";

describePostgres("shared Agent run capacity", () => {
  let database!: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let heartbeat!: ReturnType<typeof heartbeatService>;
  const dispatched: string[] = [];
  const releases = new Map<string, () => void>();
  let blockAdapter = false;
  let stopAwareAdapter = false;
  let secondHeartbeat: ReturnType<typeof heartbeatService> | null = null;

  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-agent-capacity-");
    database = createDb(temporary.connectionString);
    heartbeat = heartbeatService(database);
    registerServerAdapter({
      type: ADAPTER,
      execute: async (context) => {
        if (stopAwareAdapter) await context.onCancellationReady?.();
        dispatched.push(context.runId);
        if (stopAwareAdapter) {
          await new Promise<void>(resolve => {
            if (context.signal?.aborted) resolve();
            else context.signal?.addEventListener("abort", () => resolve(), { once: true });
            releases.set(context.runId, resolve);
          });
        }
        if (blockAdapter) {
          await new Promise<void>((resolve) => releases.set(context.runId, resolve));
        }
        return { exitCode: 0, signal: null, timedOut: false, resultJson: {} };
      },
      testEnvironment: async () => ({
        adapterType: ADAPTER,
        status: "pass",
        checks: [],
        testedAt: new Date().toISOString(),
      }),
    });
  }, 20_000);

  afterEach(async () => {
    blockAdapter = false;
    stopAwareAdapter = false;
    for (const release of releases.values()) release();
    releases.clear();
    await heartbeat.drainActiveRunExecutions();
    await secondHeartbeat?.drainActiveRunExecutions();
    secondHeartbeat = null;
    await database.transaction(async (transaction) => {
      await transaction.execute(sql.raw("SET LOCAL client_min_messages = warning"));
      await transaction.execute(sql.raw('TRUNCATE TABLE "activity_log", "heartbeat_run_events", "heartbeat_runs", "agent_wakeup_requests", "agent_runtime_state", "agents", "companies" RESTART IDENTITY CASCADE'));
    });
    await instanceSettingsService(database).updateGeneral({ agentConcurrency: { maxActiveRuns: null, groups: [] } });
    dispatched.length = 0;
  });

  afterAll(async () => {
    unregisterServerAdapter(ADAPTER);
    await temporary?.cleanup();
  });

  it("shared pool gives an unserved company Agent the next locked admission", async () => {
    const a = randomUUID(), b = randomUUID(), agentA = randomUUID(), agentB = randomUUID(), nextA = randomUUID(), nextB = randomUUID();
    await database.insert(companies).values([{ id: a, name: "A", issuePrefix: "FA", defaultResponsibleUserId: "board" }, { id: b, name: "B", issuePrefix: "FB", defaultResponsibleUserId: "board" }]);
    await database.insert(agents).values([{ id: agentA, companyId: a, name: "Busy", role: "engineer", status: "idle", adapterType: ADAPTER, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 6, concurrencyGroup: "shared" } } }, { id: agentB, companyId: b, name: "Waiting", role: "engineer", status: "idle", adapterType: ADAPTER, runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 6, concurrencyGroup: "shared" } } }]);
    await instanceSettingsService(database).updateGeneral({ agentConcurrency: { maxActiveRuns: null, groups: [{ name: "shared", maxActiveRuns: 1 }] } });
    await database.insert(heartbeatRuns).values([{ companyId: a, agentId: agentA, invocationSource: "on_demand", status: "succeeded", startedAt: new Date(), finishedAt: new Date(), capacityGroup: "shared", capacityReleasedAt: new Date() }, { id: nextA, companyId: a, agentId: agentA, invocationSource: "on_demand", status: "queued", createdAt: new Date(Date.now() - 20_000) }, { id: nextB, companyId: b, agentId: agentB, invocationSource: "on_demand", status: "queued", createdAt: new Date(Date.now() - 10_000) }]);
    const [busy] = await database.select().from(agents).where(eq(agents.id, agentA));
    const blocked = await database.transaction(tx => admitQueuedRunCapacity(tx as unknown as Db, busy!, nextA, 6));
    expect(blocked).toMatchObject({ allowed: false });
    const [queued] = await database.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, nextA));
    expect(queued?.status).toBe("queued");
    const [waiting] = await database.select().from(agents).where(eq(agents.id, agentB));
    expect(await database.transaction(tx => admitQueuedRunCapacity(tx as unknown as Db, waiting!, nextB, 6))).toMatchObject({ allowed: true });
  });

  async function seed(groupForHolder: string, groupForCandidate: string) {
    const companyId = randomUUID();
    const holderId = randomUUID();
    const candidateId = randomUUID();
    await database.insert(companies).values({
      id: companyId,
      name: "Capacity test",
      issuePrefix: `C${companyId.replaceAll("-", "").slice(0, 6).toUpperCase()}`,
      defaultResponsibleUserId: "board",
    });
    await database.insert(agents).values([
      {
        id: holderId,
        companyId,
        name: "Holder",
        role: "engineer",
        status: "running",
        adapterType: ADAPTER,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, concurrencyGroup: groupForHolder } },
        permissions: {},
      },
      {
        id: candidateId,
        companyId,
        name: "Candidate",
        role: "engineer",
        status: "idle",
        adapterType: ADAPTER,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, concurrencyGroup: groupForCandidate } },
        permissions: {},
      },
    ]);
    const holderRunId = randomUUID();
    await database.insert(heartbeatRuns).values({
      id: holderRunId,
      companyId,
      agentId: holderId,
      invocationSource: "on_demand",
      triggerDetail: "manual",
      status: "running",
      startedAt: new Date(),
      contextSnapshot: {},
    });
    return { companyId, holderRunId, holderId, candidateId };
  }

  async function waitForTerminal(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await heartbeat.getRun(runId);
      if (row && row.status !== "queued" && row.status !== "running") return row;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return await heartbeat.getRun(runId);
  }

  it("counts a primary recovery probe against the provider concurrency limit", async () => {
    await instanceSettingsService(database).updateGeneral({ agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 2 }] } });
    const { companyId, holderId, candidateId } = await seed("minimax", "minimax");
    await database.update(agents).set({ metadata: { quotaFallbackState: { version: 1, fingerprint: "lease", scopes: {
      board: { probeToken: randomUUID(), probeGroup: "minimax", probeUntil: new Date(Date.now() + 60_000).toISOString() },
    } } } }).where(eq(agents.id, holderId));
    const runId = randomUUID();
    await database.insert(heartbeatRuns).values({ id: runId, companyId, agentId: candidateId, invocationSource: "on_demand", status: "queued", contextSnapshot: {} });
    const [candidate] = await database.select().from(agents).where(eq(agents.id, candidateId));
    const result = await database.transaction(tx => admitQueuedRunCapacity(tx as unknown as Db, candidate!, runId, 1));
    expect(result).toEqual({ allowed: false, reason: 'Waiting for concurrency group "minimax" (2/2)' });
    expect(dispatched).toEqual([]);
  });

  async function waitForCapacityRelease(runId: string) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const row = await heartbeat.getRun(runId);
      if (row?.capacityReleasedAt) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Capacity release for ${runId} was not recorded`);
  }

  async function waitForDispatchCount(count: number) {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (dispatched.length >= count) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new Error(`Only ${dispatched.length} of ${count} expected runs dispatched`);
  }

  it("keeps the next MiniMax Agent queued until the shared slot releases", async () => {
    const { holderRunId, candidateId } = await seed("minimax", "minimax");
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });

    const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(candidate).not.toBeNull();
    const waiting = await heartbeat.getRun(candidate!.id);
    expect(waiting?.status).toBe("queued");
    expect(heartbeat.decorateActiveRunStatus(waiting!).currentStatusMessage)
      .toContain('concurrency group "minimax"');
    const summary = {
      id: waiting!.id,
      companyId: waiting!.companyId,
      agentId: waiting!.agentId,
      status: waiting!.status,
      executionStage: waiting!.executionStage,
      capacityWaitReason: (waiting!.resultJson as { capacityWait?: { reason?: string } })?.capacityWait?.reason,
    };
    expect(heartbeat.decorateActiveRunStatus(summary).currentStatusMessage)
      .toContain('concurrency group "minimax"');
    expect(dispatched).not.toContain(candidate!.id);

    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
    await heartbeat.resumeQueuedRuns();
    expect((await waitForTerminal(candidate!.id))?.status).toBe("succeeded");
    expect(dispatched).toContain(candidate!.id);
  }, 30_000);

  it("holds a seventh MiniMax Agent at the configured limit of six", async () => {
    const { companyId, holderRunId, candidateId } = await seed("minimax", "minimax");
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 6 }] },
    });
    for (let index = 0; index < 5; index += 1) {
      const agentId = randomUUID();
      await database.insert(agents).values({
        id: agentId,
        companyId,
        name: `MiniMax holder ${index}`,
        role: "engineer",
        status: "running",
        adapterType: ADAPTER,
        adapterConfig: {},
        runtimeConfig: { heartbeat: { concurrencyGroup: "minimax", maxConcurrentRuns: 1 } },
        permissions: {},
      });
      await database.insert(heartbeatRuns).values({
        id: randomUUID(),
        companyId,
        agentId,
        invocationSource: "on_demand",
        triggerDetail: "manual",
        status: "running",
        startedAt: new Date(),
        contextSnapshot: {},
      });
    }

    const seventh = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(seventh).not.toBeNull();
    expect((await heartbeat.getRun(seventh!.id))?.status).toBe("queued");
    expect(dispatched).not.toContain(seventh!.id);
    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
    await heartbeat.resumeQueuedRuns();
    expect((await waitForTerminal(seventh!.id))?.status).toBe("succeeded");
  }, 30_000);

  it("applies the instance ceiling across different groups", async () => {
    const { candidateId } = await seed("openai", "minimax");
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: 1, groups: [
        { name: "openai", maxActiveRuns: 6 },
        { name: "minimax", maxActiveRuns: 6 },
      ] },
    });

    const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(candidate).not.toBeNull();
    expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
    expect(dispatched).not.toContain(candidate!.id);
  }, 30_000);

  it("serializes simultaneous claims from separate controllers", async () => {
    const { holderRunId, holderId, candidateId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
    await database.update(agents).set({ status: "idle" }).where(eq(agents.id, holderId));
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });
    blockAdapter = true;
    secondHeartbeat = heartbeatService(database);

    const [first, second] = await Promise.all([
      heartbeat.invoke(holderId, "on_demand", {}, "manual"),
      secondHeartbeat.invoke(candidateId, "on_demand", {}, "manual"),
    ]);
    expect(first).not.toBeNull();
    expect(second).not.toBeNull();
    await waitForDispatchCount(1);
    expect(dispatched).toHaveLength(1);
    const statuses = [
      (await heartbeat.getRun(first!.id))?.status,
      (await heartbeat.getRun(second!.id))?.status,
    ].sort();
    expect(statuses).toEqual(["queued", "running"]);
    const active = await heartbeat.getRun(dispatched[0]!);
    expect(active?.capacityGroup).toBe("minimax");
    await database.update(agents).set({
      runtimeConfig: { heartbeat: { wakeOnDemand: true, maxConcurrentRuns: 1, concurrencyGroup: "openai" } },
    }).where(eq(agents.id, active!.agentId));
    await heartbeat.resumeQueuedRuns();
    expect(dispatched).toHaveLength(1);

    releases.get(dispatched[0]!)?.();
    await waitForTerminal(dispatched[0]!);
    await waitForCapacityRelease(dispatched[0]!);
    await heartbeat.resumeQueuedRuns();
    await waitForDispatchCount(2);
    releases.get(dispatched[1]!)?.();
    await waitForTerminal(dispatched[1]!);
  }, 30_000);

  it("rechecks the same Agent's run limit inside concurrent claim transactions", async () => {
    const { holderRunId, candidateId, companyId } = await seed("openai", "minimax");
    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 6 }] },
    });
    const runIds = [randomUUID(), randomUUID()];
    for (const id of runIds) {
      await database.insert(heartbeatRuns).values({
        id, companyId, agentId: candidateId, invocationSource: "on_demand",
        triggerDetail: "manual", status: "queued", contextSnapshot: {},
      });
    }
    const [agent] = await database.select().from(agents).where(eq(agents.id, candidateId));
    expect(agent).toBeDefined();
    const admissions = await Promise.all(runIds.map((id) => database.transaction(async (transaction) => {
      const result = await admitQueuedRunCapacity(transaction as unknown as Db, agent!, id, 1);
      if (result.allowed) {
        await transaction.update(heartbeatRuns).set({ status: "running", capacityGroup: result.group ?? "" })
          .where(eq(heartbeatRuns.id, id));
      }
      return result;
    })));
    expect(admissions.filter((result) => result.allowed)).toHaveLength(1);
    const persisted = await database.select().from(heartbeatRuns).where(eq(heartbeatRuns.agentId, candidateId));
    expect(persisted.map((run) => run.status).sort()).toEqual(["queued", "running"]);
  }, 30_000);

  it("keeps a slot occupied after cancellation until the adapter has stopped", async () => {
    const { holderRunId, holderId, candidateId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
    await database.update(agents).set({ status: "idle" }).where(eq(agents.id, holderId));
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });
    blockAdapter = true;
    const first = await heartbeat.invoke(holderId, "on_demand", {}, "manual");
    expect(first).not.toBeNull();
    await waitForDispatchCount(1);
    // Models the existing pause path's order: status changes before the
    // process finishes its grace period.
    await database.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() }).where(eq(heartbeatRuns.id, first!.id));

    const second = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(second).not.toBeNull();
    expect((await heartbeat.getRun(second!.id))?.status).toBe("queued");
    expect(dispatched).toHaveLength(1);

    releases.get(first!.id)?.();
    await heartbeat.drainActiveRunExecutions();
    await waitForCapacityRelease(first!.id);
    await heartbeat.resumeQueuedRuns();
    await waitForDispatchCount(2);
    releases.get(second!.id)?.();
    await waitForTerminal(second!.id);
  }, 30_000);

  it("reclaims a completed run's slot after a missed release on this controller", async () => {
    const { holderRunId, candidateId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({
      status: "succeeded",
      finishedAt: new Date(),
      capacityGroup: "minimax",
      capacityReleasedAt: null,
      controllerBootId: legacyControllerBootId,
    }).where(eq(heartbeatRuns.id, holderRunId));
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });
    const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(candidate).not.toBeNull();
    expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");

    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).not.toBeNull();
    expect((await waitForTerminal(candidate!.id))?.status).toBe("succeeded");
  }, 30_000);

  it("keeps a foreign controller's terminal run reserved without stop proof", async () => {
    const { holderRunId, candidateId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({
      status: "succeeded",
      finishedAt: new Date(),
      capacityGroup: "minimax",
      capacityReleasedAt: null,
      controllerBootId: randomUUID(),
      // A remote PID can collide with this host's PID; it is not stop proof.
      processPid: process.pid,
    }).where(eq(heartbeatRuns.id, holderRunId));
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });

    const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(candidate).not.toBeNull();
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
    expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
  }, 30_000);

  it.each(["succeeded", "failed", "cancelled", "interrupted"])("releases a former controller's stopped %s run and dispatches the queue once", async (status) => {
    const { holderRunId, holderId, candidateId } = await seed("minimax", "minimax");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await database.update(heartbeatRuns).set({
        controllerBootId: randomUUID(),
        capacityGroup: "minimax",
      }).where(eq(heartbeatRuns.id, holderRunId));
      await persistHeartbeatRunProcessMetadata(database, holderRunId, {
        pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString(),
      });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      // Simulate the next service boot after shutdown lost the executor's finally.
      await database.update(heartbeatRuns).set({
        status, finishedAt: new Date(),
        controllerLeaseExpiresAt: new Date(Date.now() - 60_000),
      }).where(eq(heartbeatRuns.id, holderRunId));
      await database.update(agents).set({ status: "idle" }).where(eq(agents.id, holderId));
      await instanceSettingsService(database).updateGeneral({
        agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
      });
      const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
      expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).not.toBeNull();
      expect((await waitForTerminal(candidate!.id))?.status).toBe("succeeded");
      await heartbeat.resumeQueuedRuns();
      expect(dispatched.filter(id => id === candidate!.id)).toHaveLength(1);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("refuses local PID recovery for another host namespace", async () => {
    const { holderRunId, candidateId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({
      controllerBootId: randomUUID(), capacityGroup: "minimax",
      controllerLeaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(heartbeatRuns.id, holderRunId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await persistHeartbeatRunProcessMetadata(database, holderRunId, {
        pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString(),
      });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await database.update(heartbeatRunEvents).set({ payload: sql`jsonb_set(payload, '{localNamespace}', '"another-host"'::jsonb)` })
        .where(eq(heartbeatRunEvents.runId, holderRunId));
      await database.update(heartbeatRuns).set({ status: "failed", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      await instanceSettingsService(database).updateGeneral({
        agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
      });
      const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
      expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("invalidates a stop receipt when the same run records a later process", async () => {
    const { holderRunId, candidateId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({
      controllerBootId: legacyControllerBootId, capacityGroup: "minimax",
      status: "interrupted", finishedAt: new Date(),
    }).where(eq(heartbeatRuns.id, holderRunId));
    expect(await recordLegacyLocalProcessStop(database, (await heartbeat.getRun(holderRunId))!)).toBe(true);
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await persistHeartbeatRunProcessMetadata(database, holderRunId, {
        pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString(),
      });
      await instanceSettingsService(database).updateGeneral({
        agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
      });
      const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
      expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
    } finally {
      const exited = once(child, "exit");
      child.kill();
      await exited;
    }
  }, 30_000);

  it("does not stamp local stop authority onto a remote environment's process IDs", async () => {
    const { companyId, holderRunId, candidateId } = await seed("minimax", "minimax");
    await database.insert(environmentLeases).values({
      companyId, heartbeatRunId: holderRunId, provider: "daytona", status: "active",
    });
    await database.update(heartbeatRuns).set({
      controllerBootId: randomUUID(), capacityGroup: "minimax",
      controllerLeaseExpiresAt: new Date(Date.now() - 60_000),
    }).where(eq(heartbeatRuns.id, holderRunId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await persistHeartbeatRunProcessMetadata(database, holderRunId, {
        pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString(),
      });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await database.update(heartbeatRuns).set({ status: "interrupted", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      await instanceSettingsService(database).updateGeneral({
        agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
      });
      const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
      expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("stops an opted-in adapter on graceful shutdown and releases its reservation", async () => {
    const { holderRunId, holderId } = await seed("minimax", "minimax");
    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() })
      .where(eq(heartbeatRuns.id, holderRunId));
    await database.update(agents).set({ status: "idle" }).where(eq(agents.id, holderId));
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });
    stopAwareAdapter = true;
    const run = await heartbeat.invoke(holderId, "on_demand", {}, "manual");
    await waitForDispatchCount(1);
    await heartbeat.drainRunningRunsForShutdown("SIGTERM");
    await waitForCapacityRelease(run!.id);
    expect((await heartbeat.getRun(run!.id))?.status).toBe("interrupted");
  }, 30_000);

  it("does not issue local stop proof for a remote SSH PID without an environment lease", async () => {
    const { holderRunId } = await seed("", "");
    await database.update(heartbeatRuns).set({ controllerBootId: legacyControllerBootId })
      .where(eq(heartbeatRuns.id, holderRunId));
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await persistHeartbeatRunProcessMetadata(database, holderRunId, {
        pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString(), localProcess: false,
      });
      const exited = once(child, "exit");
      child.kill();
      await exited;
      expect(await recordLegacyLocalProcessStop(database, (await heartbeat.getRun(holderRunId))!)).toBe(false);
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("retains a same-host former controller's slot until its real process group exits", async () => {
    const { holderRunId, candidateId } = await seed("minimax", "minimax");
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { detached: true, stdio: "ignore" });
    await once(child, "spawn");
    try {
      await database.update(heartbeatRuns).set({
        controllerBootId: randomUUID(), capacityGroup: "minimax",
        controllerLeaseExpiresAt: new Date(Date.now() - 60_000),
      }).where(eq(heartbeatRuns.id, holderRunId));
      await persistHeartbeatRunProcessMetadata(database, holderRunId, {
        pid: child.pid!, processGroupId: child.pid!, startedAt: new Date().toISOString(),
      });
      await database.update(heartbeatRuns).set({ status: "cancelled", finishedAt: new Date() })
        .where(eq(heartbeatRuns.id, holderRunId));
      await instanceSettingsService(database).updateGeneral({
        agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
      });
      const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
      expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
      const exited = once(child, "exit");
      child.kill();
      await exited;
      await heartbeat.resumeQueuedRuns();
      expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).not.toBeNull();
      expect((await waitForTerminal(candidate!.id))?.status).toBe("succeeded");
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  }, 30_000);

  it("keeps a native retryable failure reserved for same-run recovery", async () => {
    const { companyId, holderRunId, candidateId } = await seed("minimax", "minimax");
    const issueId = randomUUID();
    await database.insert(issues).values({ id: issueId, companyId, title: "Native retry capacity" });
    await database.update(heartbeatRuns).set({
      status: "failed",
      finishedAt: new Date(),
      runtimeMode: "native",
      nativeIssueId: issueId,
      capacityGroup: "minimax",
      capacityReleasedAt: null,
      resultJson: { executionRecovery: { providerWorkStarted: false } },
    }).where(eq(heartbeatRuns.id, holderRunId));
    await database.insert(nativeRunFinalizations).values({
      runId: holderRunId,
      companyId,
      issueId,
      phase: "retryable_failure",
      attempt: 1,
      nextAttemptAt: new Date(Date.now() + 60_000),
    });
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 1 }] },
    });

    const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(candidate).not.toBeNull();
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
    expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
    expect(dispatched).not.toContain(candidate!.id);

    await database.update(nativeRunFinalizations).set({ phase: "observed" })
      .where(eq(nativeRunFinalizations.runId, holderRunId));
    await heartbeat.resumeQueuedRuns();
    expect((await heartbeat.getRun(holderRunId))?.capacityReleasedAt).toBeNull();
    expect((await heartbeat.getRun(candidate!.id))?.status).toBe("queued");
  }, 30_000);

  it("keeps an Agent with an unconfigured group queued", async () => {
    const { holderRunId, candidateId } = await seed("", "minimax");
    await database.update(heartbeatRuns).set({ status: "succeeded", finishedAt: new Date() }).where(eq(heartbeatRuns.id, holderRunId));
    const candidate = await heartbeat.invoke(candidateId, "on_demand", {}, "manual");
    expect(candidate).not.toBeNull();
    const persisted = await heartbeat.getRun(candidate!.id);
    expect(persisted?.status).toBe("queued");
    expect(persisted?.executionStage).toBe("waiting_capacity");
    expect(dispatched).not.toContain(candidate!.id);
    await instanceSettingsService(database).updateGeneral({
      agentConcurrency: { maxActiveRuns: null, groups: [{ name: "minimax", maxActiveRuns: 6 }] },
    });
    await heartbeat.resumeQueuedRuns();
    expect((await waitForTerminal(candidate!.id))?.status).toBe("succeeded");
  }, 30_000);
});
