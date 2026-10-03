import { randomUUID } from "node:crypto";
import { eq, sql } from "drizzle-orm";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { agents, companies, createDb, environments, instanceSettings, projects, issues, heartbeatRuns } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentQuotaFallbackService as createQuotaService, type AgentQuotaFallbackDependencies } from "../services/agent-quota-fallback.js";
import { quotaFallbackBook } from "../services/agent-quota-fallback-policy.js";
import { instanceSettingsService } from "../services/instance-settings.js";
import { agentService } from "../services/agents.js";
import { probeQuotaModel, quotaProbeAvailable } from "../services/quota-model-probe.js";
import { requireServerAdapter } from "../adapters/index.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDatabase = support.supported ? describe : describe.skip;

describeDatabase("durable Agent quota fallback", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  const now = new Date("2030-04-20T12:00:00Z");
  let clock = now;
  beforeEach(() => { clock = now; });
  function agentQuotaFallbackService(database: typeof db, dependencies: AgentQuotaFallbackDependencies) {
    return createQuotaService(database, { ...dependencies, clock: () => clock });
  }
  beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("paperclip-quota-fallback-"); db = createDb(temporary.connectionString); }, 20_000);
  afterEach(async () => {
    vi.restoreAllMocks();
    await db.transaction(async tx => {
      await tx.execute(sql.raw("SET LOCAL client_min_messages = warning"));
      await tx.execute(sql.raw('TRUNCATE TABLE "agents", "companies" CASCADE'));
    });
    await instanceSettingsService(db).updateGeneral({ agentConcurrency: { maxActiveRuns: null, groups: [] } });
    await db.update(instanceSettings).set({ defaultEnvironmentId: null, experimental: {} });
    await db.delete(environments);
  });
  afterAll(async () => { await temporary?.cleanup(); });

  async function seed() {
    const companyId = randomUUID(), agentId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Quota test", issuePrefix: `Q${companyId.slice(0, 7)}`, defaultResponsibleUserId: "alice" });
    await db.insert(agents).values({ id: agentId, companyId, name: "Coder", role: "engineer", status: "idle", adapterType: "claude_local", adapterConfig: { model: "MiniMax-M3.1-Flash-Preview" }, runtimeConfig: { quotaFallback: { enabled: true, recoveryEnabled: true, primaryCheckIntervalSec: 300, backup: { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" } } }, metadata: { unrelated: "keep" } });
    return { id: randomUUID(), companyId, agentId, finishedAt: now };
  }

  it("persists a quota switch across service restart without changing the primary or another user", async () => {
    const run = await seed();
    const probe = vi.fn(async () => "unavailable" as const);
    const service = agentQuotaFallbackService(db, { probePrimary: probe });
    expect(await service.registerQuotaFailure(run, "alice", now)).toMatchObject({ adapterType: "codex_local", model: "gpt-6.1-sol", reason: "primary_quota" });
    const restarted = agentQuotaFallbackService(db, { probePrimary: probe });
    expect(await restarted.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: true, nextPrimaryCheckAt: "2030-04-20T12:05:00.000Z" });
    expect(await restarted.getStatus(run.agentId, "bob", now)).toMatchObject({ usingBackup: false });
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    expect(agent?.adapterType).toBe("claude_local"); expect(agent?.metadata?.unrelated).toBe("keep"); expect(probe).not.toHaveBeenCalled();
  });

  it("uses the configured backup after an unavailable primary probe without inventing quota evidence", async () => {
    const run = await seed();
    const service = agentQuotaFallbackService(db, { probePrimary: async () => "unavailable" });
    const status = await service.checkPrimary(run.agentId, "alice", { force: true });
    expect(status).toMatchObject({
      usingBackup: true,
      lastQuotaAt: null,
      lastPrimaryCheckResult: "unavailable",
      nextPrimaryCheckAt: "2030-04-20T12:05:00.000Z",
    });
    expect(await service.getStatus(run.agentId, "bob")).toMatchObject({ usingBackup: false });
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    expect(agent?.adapterType).toBe("claude_local");
    expect(quotaFallbackBook(agent!).scopes.alice).toMatchObject({
      primaryQuotaRunId: null,
      backupQuotaRunId: null,
    });
  });

  it("monitors active primary work before any quota failure and keeps its user and source context", async () => {
    const run = await seed();
    await db.insert(heartbeatRuns).values({
      id: run.id, companyId: run.companyId, agentId: run.agentId,
      invocationSource: "assignment", status: "running", responsibleUserId: "alice", startedAt: now,
    });
    const probe = vi.fn(async () => "unavailable" as const);
    const service = agentQuotaFallbackService(db, { probePrimary: probe });
    await service.tick(now);
    expect(probe).toHaveBeenCalledOnce();
    expect(probe.mock.calls[0]).toEqual([
      expect.objectContaining({ id: run.agentId }), "alice", expect.any(Object),
      { sourceRunId: run.id },
    ]);
    expect(await service.getStatus(run.agentId, "alice")).toMatchObject({ usingBackup: true, lastQuotaAt: null });
    expect(await service.getStatus(run.agentId, "bob")).toMatchObject({ usingBackup: false });
    const [stored] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id));
    expect(stored?.status).toBe("running");
  });

  it("rechecks an active healthy primary on the configured cadence without pinging an idle agent", async () => {
    const run = await seed();
    const probe = vi.fn(async () => "available" as const);
    const service = agentQuotaFallbackService(db, { probePrimary: probe });
    await service.tick(now);
    expect(probe).not.toHaveBeenCalled();
    await db.insert(heartbeatRuns).values({
      id: run.id, companyId: run.companyId, agentId: run.agentId,
      invocationSource: "assignment", status: "running", responsibleUserId: "alice", startedAt: now,
    });
    await service.tick(now);
    expect(probe).toHaveBeenCalledOnce();
    clock = new Date(now.getTime() + 299_000);
    await service.tick(clock);
    expect(probe).toHaveBeenCalledOnce();
    clock = new Date(now.getTime() + 300_000);
    await service.tick(clock);
    expect(probe).toHaveBeenCalledTimes(2);
    expect(await service.getStatus(run.agentId, "alice")).toMatchObject({ usingBackup: false });
  });

  it.each(["busy", "error"] as const)("does not switch active primary work after an inconclusive %s check", async result => {
    const run = await seed();
    await db.insert(heartbeatRuns).values({
      id: run.id, companyId: run.companyId, agentId: run.agentId,
      invocationSource: "assignment", status: "running", responsibleUserId: "alice", startedAt: now,
    });
    const service = agentQuotaFallbackService(db, { probePrimary: async () => result });
    await service.tick(now);
    expect(await service.getStatus(run.agentId, "alice")).toMatchObject({
      usingBackup: false, lastPrimaryCheckResult: result, lastQuotaAt: null,
    });
  });

  it("leaves active primary monitoring off when automatic checks are disabled", async () => {
    const run = await seed();
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    await agentService(db).update(run.agentId, {
      runtimeConfig: { ...agent!.runtimeConfig, quotaFallback: {
        ...(agent!.runtimeConfig.quotaFallback as Record<string, unknown>), recoveryEnabled: false,
      } },
    });
    await db.insert(heartbeatRuns).values({
      id: run.id, companyId: run.companyId, agentId: run.agentId,
      invocationSource: "assignment", status: "running", responsibleUserId: "alice", startedAt: now,
    });
    const probe = vi.fn(async () => "unavailable" as const);
    await agentQuotaFallbackService(db, { probePrimary: probe }).tick(now);
    expect(probe).not.toHaveBeenCalled();
  });

  it.each(["busy", "error"] as const)("keeps the primary after an inconclusive %s probe", async result => {
    const run = await seed();
    const service = agentQuotaFallbackService(db, { probePrimary: async () => result });
    expect(await service.checkPrimary(run.agentId, "alice", { force: true })).toMatchObject({
      usingBackup: false,
      lastPrimaryCheckResult: result,
      lastQuotaAt: null,
    });
  });

  it("recovers a probe-activated backup on the existing primary-check cadence", async () => {
    const run = await seed();
    const recovered = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce("unavailable").mockResolvedValueOnce("available");
    const service = agentQuotaFallbackService(db, { probePrimary: probe, onRecovered: recovered });
    await service.checkPrimary(run.agentId, "alice", { force: true });
    clock = new Date("2030-04-20T12:05:00Z");
    await service.tick(clock);
    expect(await service.getStatus(run.agentId, "alice")).toMatchObject({
      usingBackup: false,
      lastPrimaryCheckResult: "available",
      lastQuotaAt: null,
      nextPrimaryCheckAt: null,
    });
    expect(recovered).toHaveBeenCalledOnce();
  });

  it("checks on the configured cadence and only returns after real primary availability", async () => {
    const run = await seed(); const recovered = vi.fn();
    const probe = vi.fn().mockResolvedValueOnce("unavailable").mockResolvedValueOnce("available");
    const service = agentQuotaFallbackService(db, { probePrimary: probe, onRecovered: recovered });
    await service.registerQuotaFailure(run, "alice", now);
    await service.tick(new Date("2030-04-20T12:04:59Z")); expect(probe).not.toHaveBeenCalled();
    clock = new Date("2030-04-20T12:05:00Z");
    await service.tick(new Date("2030-04-20T12:05:00Z"));
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: true, lastPrimaryCheckResult: "unavailable", nextPrimaryCheckAt: "2030-04-20T12:10:00.000Z" });
    clock = new Date("2030-04-20T12:10:00Z"); await service.tick(clock);
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: false, lastPrimaryCheckResult: "available", nextPrimaryCheckAt: null });
    expect(recovered).toHaveBeenCalledTimes(1);
  });

  it("does not ping-pong to an exhausted primary when the backup is also quota limited", async () => {
    const run = await seed(); const service = agentQuotaFallbackService(db, { probePrimary: async () => "unavailable" });
    await service.registerQuotaFailure(run, "alice", now);
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    const book = quotaFallbackBook(agent!);
    const backup = { ...run, id: randomUUID(), finishedAt: new Date(now.getTime() + 60_000), runnerProfileJson: { quotaFallback: { version: 1, fingerprint: book.fingerprint, usingBackup: true, primaryAdapterType: "claude_local", adapterType: "codex_local", model: "gpt-6.1-sol" } } };
    expect(await service.registerQuotaFailure(backup, "alice", backup.finishedAt)).toBeNull();
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: true });
  });

  it("can resume on the recovered primary if an older admitted backup later hits quota", async () => {
    const run = await seed(); const service = agentQuotaFallbackService(db, { probePrimary: async () => "available" });
    await service.registerQuotaFailure(run, "alice", now);
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId)); const book = quotaFallbackBook(agent!);
    clock = new Date(now.getTime() + 300_000);
    await service.checkPrimary(run.agentId, "alice", { now: new Date(now.getTime() + 300_000), force: true });
    const backup = { ...run, id: randomUUID(), finishedAt: new Date(now.getTime() + 360_000), runnerProfileJson: { quotaFallback: { version: 1, fingerprint: book.fingerprint, usingBackup: true, primaryAdapterType: "claude_local", adapterType: "codex_local", model: "gpt-6.1-sol" } } };
    expect(await service.registerQuotaFailure(backup, "alice", backup.finishedAt)).toMatchObject({ adapterType: "claude_local", reason: "primary_recovered" });
  });

  it("deduplicates simultaneous checks and keeps budget-denied Agents from probing", async () => {
    const run = await seed(); let release!: () => void;
    const waiting = new Promise<void>(resolve => { release = resolve; });
    const probe = vi.fn(async () => { await waiting; return "available" as const; });
    const service = agentQuotaFallbackService(db, { probePrimary: probe });
    await service.registerQuotaFailure(run, "alice", now);
    const first = service.checkPrimary(run.agentId, "alice", { now, force: true });
    await expect.poll(() => probe.mock.calls.length).toBe(1);
    await service.checkPrimary(run.agentId, "alice", { now, force: true }); expect(probe).toHaveBeenCalledTimes(1);
    release(); await first;
    const blocked = agentQuotaFallbackService(db, { probePrimary: probe, canCheck: async () => false });
    await blocked.checkPrimary(run.agentId, "alice", { now, force: true }); expect(probe).toHaveBeenCalledTimes(1);
  });

  it("keeps server-owned quota state through client metadata replacement and rejects forged creation state", async () => {
    const run = await seed();
    const service = agentQuotaFallbackService(db, { probePrimary: async () => "unavailable" });
    await service.registerQuotaFailure(run, "alice", now);
    const svc = agentService(db);
    await svc.update(run.agentId, { metadata: { edited: true, quotaFallbackState: { forged: true } } });
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: true });
    await svc.update(run.agentId, { metadata: null });
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: true });
    const created = await svc.create(run.companyId, { name: "New coder", role: "engineer", metadata: { safe: true, quotaFallbackState: { forged: true } } });
    expect(created.metadata).toEqual({ safe: true });
    await svc.update(created.id, { metadata: null });
    const [cleared] = await db.select({ isNull: sql<boolean>`${agents.metadata} is null` }).from(agents).where(eq(agents.id, created.id));
    expect(cleared?.isNull).toBe(true);
  });

  it("holds the old probe capacity through a config edit and discards its stale positive result", async () => {
    const run = await seed(); let release!: () => void;
    const probe = vi.fn(async () => { await new Promise<void>(resolve => { release = resolve; }); return "available" as const; });
    const service = agentQuotaFallbackService(db, { probePrimary: probe });
    await service.registerQuotaFailure(run, "alice", now);
    const checking = service.checkPrimary(run.agentId, "alice", { now, force: true });
    await expect.poll(() => probe.mock.calls.length).toBe(1);
    await db.update(agents).set({ adapterConfig: { model: "MiniMax-another-version" } }).where(eq(agents.id, run.agentId));
    await service.checkPrimary(run.agentId, "alice", { now, force: true });
    expect(probe).toHaveBeenCalledTimes(1);
    release(); await checking;
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ lastPrimaryCheckResult: null, checkingPrimary: false });
  });

  it("requires an actual hello response on the selected primary model", async () => {
    const run = await seed();
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    const test = vi.spyOn(requireServerAdapter("claude_local"), "testEnvironment").mockResolvedValue({ adapterType: "claude_local", status: "pass", testedAt: now.toISOString(), checks: [{ code: "claude_hello_probe_passed", level: "info", message: "hello" }] });
    expect(quotaProbeAvailable(await probeQuotaModel(db, { ...agent!, adapterConfig: { model: "MiniMax-M3.1-Flash-Preview", engine: "acp" } }, "alice"))).toBe(true);
    expect(test).toHaveBeenCalledWith(expect.objectContaining({ config: expect.objectContaining({ engine: "cli", model: "MiniMax-M3.1-Flash-Preview", helloProbeTimeoutSec: 45 }) }));
    expect(quotaProbeAvailable({ adapterType: "claude_local", status: "pass", testedAt: now.toISOString(), checks: [{ code: "claude_cli_installed", level: "info", message: "installed" }] })).toBe(false);
  });

  it("never probes a host account when the inherited instance environment is remote or local execution is forbidden", async () => {
    const run = await seed();
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    const [remote] = await db.insert(environments).values({ name: "Remote", driver: "ssh" }).returning();
    await db.update(instanceSettings).set({ defaultEnvironmentId: remote!.id });
    const test = vi.spyOn(requireServerAdapter("claude_local"), "testEnvironment").mockResolvedValue({ adapterType: "claude_local", status: "pass", testedAt: now.toISOString(), checks: [] });
    expect(await probeQuotaModel(db, agent!, "alice")).toMatchObject({ status: "fail", checks: [{ code: "quota_probe_environment_unsupported" }] });
    await db.update(instanceSettings).set({ defaultEnvironmentId: null, experimental: { enableManagedSandboxOnly: true } });
    expect(await probeQuotaModel(db, agent!, "alice")).toMatchObject({ status: "fail" });
    expect(test).not.toHaveBeenCalled();
  });

  it("uses a fresh clock for every serial probe lease and completion", async () => {
    const observed: Array<{ until: number; started: number }> = [];
    const service = agentQuotaFallbackService(db, { probePrimary: async (agent) => {
      const [latest] = await db.select().from(agents).where(eq(agents.id, agent.id));
      observed.push({ until: Date.parse(quotaFallbackBook(latest!).scopes.alice!.probeUntil!), started: clock.getTime() });
      clock = new Date(clock.getTime() + 45_000);
      return "unavailable";
    } });
    for (let index = 0; index < 4; index += 1) await service.registerQuotaFailure(await seed(), "alice", now);
    clock = new Date(now.getTime() + 300_000); await service.tick(clock);
    expect(observed).toHaveLength(4);
    for (const lease of observed) expect(lease.until - lease.started).toBe(120_000);
    const rows = await db.select().from(agents);
    expect(rows.map(agent => quotaFallbackBook(agent).scopes.alice!.lastPrimaryCheckAt).sort()).toEqual([345, 390, 435, 480].map(seconds => new Date(now.getTime() + seconds * 1000).toISOString()));
  });

  it("durably resumes a recovered task when continuation fails before a service restart", async () => {
    const run = await seed();
    const callback = vi.fn().mockRejectedValueOnce(new Error("temporary database outage")).mockResolvedValue(undefined);
    const service = agentQuotaFallbackService(db, { probePrimary: async () => "available", onRecovered: callback });
    await service.registerQuotaFailure(run, "alice", now);
    await expect(service.checkPrimary(run.agentId, "alice", { now, force: true })).rejects.toThrow("temporary database outage");
    const restarted = agentQuotaFallbackService(db, { probePrimary: async () => "unavailable", onRecovered: callback });
    await restarted.tick(now);
    expect(callback).toHaveBeenCalledTimes(2);
    await restarted.tick(now); expect(callback).toHaveBeenCalledTimes(2);
  });

  it("uses project credentials after Agent credentials and refuses unsupported routine or model overrides", async () => {
    const run = await seed(); const projectId = randomUUID(), issueId = randomUUID();
    await db.insert(projects).values({ id: projectId, companyId: run.companyId, name: "Project auth", env: { ANTHROPIC_BASE_URL: "https://project.invalid" } });
    await db.insert(issues).values({ id: issueId, companyId: run.companyId, projectId, title: "Quota work", assigneeAgentId: run.agentId });
    await db.insert(heartbeatRuns).values({ ...run, invocationSource: "assignment", status: "failed", contextSnapshot: { issueId } });
    const [agent] = await db.update(agents).set({ adapterConfig: { model: "MiniMax-M3.1-Flash-Preview", env: { ANTHROPIC_BASE_URL: "https://agent.invalid" } } }).where(eq(agents.id, run.agentId)).returning();
    const test = vi.spyOn(requireServerAdapter("claude_local"), "testEnvironment").mockResolvedValue({ adapterType: "claude_local", status: "pass", testedAt: now.toISOString(), checks: [] });
    await probeQuotaModel(db, agent!, "alice", { sourceRunId: run.id });
    expect(test).toHaveBeenLastCalledWith(expect.objectContaining({ config: expect.objectContaining({ env: { ANTHROPIC_BASE_URL: "https://project.invalid" } }) }));
    await db.update(issues).set({ originKind: "routine_execution", originId: randomUUID() }).where(eq(issues.id, issueId));
    expect(await probeQuotaModel(db, agent!, "alice", { sourceRunId: run.id })).toMatchObject({ status: "fail", checks: [{ code: "quota_probe_environment_unsupported" }] });
    await db.update(issues).set({ originKind: "manual", assigneeAdapterOverrides: { adapterConfig: { model: "different-model" } } }).where(eq(issues.id, issueId));
    expect(await probeQuotaModel(db, agent!, "alice", { sourceRunId: run.id })).toMatchObject({ status: "fail" });
    expect(test).toHaveBeenCalledOnce();
  });

  it("preserves backup routing while recovery is disabled and applies an edited cadence", async () => {
    const run = await seed(); const probe = vi.fn(async () => "available" as const);
    const service = agentQuotaFallbackService(db, { probePrimary: probe });
    await service.registerQuotaFailure(run, "alice", now);
    const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
    const original = agent!.runtimeConfig;
    const policy = original.quotaFallback as Record<string, unknown>;
    await agentService(db).update(run.agentId, { runtimeConfig: { ...original, quotaFallback: { ...policy, recoveryEnabled: false, primaryCheckIntervalSec: 60 } } });
    expect(await service.getStatus(run.agentId, "alice", now)).toMatchObject({ usingBackup: true, nextPrimaryCheckAt: null });
    clock = new Date(now.getTime() + 30_000); await service.tick(clock); expect(probe).not.toHaveBeenCalled();
    await agentService(db).update(run.agentId, { runtimeConfig: { ...original, quotaFallback: { ...policy, recoveryEnabled: true, primaryCheckIntervalSec: 60 } } });
    expect(await service.getStatus(run.agentId, "alice", clock)).toMatchObject({ usingBackup: true, nextPrimaryCheckAt: new Date(now.getTime() + 60_000).toISOString() });
    clock = new Date(now.getTime() + 60_000); await service.tick(clock);
    expect(probe).toHaveBeenCalledOnce();
    expect(await service.getStatus(run.agentId, "alice", clock)).toMatchObject({ usingBackup: false });
  });
});
