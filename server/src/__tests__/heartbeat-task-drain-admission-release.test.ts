import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createServer, type Server } from "node:http";
import { and, eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import {
  activityLog,
  agents,
  agentRuntimeState,
  agentWakeupRequests,
  companies,
  companySkills,
  createDb,
  heartbeatRunEvents,
  heartbeatRuns,
  issues,
  nativeRunFinalizations,
  projects,
} from "@paperclipai/db";
import {
  getEmbeddedPostgresTestSupport,
  startEmbeddedPostgresTestDatabase,
} from "./helpers/embedded-postgres.js";
import { heartbeatService, getTaskDrainStatus, startTaskDrain, stopTaskDrain } from "../services/heartbeat.ts";
import { subscribeCompanyLiveEvents } from "../services/live-events.ts";
import { readProcessStartedAt } from "../services/hot-restart.ts";
import { instanceSettingsService } from "../services/instance-settings.ts";

const embeddedPostgresSupport = await getEmbeddedPostgresTestSupport();
const describeEmbeddedPostgres = embeddedPostgresSupport.supported ? describe : describe.skip;

if (!embeddedPostgresSupport.supported) {
  console.warn(
    `Skipping embedded Postgres task-drain admission release tests on this host: ${embeddedPostgresSupport.reason ?? "unsupported environment"}`,
  );
}

describeEmbeddedPostgres("heartbeat task-drain admission release", () => {
  let db!: ReturnType<typeof createDb>;
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  const privateCwds = new Set<string>();
  const settlementServers = new Set<Server>();

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("heartbeat-task-drain-admission-release-");
    db = createDb(tempDb.connectionString);
  }, 60_000);

  function isHeartbeatRunDependentFkError(error: unknown) {
    const message = error instanceof Error ? `${error.message} ${String(error.cause ?? "")}` : String(error);
    return (
      message.includes("heartbeat_run_events_run_id_heartbeat_runs_id_fk") ||
      message.includes("activity_log_run_id_heartbeat_runs_id_fk")
    );
  }

  async function deleteHeartbeatRunsWithDependents() {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await db.delete(heartbeatRunEvents);
      await db.delete(activityLog);
      try {
        await db.delete(heartbeatRuns);
        return;
      } catch (error) {
        if (!isHeartbeatRunDependentFkError(error) || attempt === 4) throw error;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    }
  }

  afterEach(async () => {
    stopTaskDrain();
    for (const server of settlementServers) await new Promise<void>((resolve) => server.close(() => resolve()));
    settlementServers.clear();
    await db.delete(nativeRunFinalizations);
    await deleteHeartbeatRunsWithDependents();
    await db.delete(agentWakeupRequests);
    await db.delete(issues);
    await db.delete(agentRuntimeState);
    await db.delete(agents);
    await db.delete(companySkills);
    await db.delete(projects);
    await db.delete(companies);
    for (const cwd of privateCwds) await rm(cwd, { recursive: true, force: true });
    privateCwds.clear();
  });

  afterAll(async () => {
    await tempDb?.cleanup();
  });

  async function seedQueuedRun() {
    const companyId = randomUUID();
    const agentId = randomUUID();
    const issueId = randomUUID();
    const runId = randomUUID();
    const wakeupRequestId = randomUUID();
    const cwd = await mkdtemp(path.join(tmpdir(), "task-drain-private-"));
    privateCwds.add(cwd);
    // The real process finishes its ordinary task, so successful-run handoff
    // recovery does not legitimately start a separate follow-up provider run.
    const settlement = createServer(async (request, response) => {
      const requestedRunId = new URL(request.url ?? "/", "http://localhost").searchParams.get("runId");
      if (request.method !== "POST" || requestedRunId !== runId) { response.writeHead(403).end(); return; }
      await db.update(issues).set({ status: "done", completedAt: new Date() })
        .where(and(eq(issues.id, issueId), eq(issues.companyId, companyId), eq(issues.executionRunId, runId)));
      response.writeHead(200).end();
    });
    settlementServers.add(settlement);
    settlement.listen(0, "127.0.0.1");
    await new Promise<void>((resolve) => settlement.once("listening", resolve));
    const port = (settlement.address() as { port: number }).port;

    await db.insert(companies).values({
      id: companyId,
      name: "Paperclip",
      issuePrefix: `T${companyId.replace(/-/g, "").slice(0, 6).toUpperCase()}`,
      requireBoardApprovalForNewAgents: false,
    });

    await db.insert(agents).values({
      id: agentId,
      companyId,
      name: "Drain Race Agent",
      role: "engineer",
      status: "idle",
      adapterType: "process",
      adapterConfig: {
        command: process.execPath,
        args: ["-e", `require('node:fs').appendFileSync('invocations.txt', process.env.PAPERCLIP_RUN_ID + '\\n'); fetch('http://127.0.0.1:${port}/complete?runId=' + process.env.PAPERCLIP_RUN_ID, { method: 'POST' }).then(response => { if (!response.ok) process.exitCode = 1 })`],
        cwd,
      },
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 60,
          wakeOnDemand: true,
        },
      },
      permissions: {},
    });

    await db.insert(issues).values({
      id: issueId,
      companyId,
      title: "Work claimed just before a drain trips",
      status: "todo",
      priority: "high",
      assigneeAgentId: agentId,
      assigneeAdapterOverrides: { useProjectWorkspace: false },
      responsibleUserId: "responsible-user",
    });

    await db.insert(agentWakeupRequests).values({
      id: wakeupRequestId,
      companyId,
      agentId,
      source: "assignment",
      status: "queued",
    });

    await db.insert(heartbeatRuns).values({
      id: runId,
      companyId,
      agentId,
      invocationSource: "assignment",
      triggerDetail: "system",
      status: "queued",
      wakeupRequestId,
      contextSnapshot: { issueId, wakeReason: "issue_assigned" },
    });

    return { companyId, agentId, issueId, runId, wakeupRequestId, cwd };
  }

  it("releases the run, wakeup, and issue lock when a task drain trips right after the run is claimed", async () => {
    const { companyId, issueId, runId, wakeupRequestId, cwd } = await seedQueuedRun();
    const heartbeat = heartbeatService(db);

    // The claim path publishes a "heartbeat.run.status" live event with
    // status "running" the moment it flips the run row, before the run is
    // dispatched to executeRun's second suppression check. Starting the
    // drain from that same event reproduces the gap the fix closes: the
    // drain trips after the first admission check passed but before the
    // second one runs.
    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.runId === runId && payload.status === "running") {
        startTaskDrain({});
      }
    });

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    const run = await db
      .select({
        status: heartbeatRuns.status,
        startedAt: heartbeatRuns.startedAt,
        responsibleUserId: heartbeatRuns.responsibleUserId,
        capacityReleasedAt: heartbeatRuns.capacityReleasedAt,
      })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run).toMatchObject({ status: "queued", startedAt: null, responsibleUserId: null });
    expect(run?.capacityReleasedAt).toBeInstanceOf(Date);
    await expect(readFile(path.join(cwd, "invocations.txt"), "utf8")).rejects.toMatchObject({ code: "ENOENT" });

    const wakeup = await db
      .select({ status: agentWakeupRequests.status, claimedAt: agentWakeupRequests.claimedAt })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup).toMatchObject({ status: "queued", claimedAt: null });

    const issue = await db
      .select({
        executionRunId: issues.executionRunId,
        executionAgentNameKey: issues.executionAgentNameKey,
        executionLockedAt: issues.executionLockedAt,
      })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue).toMatchObject({
      executionRunId: null,
      executionAgentNameKey: null,
      executionLockedAt: null,
    });

    const status = getTaskDrainStatus();
    expect(status.draining).toBe(true);
    expect(status.activeRuns).toBe(0);
    expect(status.pendingWakes).toBe(0);
    expect(status.quiescent).toBe(true);

    // The released run is not orphaned: once the drain lifts, the normal
    // admission path picks it back up and it runs to completion.
    stopTaskDrain();
    await heartbeat.resumeQueuedRuns();
    await heartbeat.drainActiveRunExecutions();

    const finished = await db
      .select({ status: heartbeatRuns.status })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(finished?.status).toBe("succeeded");
    expect(await readFile(path.join(cwd, "invocations.txt"), "utf8")).toBe(`${runId}\n`);
  }, 20_000);

  it("keeps a live retained native runner's capacity reserved when drain trips during reattachment", async () => {
    const { companyId, agentId, issueId, runId, cwd } = await seedQueuedRun();
    const launch = async () => {
      const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { cwd, detached: true, stdio: "ignore" });
      const closed = once(child, "close");
      await once(child, "spawn");
      const startedAt = await readProcessStartedAt(child.pid!);
      if (!startedAt) throw new Error("Fixture process start identity unavailable");
      return { child, closed, pid: child.pid!, startedAt: new Date(startedAt) };
    };
    const oldController = await launch();
    oldController.child.kill("SIGTERM");
    await oldController.closed;
    const retained = await launch();
    let unsubscribe = () => {};
    try {
      const sessionId = randomUUID();
      await db.update(companies).set({ defaultResponsibleUserId: "responsible-user" }).where(eq(companies.id, companyId));
      await db.update(agents).set({ adapterType: "paperclip_runner" }).where(eq(agents.id, agentId));
      await db.update(issues).set({ status: "in_progress", executionRunId: runId }).where(eq(issues.id, issueId));
      await db.update(heartbeatRuns).set({ status: "running", runtimeMode: "native", nativeIssueId: issueId,
        nativeSessionId: sessionId, startedAt: retained.startedAt, capacityGroup: "", capacityReleasedAt: null,
        processPid: retained.pid, processGroupId: retained.pid, processStartedAt: retained.startedAt,
        runnerProfileJson: { sessionCheckpoint: { identity: { companyId, agentId, issueId, runId, sessionId },
          sessionId, providerSessionId: "retained-live-fixture", process: { runnerPid: retained.pid, runnerProcessGroupId: retained.pid } } },
      }).where(eq(heartbeatRuns.id, runId));
      await db.insert(nativeRunFinalizations).values({ runId, companyId, issueId, phase: "observed",
        leaseOwner: "former-fixture-controller", leaseExpiresAt: new Date(Date.now() + 60_000),
        controllerBootId: randomUUID(), controllerPid: oldController.pid, controllerProcessStartedAt: oldController.startedAt,
        controllerGeneration: 1,
      });
      const settings = instanceSettingsService(db);
      await settings.updateGeneral({ agentConcurrency: { maxActiveRuns: 1, groups: [] } });
      await settings.updateExperimental({ enableIsolatedWorkspaces: true });
      const heartbeat = heartbeatService(db);
      unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
        const payload = event.payload as { runId?: string; eventType?: string };
        if (event.type === "heartbeat.run.event" && payload.runId === runId && payload.eventType === "native.recovery.transition") startTaskDrain({});
      });
      const recovery = await heartbeat.recoverNativeRunsAfterRestart();
      await heartbeat.drainActiveRunExecutions();
      expect(recovery.claims).toContainEqual(expect.objectContaining({ kind: "reattach_existing_runner", runId,
        process: { pid: retained.pid, processGroupId: retained.pid, startedAt: retained.startedAt.toISOString() } }));
      expect(getTaskDrainStatus().draining).toBe(true);
      const held = await heartbeat.getRun(runId);
      stopTaskDrain();
      unsubscribe();
      unsubscribe = () => {};
      const successorId = randomUUID(), projectId = randomUUID();
      const successorCwd = await mkdtemp(path.join(tmpdir(), "retained-capacity-successor-"));
      privateCwds.add(successorCwd);
      await db.insert(projects).values({ id: projectId, companyId, name: "Private successor", executionWorkspacePolicy: { enabled: true, defaultMode: "adapter_default" } });
      await db.insert(agents).values({ id: successorId, companyId, name: "Successor", role: "engineer", status: "idle", adapterType: "process",
        adapterConfig: { cwd: successorCwd, command: process.execPath, args: ["-e", "require('node:fs').writeFileSync('successor.txt', process.env.PAPERCLIP_RUN_ID)"] },
      });
      const successor = await heartbeat.invoke(successorId, "on_demand", { projectId }, "manual");
      await heartbeat.drainActiveRunExecutions();
      const successorRun = await heartbeat.getRun(successor!.id);
      const successorOutput = await readFile(path.join(successorCwd, "successor.txt"), "utf8").catch(() => null);
      expect(held?.capacityReleasedAt, JSON.stringify({ successorStatus: successorRun?.status, successorOutput })).toBeNull();
      expect(held).toMatchObject({ status: "queued", capacityGroup: "", processPid: retained.pid, processGroupId: retained.pid,
        processStartedAt: retained.startedAt });
      expect((await heartbeat.getRun(runId))?.capacityReleasedAt).toBeNull();
      expect(successorRun?.status).toBe("queued");
      expect(successorOutput).toBeNull();
      expect(retained.child.exitCode).toBeNull();
      expect(retained.child.signalCode).toBeNull();
      expect(await readProcessStartedAt(retained.pid)).toBe(retained.startedAt.toISOString());
    } finally {
      unsubscribe();
      stopTaskDrain();
      if (retained.child.exitCode === null && retained.child.signalCode === null) retained.child.kill("SIGTERM");
      await retained.closed;
    }
  }, 20_000);

  // Fault the semantic release transaction, independent of how many read/
  // claim transactions precede it. This still exercises a real rollback.
  function withFailingClaimRelease(realDb: typeof db) {
    return new Proxy(realDb, {
      get(target, prop, receiver) {
        if (prop !== "transaction") return Reflect.get(target, prop, receiver);
        return (fn: (tx: unknown) => Promise<unknown>) => target.transaction(tx => {
          let releasing = false;
          const txProxy = new Proxy(tx as object, {
            get(txTarget, txProp, txReceiver) {
              if (txProp !== "update") return Reflect.get(txTarget, txProp, txReceiver);
              return (table: unknown) => {
                if (releasing && table === issues) throw new Error("simulated transactional write failure");
                const builder = (txTarget as any).update(table);
                return new Proxy(builder, {
                  get(update, key) {
                    if (key !== "set") return Reflect.get(update, key);
                    return (values: Record<string, unknown>) => {
                      if (table === heartbeatRuns && values.status === "queued" && values.startedAt === null) releasing = true;
                      return update.set(values);
                    };
                  },
                });
              };
            },
          });
          return fn(txProxy);
        });
      },
    }) as typeof db;
  }

  it("leaves the run row running for the orphan reaper when the atomic release fails", async () => {
    const { companyId, issueId, runId, wakeupRequestId } = await seedQueuedRun();
    // Fault the release transaction on the issue-lock write, so executeRun's
    // suppression branch catches the failure, logs it, and returns instead
    // of throwing. There is no in-process fallback or retry for this path.
    const failingDb = withFailingClaimRelease(db);
    const heartbeat = heartbeatService(failingDb);

    const unsubscribe = subscribeCompanyLiveEvents(companyId, (event) => {
      const payload = event.payload as { runId?: string; status?: string };
      if (event.type === "heartbeat.run.status" && payload.runId === runId && payload.status === "running") {
        startTaskDrain({});
      }
    });

    try {
      await heartbeat.resumeQueuedRuns();
      await heartbeat.drainActiveRunExecutions();
    } finally {
      unsubscribe();
    }

    // The release transaction rolled back, so the run, wakeup, and issue
    // lock stay exactly as the admission claim left them.
    const run = await db
      .select({ status: heartbeatRuns.status, capacityGroup: heartbeatRuns.capacityGroup, capacityReleasedAt: heartbeatRuns.capacityReleasedAt })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(run?.status).toBe("running");
    expect(run?.capacityGroup).not.toBeNull();
    expect(run?.capacityReleasedAt).toBeNull();

    const wakeup = await db
      .select({ status: agentWakeupRequests.status })
      .from(agentWakeupRequests)
      .where(eq(agentWakeupRequests.id, wakeupRequestId))
      .then((rows) => rows[0] ?? null);
    expect(wakeup?.status).toBe("claimed");

    const issue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(issue?.executionRunId).toBe(runId);

    // executeRun did not throw, so the dispatch site removed this run's
    // execution promise from active tracking like it does for any other
    // completed run. Task-drain now reads quiescent even though the
    // database still holds the run claimed: this reading counts in-process
    // work only.
    const status = getTaskDrainStatus();
    expect(status.activeRuns).toBe(0);
    expect(status.quiescent).toBe(true);

    // Missing local tracking cannot override the durable controller lease.
    // Once that unrenewed lease expires, the reaper finalizes the orphan and
    // releases the issue lock on its own cycle.
    const beforeExpiry = await heartbeat.reapOrphanedRuns();
    expect(beforeExpiry.runIds).not.toContain(runId);
    await db.update(heartbeatRuns).set({
      controllerLeaseExpiresAt: sql`clock_timestamp() - interval '1 second'`,
    }).where(eq(heartbeatRuns.id, runId));
    const reapResult = await heartbeat.reapOrphanedRuns();
    expect(reapResult.runIds).toContain(runId);

    const reapedRun = await db
      .select({ status: heartbeatRuns.status, errorCode: heartbeatRuns.errorCode })
      .from(heartbeatRuns)
      .where(eq(heartbeatRuns.id, runId))
      .then((rows) => rows[0] ?? null);
    expect(reapedRun?.status).toBe("failed");
    expect(reapedRun?.errorCode).toBe("process_lost");

    // The issue is still "todo" and assigned to the same agent, so the
    // reaper's normal self-heal path queues a fresh recovery run for it
    // instead of leaving the lock pointed at the failed run.
    const reapedIssue = await db
      .select({ executionRunId: issues.executionRunId })
      .from(issues)
      .where(eq(issues.id, issueId))
      .then((rows) => rows[0] ?? null);
    expect(reapedIssue?.executionRunId).not.toBe(runId);
  }, 20_000);
});
