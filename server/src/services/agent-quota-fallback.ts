import type { QuotaProbeIdentity } from "./quota-probe-identity.js";
import { randomUUID } from "node:crypto";
import { and, desc, eq, getTableColumns, inArray, sql } from "drizzle-orm";
import { activityLog, agents, companies, heartbeatRuns, type Db } from "@paperclipai/db";
import { logger } from "../middleware/logger.js";
import type { AgentQuotaFallbackStatus } from "@paperclipai/shared";
import { checkRunCapacity } from "./run-capacity.js";
import {
  initialQuotaScope, quotaFallbackBook, quotaFallbackPolicy, quotaScopeKey,
  QUOTA_FALLBACK_METADATA_KEY, QUOTA_PROBE_LEASE_MS, readQuotaFallbackPin, record,
  type QuotaFallbackBook, type QuotaFallbackScope,
} from "./agent-quota-fallback-policy.js";

type AgentRow = typeof agents.$inferSelect;
type QuotaRun = { id: string; agentId: string; companyId: string; finishedAt?: Date | null; runnerProfileJson?: Record<string, unknown> | null; resultJson?: Record<string, unknown> | null; usageJson?: Record<string, unknown> | null };
export type PrimaryQuotaProbeResult = "available" | "unavailable" | "busy" | "error";

export interface AgentQuotaFallbackDependencies {
  clock?: () => Date;
  resolveIdentity?: (agent: AgentRow, responsibleUserId: string | null, sourceRunId: string | null) => Promise<QuotaProbeIdentity>;
  probePrimary: (agent: AgentRow, responsibleUserId: string | null, scope: QuotaFallbackScope, context: { sourceRunId: string | null; signal?: AbortSignal }) => Promise<PrimaryQuotaProbeResult>;
  canCheck?: (agent: AgentRow, responsibleUserId: string | null) => Promise<boolean>;
  onRecovered?: (agent: AgentRow, responsibleUserId: string | null, scope: QuotaFallbackScope, now: Date) => Promise<void>;
}

async function loadAgent(transaction: Db, agentId: string, lock = false): Promise<AgentRow | null> {
  const query = transaction.select().from(agents).where(eq(agents.id, agentId));
  return (await (lock ? query.for("update") : query).limit(1))[0] ?? null;
}

async function writeBook(transaction: Db, agent: AgentRow, book: QuotaFallbackBook) {
  await transaction.update(agents).set({
    metadata: sql`jsonb_set(case when jsonb_typeof(${agents.metadata}) = 'object' then ${agents.metadata} else '{}'::jsonb end, ARRAY[${QUOTA_FALLBACK_METADATA_KEY}], ${JSON.stringify(book)}::jsonb, true)`,
    updatedAt: agent.updatedAt,
  }).where(and(eq(agents.id, agent.id), eq(agents.companyId, agent.companyId)));
}

function primaryCheckDue(scope: QuotaFallbackScope, intervalSec: number, now: Date, monitorPrimary: boolean) {
  if (!scope.usingBackup && !monitorPrimary) return false;
  if (scope.nextPrimaryCheckAt) return Date.parse(scope.nextPrimaryCheckAt) <= now.getTime();
  if (scope.usingBackup) return false;
  return !scope.lastPrimaryCheckAt || Date.parse(scope.lastPrimaryCheckAt) + intervalSec * 1000 <= now.getTime();
}

