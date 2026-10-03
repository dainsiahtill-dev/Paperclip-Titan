import { compareQueuedCandidates } from "./queued-run-fairness.js";
import { createRunDispatch } from "../modules/run-dispatch/index.js";
import { getExecutionBlocker } from "./execution-blocker.js";
import { agents, heartbeatRuns, instanceSettings, companies, issues, type Db } from "@paperclipai/db";
import { agentConcurrencySettingsSchema, DEFAULT_AGENT_CONCURRENCY } from "@paperclipai/shared";
import { and, asc, eq, gt, inArray, isNotNull, isNull, or, sql } from "drizzle-orm";
import { deriveQuotaProbeIdentity } from "./quota-probe-identity.js";
import { activeQuotaProbeReservations, quotaFallbackPolicy, selectQuotaFallbackAgent } from "./agent-quota-fallback-policy.js";

type AgentRow = typeof agents.$inferSelect;

export type RunCapacityAdmission =
  | { allowed: true; group: string | null }
  | { allowed: false; reason: string };

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function runtimeGroup(runtimeConfig: unknown): string | null {
  const raw = record(record(runtimeConfig).heartbeat).concurrencyGroup;
  return typeof raw === "string" && raw.trim() ? raw.trim() : null;
}

function configuredCapacity(general: unknown) {
  const raw = record(general).agentConcurrency ?? DEFAULT_AGENT_CONCURRENCY;
  const parsed = agentConcurrencySettingsSchema.safeParse(raw);
  if (!parsed.success) throw new Error("Invalid stored Agent concurrency settings");
  return parsed.data;
}

function runningGroup(row: {
  capacityGroup: string | null;
  runtimeConfig: unknown;
}): string | null {
  return row.capacityGroup === null
    ? runtimeGroup(row.runtimeConfig)
    : row.capacityGroup || null;
}

async function waiting(transaction: Db, runId: string, reason: string): Promise<RunCapacityAdmission> {
  await transaction.update(heartbeatRuns).set({
    executionStage: "waiting_capacity",
    resultJson: sql`(case when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object' then ${heartbeatRuns.resultJson} else '{}'::jsonb end) || ${JSON.stringify({ capacityWait: { reason } })}::jsonb`,
  }).where(and(eq(heartbeatRuns.id, runId), eq(heartbeatRuns.status, "queued")));
  return { allowed: false, reason };
}

/**
 * Must run in the same transaction as queued-to-running. Locking the singleton
 * settings row serializes capacity admission across controllers and companies.
 */
export async function admitQueuedRunCapacity(
  transaction: Db,
  agent: AgentRow,
  runId: string,
  maxAgentRuns: number,
): Promise<RunCapacityAdmission> {
  const result = await checkRunCapacity(transaction, agent, maxAgentRuns);
  if (!result.allowed) return waiting(transaction, runId, result.reason);
  const [settings] = await transaction.select({ general: instanceSettings.general }).from(instanceSettings).where(eq(instanceSettings.singletonKey, "default")).limit(1);
  const capacity = configuredCapacity(settings?.general);
  if (capacity.maxActiveRuns === null && result.group === null) return result;
  // The singleton capacity lock is still held. All invocation, completion and
  // sweep entrances therefore validate the same current eligible winner.
  const dispatcher = createRunDispatch(transaction);
  let cursor: string | null = null;
  let winner: { id: string; agentId: string; createdAt: Date; lastAdmittedAt: Date | null; ready: boolean; status: string | null; priority: string | null } | null = null;
  for (;;) {
    const candidates = await transaction.select({ run: heartbeatRuns, candidateAgent: agents, issueStatus: issues.status, issuePriority: issues.priority,
      lastAdmittedAt: sql<Date | null>`(select max(started_at) from heartbeat_runs history where history.agent_id = ${agents.id})`,
      reserved: sql<number>`(select count(*)::int from heartbeat_runs owner where owner.agent_id = ${agents.id} and (owner.status = 'running' or (owner.capacity_group is not null and owner.capacity_released_at is null)))`,
    }).from(heartbeatRuns).innerJoin(agents, eq(agents.id, heartbeatRuns.agentId)).innerJoin(companies, eq(companies.id, agents.companyId))
      .leftJoin(issues, and(eq(issues.companyId, heartbeatRuns.companyId), sql`${issues.id}::text = ${heartbeatRuns.contextSnapshot}->>'issueId'`))
      .where(and(eq(heartbeatRuns.status, "queued"), eq(companies.status, "active"), inArray(agents.status, ["idle", "running", "active", "error"]), cursor ? gt(heartbeatRuns.id, cursor) : undefined))
      .orderBy(asc(heartbeatRuns.id)).limit(50);
    if (!candidates.length) break;
    for (const candidate of candidates) {
      if (candidate.issueStatus === "blocked") continue;
      const issueId = record(candidate.run.contextSnapshot).issueId;
      if (typeof issueId === "string" && await getExecutionBlocker(transaction, candidate.run.companyId, issueId)) continue;
      const max = Number(record(record(candidate.candidateAgent.runtimeConfig).heartbeat).maxConcurrentRuns ?? 1);
      if (candidate.reserved >= Math.max(1, max)) continue;
      let effective = candidate.candidateAgent;
      if (effective.id === agent.id) effective = agent;
      else if (quotaFallbackPolicy(effective)) {
        try {
          const identity = await deriveQuotaProbeIdentity(transaction, effective, candidate.run.responsibleUserId, candidate.run.id);
          effective = selectQuotaFallbackAgent(effective, candidate.run.responsibleUserId, undefined, identity.effectiveFingerprint).agent;
        } catch { continue; }
      }
      if (runtimeGroup(effective.runtimeConfig) !== result.group && capacity.maxActiveRuns === null) continue;
      const next = { id: candidate.run.id, agentId: candidate.run.agentId, createdAt: candidate.run.createdAt, lastAdmittedAt: candidate.lastAdmittedAt ? new Date(candidate.lastAdmittedAt) : null, ready: true, status: candidate.issueStatus, priority: candidate.issuePriority };
      if (winner && compareQueuedCandidates(next, winner, new Date()) >= 0) continue;
      if (!(await checkRunCapacity(transaction, effective, Math.max(1, max))).allowed) continue;
      const gate = await dispatcher.evaluateScheduledRetryGate({ runId: candidate.run.id, companyId: candidate.run.companyId, retryReasonOverride: candidate.run.scheduledRetryReason ?? "bounded_transient_retry" });
      if (!gate.allowed) continue;
      winner = next;
    }
    cursor = candidates.at(-1)!.run.id;
  }
  if (winner && winner.id !== runId) return waiting(transaction, runId, "Waiting for another ready Agent's fair turn in the shared pool");
  return result;
}

