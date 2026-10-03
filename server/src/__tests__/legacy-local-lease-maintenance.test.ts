import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import {
  activityLog, agents, companies, createDb, environmentLeases, environments,
  heartbeatRuns, issues, type Db,
} from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../services/heartbeat-run-events.js";
import * as localCapacity from "../services/legacy-process-capacity.js";
import { getConversationOwnershipBlocker } from "../services/conversation-continuation.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("stopped legacy Local lease maintenance", () => {
  let db: Db;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("paperclip-local-lease-maintenance-");
    db = createDb(temporary.connectionString);
    await db.delete(environments);
  }, 20_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL client_min_messages = warning"));
      await tx.execute(sql.raw('TRUNCATE TABLE "companies", "environments" CASCADE'));
    });
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID(), issueId = randomUUID();
    const runId = randomUUID(), leaseId = randomUUID(), environmentId = randomUUID();
    const controllerBootId = randomUUID();
    const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    await once(child, "spawn");
    const processPid = child.pid!;
    const processStartedAt = new Date().toISOString();
    const stopped = once(child, "exit");
    child.kill();
    await stopped;
    const localNamespace = await localCapacity.legacyLocalProcessNamespace();
    if (!localNamespace) throw new Error("Fixture requires a known Local namespace");
    const expectedStopIdentity = { controllerBootId, processPid, processGroupId: null, processStartedAt, localNamespace };
    await db.insert(companies).values({ id: companyId, name: "Maintenance fixture", issuePrefix: "LM" + companyId.slice(0, 6), defaultResponsibleUserId: "board" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Worker", role: "engineer", status: "idle", adapterType: "codex_local", adapterConfig: {}, runtimeConfig: {} });
    await db.insert(issues).values({ id: issueId, companyId, title: "Preserve original work", status: "todo", assigneeAgentId: agentId, responsibleUserId: "board" });
    await db.insert(environments).values({ id: environmentId, name: "Local", driver: "local", status: "active", config: {} });
    await db.insert(heartbeatRuns).values({ id: runId, companyId, agentId, status: "interrupted", invocationSource: "assignment", runtimeMode: "legacy", finishedAt: new Date(), capacityGroup: "", capacityReleasedAt: new Date(), controllerBootId, controllerLeaseExpiresAt: new Date(Date.now() - 60_000), processPid, processGroupId: null, processStartedAt: new Date(processStartedAt), contextSnapshot: { issueId }, runnerProfileJson: { adapterDispatch: { adapterType: "codex_local" } }, resultJson: { conversationContinuation: "continue_conversation_v1" } });
    await db.insert(environmentLeases).values({ id: leaseId, companyId, environmentId, issueId, heartbeatRunId: runId, provider: "local", providerLeaseId: null, status: "active", metadata: { driver: "local", agentId } });
    const event = await appendHeartbeatRunEvent(db, { companyId, runId, agentId, eventType: "legacy.local_process_stopped", stream: "system", level: "info", payload: { ...expectedStopIdentity, localProcess: true }, message: "Fixture observed exact child exit" });
    return { companyId, agentId, issueId, runId, leaseId, stopReceiptSeq: event.row.seq, expectedStopIdentity };
  }

  function reconcile() {
    // Missing maintenance behavior produces an assertion failure in RED,
    // then the remaining assertions exercise actual database effects in GREEN.
    expect(localCapacity.reconcileStoppedLegacyLocalLease).toBeTypeOf("function");
    return localCapacity.reconcileStoppedLegacyLocalLease;
  }

  async function readLease(leaseId: string) {
    return (await db.select().from(environmentLeases).where(eq(environmentLeases.id, leaseId)))[0]!;
  }

  it("releases the stopped terminal run's exact stale Local lease without waking or changing the task", async () => {
    const selector = await seed();
    expect(await getConversationOwnershipBlocker(db, selector.companyId, selector.issueId)).toMatchObject({ runId: selector.runId });
    const result = await reconcile()(db, selector, { apply: true });
    expect(result.outcome).toBe("released");
    expect(await readLease(selector.leaseId)).toMatchObject({ status: "released", cleanupStatus: "success" });
    expect((await readLease(selector.leaseId)).releasedAt).not.toBeNull();
    expect(await getConversationOwnershipBlocker(db, selector.companyId, selector.issueId)).toBeNull();
    expect((await db.select().from(issues).where(eq(issues.id, selector.issueId)))[0]).toMatchObject({ status: "todo", assigneeAgentId: selector.agentId, executionRunId: null });
    expect(await db.select().from(heartbeatRuns)).toHaveLength(1);
  });

  it("defaults to dry-run and repeated apply preserves the first release and one activity", async () => {
    const selector = await seed();
    expect((await reconcile()(db, selector)).outcome).toBe("eligible");
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
    await reconcile()(db, selector, { apply: true });
    const releasedAt = (await readLease(selector.leaseId)).releasedAt;
    expect((await reconcile()(db, selector, { apply: true })).outcome).toBe("already_released");
    expect((await readLease(selector.leaseId)).releasedAt).toEqual(releasedAt);
    expect(await db.select().from(activityLog).where(eq(activityLog.action, "environment.local_lease_reconciled"))).toHaveLength(1);
  });

  it.each(["companyId", "agentId", "issueId", "runId", "leaseId"] as const)("refuses a mismatched %s selector without partial release", async key => {
    const selector = await seed();
    await expect(reconcile()(db, { ...selector, [key]: randomUUID() }, { apply: true })).rejects.toMatchObject({ code: "selector_mismatch" });
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });

  it.each(["controllerBootId", "processPid", "processStartedAt", "localNamespace"] as const)("refuses stale stop identity %s", async key => {
    const selector = await seed();
    const wrong = key === "processPid" ? process.pid : key === "processStartedAt" ? new Date(0).toISOString() : key === "localNamespace" ? "0".repeat(64) : randomUUID();
    await expect(reconcile()(db, { ...selector, expectedStopIdentity: { ...selector.expectedStopIdentity, [key]: wrong } }, { apply: true })).rejects.toMatchObject({ code: key === "localNamespace" ? "host_namespace_unverified" : "stop_receipt_mismatch" });
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });

  it("refuses a later process identity even when an older stop receipt exists", async () => {
    const selector = await seed();
    await appendHeartbeatRunEvent(db, { companyId: selector.companyId, runId: selector.runId, agentId: selector.agentId, eventType: "legacy.process_identity_recorded", stream: "system", level: "info", payload: { ...selector.expectedStopIdentity, localProcess: true }, message: "Later launch invalidates prior stop" });
    await expect(reconcile()(db, selector, { apply: true })).rejects.toMatchObject({ code: "stop_receipt_mismatch" });
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });

  it("refuses when the current host namespace cannot be verified", async () => {
    const selector = await seed();
    const platform = Object.getOwnPropertyDescriptor(process, "platform")!;
    try {
      Object.defineProperty(process, "platform", { ...platform, value: "unverified" });
      vi.resetModules();
      const freshCapacity = await import("../services/legacy-process-capacity.js");
      await expect(freshCapacity.reconcileStoppedLegacyLocalLease(db, selector, { apply: true })).rejects.toMatchObject({ code: "host_namespace_unverified" });
    } finally {
      Object.defineProperty(process, "platform", platform);
    }
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });

  it("refuses an operator-selected stop event that is not the latest exact receipt", async () => {
    const selector = await seed();
    await expect(reconcile()(db, { ...selector, stopReceiptSeq: selector.stopReceiptSeq + 1 }, { apply: true }))
      .rejects.toMatchObject({ code: "stop_receipt_mismatch" });
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });

  it("refuses a live local process even if the fixture contains a matching stop record", async () => {
    const selector = await seed();
    await db.update(heartbeatRuns).set({ processPid: process.pid }).where(eq(heartbeatRuns.id, selector.runId));
    const expectedStopIdentity = { ...selector.expectedStopIdentity, processPid: process.pid };
    const receipt = await appendHeartbeatRunEvent(db, { companyId: selector.companyId, runId: selector.runId, agentId: selector.agentId,
      eventType: "legacy.local_process_stopped", stream: "system", level: "info", payload: { ...expectedStopIdentity, localProcess: true }, message: "Synthetic inconsistent stop record" });
    await expect(reconcile()(db, { ...selector, expectedStopIdentity, stopReceiptSeq: receipt.row.seq }, { apply: true }))
      .rejects.toMatchObject({ code: "provider_process_not_stopped" });
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });

  it("rolls back lease release when the maintenance activity cannot commit", async () => {
    const selector = await seed();
    await db.execute(sql.raw("CREATE FUNCTION maintenance_activity_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action = 'environment.local_lease_reconciled' THEN RAISE EXCEPTION 'maintenance activity rejected'; END IF; RETURN NEW; END $$"));
    await db.execute(sql.raw("CREATE TRIGGER maintenance_activity_failure BEFORE INSERT ON activity_log FOR EACH ROW EXECUTE FUNCTION maintenance_activity_failure()"));
    try {
      await expect(reconcile()(db, selector, { apply: true })).rejects.toThrow(/Failed query/);
      expect(await readLease(selector.leaseId)).toMatchObject({ status: "active", cleanupStatus: null, releasedAt: null });
      expect(await db.select().from(activityLog)).toHaveLength(0);
    } finally {
      await db.execute(sql.raw("DROP TRIGGER maintenance_activity_failure ON activity_log"));
      await db.execute(sql.raw("DROP FUNCTION maintenance_activity_failure()"));
    }
  });

  it.each(["native", "running", "controller_live", "remote", "resource_id"])("refuses %s ownership", async kind => {
    const selector = await seed();
    if (kind === "native") await db.update(heartbeatRuns).set({ runtimeMode: "native" }).where(eq(heartbeatRuns.id, selector.runId));
    if (kind === "running") await db.update(heartbeatRuns).set({ status: "running" }).where(eq(heartbeatRuns.id, selector.runId));
    if (kind === "controller_live") await db.update(heartbeatRuns).set({ controllerLeaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(heartbeatRuns.id, selector.runId));
    if (kind === "remote") await db.update(environmentLeases).set({ provider: "ssh", metadata: { driver: "ssh", agentId: selector.agentId } }).where(eq(environmentLeases.id, selector.leaseId));
    if (kind === "resource_id") await db.update(environmentLeases).set({ providerLeaseId: "remote-owned-resource" }).where(eq(environmentLeases.id, selector.leaseId));
    const code = kind === "controller_live" ? "controller_active" : kind === "native" || kind === "running" ? "execution_not_terminal_legacy" : "lease_not_local_bookkeeping";
    await expect(reconcile()(db, selector, { apply: true })).rejects.toMatchObject({ code });
    expect((await readLease(selector.leaseId)).releasedAt).toBeNull();
  });
});