export function agentQuotaFallbackService(db: Db, dependencies: AgentQuotaFallbackDependencies) {
  const clock = () => dependencies.clock?.() ?? new Date();
  const recoveryInFlight = new Set<string>();

  async function scopeForIdentity(agent: AgentRow, book: QuotaFallbackBook, user: string | null, identity?: QuotaProbeIdentity) {
    const key = quotaScopeKey(user, identity?.effectiveFingerprint);
    if (book.scopes[key]) return { key, scope: book.scopes[key]! };
    const legacyKey = quotaScopeKey(user), legacy = book.scopes[legacyKey];
    if (identity && legacy && !legacy.probeToken && legacy.primaryQuotaRunId) {
      try {
        const [original] = await db.select({ profile: heartbeatRuns.runnerProfileJson }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, legacy.primaryQuotaRunId), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.agentId, agent.id))).limit(1);
        const pinned = readQuotaFallbackPin(record(original?.profile).quotaFallback);
        if (pinned?.effectiveFingerprint === identity.effectiveFingerprint) {
          const scope = { ...legacy, effectiveFingerprint: identity.effectiveFingerprint, responsibleUserId: user, sourceRunId: identity.sourceRunId };
          delete book.scopes[legacyKey]; book.scopes[key] = scope;
          return { key, scope };
        }
      } catch { /* unknown legacy authority stays waiting */ }
    }
    return { key, scope: { ...initialQuotaScope(), ...(identity ? { effectiveFingerprint: identity.effectiveFingerprint, responsibleUserId: user, sourceRunId: identity.sourceRunId } : {}) } };
  }
  async function ensureScopeForRun(agentId: string, user: string | null, identity: QuotaProbeIdentity) {
    return db.transaction(async tx => {
      const agent = await loadAgent(tx as unknown as Db, agentId, true); if (!agent) return null;
      const book = quotaFallbackBook(agent); const legacy = book.scopes[quotaScopeKey(user)];
      const scoped = await scopeForIdentity(agent, book, user, identity);
      if (legacy && !book.scopes[quotaScopeKey(user)]) await writeBook(tx as unknown as Db, agent, book);
      return { agent: { ...agent, metadata: { ...agent.metadata, [QUOTA_FALLBACK_METADATA_KEY]: book } }, unknownLegacy: !!book.scopes[quotaScopeKey(user)]?.usingBackup && !book.scopes[scoped.key] };
    });
  }

  async function reconcileRecovery(agentId: string, responsibleUserId: string | null, scopeKey?: string) {
    const agent = await loadAgent(db, agentId);
    if (!agent || ["paused", "terminated", "pending_approval"].includes(agent.status)) return;
    if (dependencies.canCheck && !await dependencies.canCheck(agent, responsibleUserId)) return;
    const key = scopeKey ?? quotaScopeKey(responsibleUserId);
    const scope = quotaFallbackBook(agent).scopes[key];
    if (!scope?.recoveryToken || !scope.recoveryAt) return;
    const inFlightKey = `${agentId}:${key}:${scope.recoveryToken}`;
    if (recoveryInFlight.has(inFlightKey)) return;
    recoveryInFlight.add(inFlightKey);
    try {
      // Successor creation is idempotent by predecessor. Keep this durable
      // receipt until every continuation side effect has succeeded.
      await dependencies.onRecovered?.(agent, responsibleUserId, scope, new Date(scope.recoveryAt));
      await db.transaction(async tx => {
        const latest = await loadAgent(tx as unknown as Db, agentId, true); if (!latest) return;
        const book = quotaFallbackBook(latest); const current = book.scopes[key];
        if (current?.recoveryToken !== scope.recoveryToken) return;
        current.recoveryToken = null; current.recoveryAt = null;
        await writeBook(tx as unknown as Db, latest, book);
      });
    } finally { recoveryInFlight.delete(inFlightKey); }
  }
  async function registerQuotaFailure(run: QuotaRun, responsibleUserId: string | null, now: Date) {
    const initial = await loadAgent(db, run.agentId);
    if (!initial) return null;
    let identity: QuotaProbeIdentity | undefined;
    try { identity = await dependencies.resolveIdentity?.(initial, responsibleUserId, run.id); } catch { return null; }
    return db.transaction(async tx => {
      const agent = await loadAgent(tx as unknown as Db, run.agentId, true);
      if (!agent || agent.companyId !== run.companyId) return null;
      const policy = quotaFallbackPolicy(agent);
      if (!policy?.backup) return null;
      if (identity && (await dependencies.resolveIdentity?.(agent, responsibleUserId, run.id))?.effectiveFingerprint !== identity.effectiveFingerprint) return null;
      const book = quotaFallbackBook(agent);
      const { key, scope } = await scopeForIdentity(agent, book, responsibleUserId, identity);
      const pin = readQuotaFallbackPin(record(run.runnerProfileJson).quotaFallback);
      if (pin && pin.fingerprint !== book.fingerprint) return null;
      if (pin?.effectiveFingerprint && identity && pin.effectiveFingerprint !== identity.effectiveFingerprint) return null;
      const actualType = pin?.adapterType ?? record(record(run.runnerProfileJson).adapterDispatch).adapterType;
      const actualModel = pin?.model ?? record(run.usageJson).model ?? record(run.resultJson).model;
      const backupRun = pin?.usingBackup === true || (typeof actualType === "string" && actualType !== agent.adapterType);
      const failureAt = run.finishedAt ?? now;
      const newerFailure = !scope.lastQuotaAt || failureAt.getTime() >= Date.parse(scope.lastQuotaAt);
      const verifiedRecovery = policy.recoveryEnabled && scope.lastPrimaryCheckResult === "available" && scope.lastPrimaryCheckAt && (backupRun || Date.parse(scope.lastPrimaryCheckAt) >= failureAt.getTime());

      if (backupRun || verifiedRecovery) {
        if (backupRun && newerFailure) {
          scope.backupQuotaRunId = run.id;
          scope.lastQuotaAt = failureAt.toISOString();
          book.scopes[key] = scope;
          await writeBook(tx as unknown as Db, agent, book);
        }
        return !scope.usingBackup && verifiedRecovery ? {
          sourceRunId: run.id, adapterType: agent.adapterType,
          model: typeof agent.adapterConfig.model === "string" ? agent.adapterConfig.model : null,
          reason: "primary_recovered" as const,
        } : null;
      }
      if (typeof actualType === "string" && actualType !== agent.adapterType) return null;
      if (typeof actualModel === "string" && typeof agent.adapterConfig.model === "string" && actualModel !== agent.adapterConfig.model) return null;
      if (newerFailure) {
        const alreadyUsingBackup = scope.usingBackup;
        scope.usingBackup = true;
        scope.recoveryToken = null; scope.recoveryAt = null;
        scope.lastQuotaAt = failureAt.toISOString();
        scope.primaryQuotaRunId = run.id;
        scope.primaryCheckIntervalSec = policy.primaryCheckIntervalSec;
        if (!alreadyUsingBackup || !scope.nextPrimaryCheckAt) scope.nextPrimaryCheckAt = new Date(now.getTime() + policy.primaryCheckIntervalSec * 1000).toISOString();
        book.scopes[key] = scope;
        await writeBook(tx as unknown as Db, agent, book);
        if (!alreadyUsingBackup) await tx.insert(activityLog).values({ companyId: agent.companyId, agentId: agent.id, actorType: "system", actorId: "quota_fallback", action: "agent.quota_fallback.activated", entityType: "agent", entityId: agent.id, details: { responsibleUserId, sourceRunId: run.id, adapterType: policy.backup.adapterType, model: policy.backup.model } });
      }
      return { sourceRunId: run.id, adapterType: policy.backup.adapterType, model: policy.backup.model, reason: "primary_quota" as const };
    });
  }

  async function getStatus(agentId: string, responsibleUserId: string | null, now = new Date()): Promise<AgentQuotaFallbackStatus | null> {
    const agent = await loadAgent(db, agentId);
    if (!agent) return null;
    const policy = quotaFallbackPolicy(agent);
    const book = quotaFallbackBook(agent);
    const matching = Object.entries(book.scopes).filter(([key, scope]) => key === quotaScopeKey(responsibleUserId) || (scope.effectiveFingerprint && scope.responsibleUserId === responsibleUserId));
    const scope = policy ? matching.map(([, value]) => value).sort((a, b) => Number(b.usingBackup) - Number(a.usingBackup))[0] : null;
    return {
      enabled: !!policy, usingBackup: scope?.usingBackup === true,
      primaryAdapterType: agent.adapterType, primaryModel: typeof agent.adapterConfig.model === "string" ? agent.adapterConfig.model : null,
      backupAdapterType: policy?.backup?.adapterType ?? null, backupModel: policy?.backup?.model ?? null,
      lastQuotaAt: scope?.lastQuotaAt ?? null, lastPrimaryCheckAt: scope?.lastPrimaryCheckAt ?? null,
      lastPrimaryCheckResult: scope?.lastPrimaryCheckResult ?? null, nextPrimaryCheckAt: scope?.nextPrimaryCheckAt ?? null,
      checkingPrimary: matching.some(([, value]) => !!value.probeToken),
    };
  }

  async function checkPrimary(agentId: string, responsibleUserId: string | null, options: { now?: Date; force?: boolean; monitorPrimary?: boolean; sourceRunId?: string | null } = {}) {
    const now = options.now ?? clock();
    const agent = await loadAgent(db, agentId);
    const policy = agent ? quotaFallbackPolicy(agent) : null;
    if (!agent || !policy || ["paused", "terminated", "pending_approval"].includes(agent.status)) return getStatus(agentId, responsibleUserId, now);
    if (dependencies.canCheck && !await dependencies.canCheck(agent, responsibleUserId)) return getStatus(agentId, responsibleUserId, now);
    const existing = Object.values(quotaFallbackBook(agent).scopes).find(scope => scope.effectiveFingerprint && scope.responsibleUserId === responsibleUserId && scope.usingBackup);
    const sourceRunId = options.sourceRunId ?? existing?.sourceRunId ?? quotaFallbackBook(agent).scopes[quotaScopeKey(responsibleUserId)]?.primaryQuotaRunId ?? null;
    let identity: QuotaProbeIdentity | undefined;
    try { identity = await dependencies.resolveIdentity?.(agent, responsibleUserId, sourceRunId); } catch { return getStatus(agentId, responsibleUserId, now); }
    const { key, scope } = await scopeForIdentity(agent, quotaFallbackBook(agent), responsibleUserId, identity);
    if (Object.entries(quotaFallbackBook(agent).scopes).some(([scopeKey, value]) => value.probeToken && (scopeKey === quotaScopeKey(responsibleUserId) || (value.effectiveFingerprint && value.responsibleUserId === responsibleUserId)))) return getStatus(agentId, responsibleUserId, now);
    if (!options.force && (!policy.recoveryEnabled || !primaryCheckDue(scope, policy.primaryCheckIntervalSec, now, options.monitorPrimary === true))) return getStatus(agentId, responsibleUserId, now);
    if (scope.probeToken) return getStatus(agentId, responsibleUserId, clock());

    const claimed = await db.transaction(async tx => {
      // Capacity admission takes the instance lock before the Agent lock, just
      // like task admission; model requests run after this transaction commits.
      const admissionTime = clock();
      const capacity = await checkRunCapacity(tx as unknown as Db, agent, null, admissionTime);
      const latest = await loadAgent(tx as unknown as Db, agentId, true);
      if (!latest || ["paused", "terminated", "pending_approval"].includes(latest.status)) return null;
      const book = quotaFallbackBook(latest);
      if (book.fingerprint !== quotaFallbackBook(agent).fingerprint) return null;
      if (Object.entries(book.scopes).some(([scopeKey, value]) => value.probeToken && (scopeKey === quotaScopeKey(responsibleUserId) || (value.effectiveFingerprint && value.responsibleUserId === responsibleUserId)))) return null;
      const current = (await scopeForIdentity(latest, book, responsibleUserId, identity)).scope;
      if (current.probeToken) return null;
      if (!options.force && !primaryCheckDue(current, policy.primaryCheckIntervalSec, admissionTime, options.monitorPrimary === true)) return null;
      if (!capacity.allowed) {
        current.lastPrimaryCheckResult = "busy";
        current.nextPrimaryCheckAt = new Date(admissionTime.getTime() + 60_000).toISOString();
        book.scopes[key] = current; await writeBook(tx as unknown as Db, latest, book);
        return null;
      }
      current.probeToken = randomUUID(); current.probeGroup = capacity.group;
      current.probeFingerprint = book.fingerprint;
      current.probeUntil = new Date(admissionTime.getTime() + QUOTA_PROBE_LEASE_MS).toISOString();
      book.scopes[key] = current; await writeBook(tx as unknown as Db, latest, book);
      return { token: current.probeToken, fingerprint: book.fingerprint };
    });
    if (!claimed) return getStatus(agentId, responsibleUserId, now);

    let result: PrimaryQuotaProbeResult = "error";
    const controller = new AbortController();
    const deadline = setTimeout(() => controller.abort(), QUOTA_PROBE_LEASE_MS); deadline.unref?.();
    try { result = await dependencies.probePrimary(agent, responsibleUserId, scope, { sourceRunId: sourceRunId ?? scope.primaryQuotaRunId, signal: controller.signal }); } catch { result = "error"; }
    finally { clearTimeout(deadline); }
    if (controller.signal.aborted) result = "error";
    let currentIdentity: QuotaProbeIdentity | undefined;
    try { const refreshed = await loadAgent(db, agentId); if (refreshed) currentIdentity = await dependencies.resolveIdentity?.(refreshed, responsibleUserId, sourceRunId); } catch { /* unknown current identity cannot recover */ }
    const finishedAt = clock();
    const recovered = await db.transaction(async tx => {
      const latest = await loadAgent(tx as unknown as Db, agentId, true);
      if (!latest) return null;
      const book = quotaFallbackBook(latest);
      const current = book.scopes[key];
      if (!current || current.probeToken !== claimed.token) return null;
      current.probeToken = null; current.probeUntil = null; current.probeGroup = null; current.probeFingerprint = null;
      const latestPolicy = quotaFallbackPolicy(latest);
      if (book.fingerprint !== claimed.fingerprint || !latestPolicy || (identity && currentIdentity?.effectiveFingerprint !== identity.effectiveFingerprint)) {
        book.scopes[key] = current; await writeBook(tx as unknown as Db, latest, book); return null;
      }
      const wasUsingBackup = current.usingBackup;
      current.lastPrimaryCheckAt = finishedAt.toISOString(); current.lastPrimaryCheckResult = result;
      if (result === "unavailable" && latestPolicy.backup && !wasUsingBackup) {
        current.usingBackup = true;
        current.primaryCheckIntervalSec = latestPolicy.primaryCheckIntervalSec;
        current.recoveryToken = null; current.recoveryAt = null;
        await tx.insert(activityLog).values({
          companyId: latest.companyId, agentId: latest.id,
          actorType: "system", actorId: "primary_availability_probe",
          action: "agent.quota_fallback.activated", entityType: "agent", entityId: latest.id,
          details: {
            responsibleUserId, reason: "primary_probe_unavailable",
            adapterType: latestPolicy.backup.adapterType, model: latestPolicy.backup.model,
          },
        });
      }
      if (result === "available" && latestPolicy.recoveryEnabled) current.usingBackup = false;
      if (wasUsingBackup && !current.usingBackup) {
        current.recoveryToken = randomUUID(); current.recoveryAt = finishedAt.toISOString();
        await tx.insert(activityLog).values({ companyId: latest.companyId, agentId: latest.id, actorType: "system", actorId: "quota_fallback", action: "agent.quota_fallback.primary_recovered", entityType: "agent", entityId: latest.id, details: { responsibleUserId, adapterType: latest.adapterType, model: latest.adapterConfig.model ?? null } });
      }
      current.nextPrimaryCheckAt = current.usingBackup && latestPolicy.recoveryEnabled
        ? new Date(finishedAt.getTime() + latestPolicy.primaryCheckIntervalSec * 1000).toISOString() : null;
      book.scopes[key] = current; await writeBook(tx as unknown as Db, latest, book);
      return wasUsingBackup && !current.usingBackup ? { agent: latest, scope: { ...current } } : null;
    });
    if (recovered) await reconcileRecovery(agentId, responsibleUserId, key);
    return getStatus(agentId, responsibleUserId, finishedAt);
  }

  async function tick(now = new Date()) {
    const rows = await db.select({ ...getTableColumns(agents) }).from(agents).innerJoin(companies, eq(companies.id, agents.companyId))
      .where(and(eq(companies.status, "active"), inArray(agents.status, ["idle", "running", "error", "active"])));
    let checked = 0;
    for (const agent of rows) {
      const policy = quotaFallbackPolicy(agent);
      if (!policy) continue;
      const activeRuns = await db.select({ id: heartbeatRuns.id, responsibleUserId: heartbeatRuns.responsibleUserId })
        .from(heartbeatRuns).where(and(eq(heartbeatRuns.agentId, agent.id), eq(heartbeatRuns.companyId, agent.companyId), eq(heartbeatRuns.status, "running")))
        .orderBy(desc(heartbeatRuns.startedAt), desc(heartbeatRuns.createdAt));
      const activeScopes = new Map<string, { sourceId: string; userId: string | null }>();
      for (const run of activeRuns) {
        let identity: QuotaProbeIdentity | undefined;
        try { identity = await dependencies.resolveIdentity?.(agent, run.responsibleUserId, run.id); } catch { continue; }
        const key = quotaScopeKey(run.responsibleUserId, identity?.effectiveFingerprint);
        if (!activeScopes.has(key)) activeScopes.set(key, { sourceId: run.id, userId: run.responsibleUserId });
      }
      const scopes = quotaFallbackBook(agent).scopes;
      const keys = new Set([...Object.keys(scopes), ...activeScopes.keys()]);
      for (const key of keys) {
        if (key.startsWith("__backup_test__:")) continue;
        const scope = scopes[key] ?? initialQuotaScope();
        const userId = scope.effectiveFingerprint ? scope.responsibleUserId ?? null : activeScopes.get(key)?.userId ?? (key === "__unattributed__" ? null : key);
        try {
          if (scope.recoveryToken) await reconcileRecovery(agent.id, userId, key);
          const sourceRunId = activeScopes.get(key)?.sourceId ?? scope.sourceRunId ?? undefined;
          if (!policy.recoveryEnabled || !primaryCheckDue(scope, policy.primaryCheckIntervalSec, now, sourceRunId !== undefined)) continue;
          await checkPrimary(agent.id, userId, { monitorPrimary: sourceRunId !== undefined, sourceRunId }); checked += 1;
        } catch (error) {
          logger.warn({ code: "quota_recovery_pending", agentId: agent.id, companyId: agent.companyId }, "primary quota recovery remains pending");
        }
      }
    }
    return { checked };
  }

  /** Standalone backup connection tests share provider slots, not coding slots. */
  async function withProbeSlot<T>(agentId: string, responsibleUserId: string | null, effectiveAgent: AgentRow, callback: () => Promise<T>): Promise<{ busy: true } | { busy: false; result: T }> {
    const now = clock();
    const primary = await loadAgent(db, agentId);
    if (!primary || ["paused", "terminated", "pending_approval"].includes(primary.status) || (dependencies.canCheck && !await dependencies.canCheck(primary, responsibleUserId))) return { busy: true };
    const key = `__backup_test__:${quotaScopeKey(responsibleUserId)}`;
    const token = await db.transaction(async tx => {
      const capacity = await checkRunCapacity(tx as unknown as Db, effectiveAgent, null, now);
      if (!capacity.allowed) return null;
      const latest = await loadAgent(tx as unknown as Db, agentId, true);
      if (!latest || ["paused", "terminated", "pending_approval"].includes(latest.status)) return null;
      const book = quotaFallbackBook(latest);
      const current = book.scopes[key] ?? initialQuotaScope();
      if (current.probeToken) return null;
      current.probeToken = randomUUID(); current.probeFingerprint = book.fingerprint;
      current.probeUntil = new Date(now.getTime() + QUOTA_PROBE_LEASE_MS).toISOString(); current.probeGroup = capacity.group;
      book.scopes[key] = current; await writeBook(tx as unknown as Db, latest, book);
      return current.probeToken;
    });
    if (!token) return { busy: true };
    try { return { busy: false, result: await callback() }; }
    finally {
      await db.transaction(async tx => {
        const latest = await loadAgent(tx as unknown as Db, agentId, true); if (!latest) return;
        const book = quotaFallbackBook(latest); const current = book.scopes[key];
        if (!current || current.probeToken !== token) return;
        delete book.scopes[key]; await writeBook(tx as unknown as Db, latest, book);
      });
    }
  }

  return { registerQuotaFailure, getStatus, checkPrimary, tick, withProbeSlot, ensureScopeForRun };
}