/** Caller reserves its task/probe under this same capacity lock before commit. */
export async function checkRunCapacity(
  transaction: Db,
  agent: AgentRow,
  maxAgentRuns: number | null,
  now = new Date(),
): Promise<RunCapacityAdmission> {
  const group = runtimeGroup(agent.runtimeConfig);
  const rawGroup = record(record(agent.runtimeConfig).heartbeat).concurrencyGroup;
  if (rawGroup != null && rawGroup !== "" && (typeof rawGroup !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(group ?? ""))) {
    return { allowed: false, reason: "Invalid Agent concurrency group; choose a configured group" };
  }

  const [initialRow] = await transaction
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .limit(1);
  if (!initialRow) {
    await transaction.insert(instanceSettings).values({}).onConflictDoNothing();
  }

  const [lockedRow] = await transaction
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .for("update")
    .limit(1);
  const capacity = configuredCapacity(lockedRow?.general);
  const reserved = await transaction
    .select({
      agentId: heartbeatRuns.agentId,
      capacityGroup: heartbeatRuns.capacityGroup,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(or(
      eq(heartbeatRuns.status, "running"),
      and(isNotNull(heartbeatRuns.capacityGroup), isNull(heartbeatRuns.capacityReleasedAt)),
    ));
  const agentRunning = reserved.filter((row) => row.agentId === agent.id).length;
  if (maxAgentRuns !== null && agentRunning >= maxAgentRuns) {
    return { allowed: false, reason: `Waiting for Agent slot (${agentRunning}/${maxAgentRuns})` };
  }
  const pool = group === null ? null : capacity.groups.find((entry) => entry.name === group);
  if (group !== null && !pool) {
    const reason = `Concurrency group "${group}" has no configured limit`;
    return { allowed: false, reason };
  }
  if (capacity.maxActiveRuns === null && pool === null) return { allowed: true, group };
  const probeRows = await transaction.select({ metadata: agents.metadata }).from(agents)
    .where(sql`${agents.metadata} ? 'quotaFallbackState'`);
  const probes = probeRows.flatMap(row => activeQuotaProbeReservations(row.metadata, now));
  const totalRunning = reserved.length + probes.length;
  const groupRunning = group === null
    ? 0
    : reserved.filter((row) => runningGroup(row) === group).length + probes.filter(probe => probe.group === group).length;
  const reason = capacity.maxActiveRuns !== null && totalRunning >= capacity.maxActiveRuns
    ? `Waiting for an instance Agent slot (${totalRunning}/${capacity.maxActiveRuns})`
    : pool && groupRunning >= pool.maxActiveRuns
      ? `Waiting for concurrency group "${group}" (${groupRunning}/${pool.maxActiveRuns})`
      : null;
  if (reason) {
    return { allowed: false, reason };
  }
  return { allowed: true, group };
}
