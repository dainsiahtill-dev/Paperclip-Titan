import { agents, heartbeatRuns, instanceSettings, type Db } from "@paperclipai/db";
import { agentConcurrencySettingsSchema, DEFAULT_AGENT_CONCURRENCY } from "@paperclipai/shared";
import { and, eq, sql } from "drizzle-orm";

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
): Promise<RunCapacityAdmission> {
  const group = runtimeGroup(agent.runtimeConfig);
  const rawGroup = record(record(agent.runtimeConfig).heartbeat).concurrencyGroup;
  if (rawGroup != null && rawGroup !== "" && (typeof rawGroup !== "string" || !/^[a-z][a-z0-9_-]{0,31}$/.test(group ?? ""))) {
    return waiting(transaction, runId, "Invalid Agent concurrency group; choose a configured group");
  }

  const [initialRow] = await transaction
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .limit(1);
  const initial = configuredCapacity(initialRow?.general);
  if (initial.maxActiveRuns === null && initial.groups.length === 0 && group === null) {
    return { allowed: true, group: null };
  }

  const [lockedRow] = await transaction
    .select({ general: instanceSettings.general })
    .from(instanceSettings)
    .where(eq(instanceSettings.singletonKey, "default"))
    .for("update")
    .limit(1);
  const capacity = configuredCapacity(lockedRow?.general);
  const pool = group === null ? null : capacity.groups.find((entry) => entry.name === group);
  if (group !== null && !pool) {
    const reason = `Concurrency group "${group}" has no configured limit`;
    return waiting(transaction, runId, reason);
  }
  if (capacity.maxActiveRuns === null && pool === null) return { allowed: true, group };

  const running = await transaction
    .select({
      capacityGroup: heartbeatRuns.capacityGroup,
      runtimeConfig: agents.runtimeConfig,
    })
    .from(heartbeatRuns)
    .innerJoin(agents, eq(agents.id, heartbeatRuns.agentId))
    .where(eq(heartbeatRuns.status, "running"));
  const groupRunning = group === null
    ? 0
    : running.filter((row) => runningGroup(row) === group).length;
  const reason = capacity.maxActiveRuns !== null && running.length >= capacity.maxActiveRuns
    ? `Waiting for an instance Agent slot (${running.length}/${capacity.maxActiveRuns})`
    : pool && groupRunning >= pool.maxActiveRuns
      ? `Waiting for concurrency group "${group}" (${groupRunning}/${pool.maxActiveRuns})`
      : null;
  if (reason) {
    return waiting(transaction, runId, reason);
  }
  return { allowed: true, group };
}
