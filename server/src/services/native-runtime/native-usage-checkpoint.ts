import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, heartbeatRunEvents, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { normalizeNativeUsage } from "./native-usage-normalization.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type NativeUsageBinding = { runId: string; companyId: string; agentId: string; issueId: string; sourceInstanceId?: string; sessionId?: string };
export interface NativeUsageCheckpoint { totalTokens?: number; seq: number; needsNotification: boolean; usageUnknown: boolean; stopReason?: string }

/** Read the durable, server-bound PRP row; caller payloads cannot mint usage. */
export async function projectNativeUsageCheckpoint(db: Db, binding: NativeUsageBinding, sourceEventId: string, provider: { kind: string; agent?: string }): Promise<NativeUsageCheckpoint | null> {
  return db.transaction(async tx => {
    const [run] = await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.runtimeMode, "native"), eq(heartbeatRuns.status, "running"))).for("update").limit(1);
    if (!run) return null;
    const [row] = await tx.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, binding.runId), eq(heartbeatRunEvents.companyId, binding.companyId), eq(heartbeatRunEvents.agentId, binding.agentId), eq(heartbeatRunEvents.sourceEventId, sourceEventId), eq(heartbeatRunEvents.eventType, "usage.reported"))).limit(1);
    if (!row || !row.sourceInstanceId || !row.sourcePayloadSha256) return null;
    const event = record(row.payload?.prpEvent);
    if (event.eventType !== "usage.reported" || event.runId !== binding.runId || event.sourceKind !== "runner" || event.sourceEventId !== row.sourceEventId || event.sourceInstanceId !== row.sourceInstanceId || nativeSha256(event) !== row.sourcePayloadSha256 || (binding.sourceInstanceId && row.sourceInstanceId !== binding.sourceInstanceId) || (binding.sessionId && event.normalizedSessionId !== binding.sessionId)) return null;
    const previous = record(run.resultJson?.nativeUsageCheckpoint);
    const priorSeq = Number(previous.seq ?? 0), notifiedSeq = Number(previous.notifiedSeq ?? 0);
    if (row.seq <= priorSeq) return { seq: priorSeq, totalTokens: typeof previous.totalTokens === "number" ? previous.totalTokens : undefined, usageUnknown: previous.usageUnknown === true, needsNotification: notifiedSeq < priorSeq, stopReason: typeof previous.stopReason === "string" ? previous.stopReason : undefined };
    const [owner] = await tx.select({ attempt: nativeRunFinalizations.attempt }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId))).limit(1);
    if (!owner || owner.attempt < 1) return null;
    const payload = record(event.payload), usage = normalizeNativeUsage(record(payload.usage ?? payload), provider);
    const attempts = { ...record(previous.attempts) };
    const unknownAttempts = { ...record(previous.unknownAttempts) };
    const key = String(owner.attempt), prior = Number(attempts[key] ?? 0);
    if (owner.attempt > 1 && previous.version !== 1) unknownAttempts.prior = true;
    if (usage?.totalTokens === undefined) unknownAttempts[key] = true;
    else { attempts[key] = Math.max(prior, usage.totalTokens); delete unknownAttempts[key]; }
    const usageUnknown = Object.keys(unknownAttempts).length > 0;
    const sum = Object.values(attempts).reduce<number>((total, value) => total + (typeof value === "number" ? value : 0), 0);
    const totalTokens = usageUnknown ? undefined : sum;
    const checkpoint = { version: 1, seq: row.seq, notifiedSeq, attempts, unknownAttempts, totalTokens: totalTokens ?? null, usageUnknown, ...(typeof previous.stopReason === "string" ? { stopReason: previous.stopReason } : {}) };
    await tx.update(heartbeatRuns).set({
      usageJson: sql`(case when jsonb_typeof(${heartbeatRuns.usageJson}) = 'object' then ${heartbeatRuns.usageJson} else '{}'::jsonb end) || ${JSON.stringify({ ...usage, totalTokens: totalTokens ?? null })}::jsonb`,
      resultJson: sql`jsonb_set(case when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object' then ${heartbeatRuns.resultJson} else '{}'::jsonb end, '{nativeUsageCheckpoint}', ${JSON.stringify(checkpoint)}::jsonb, true)`,
    }).where(eq(heartbeatRuns.id, binding.runId));
    return { totalTokens, seq: row.seq, needsNotification: notifiedSeq < row.seq, usageUnknown, stopReason: typeof previous.stopReason === "string" ? previous.stopReason : undefined };
  });
}

/** Callback completion is separate from projection so replay can finish a crash window. */
export async function acknowledgeNativeUsageCheckpoint(db: Db, binding: NativeUsageBinding, seq: number, stopReason?: string) {
  await db.transaction(async tx => {
    const [run] = await tx.select({ result: heartbeatRuns.resultJson }).from(heartbeatRuns).where(and(eq(heartbeatRuns.id, binding.runId), eq(heartbeatRuns.companyId, binding.companyId), eq(heartbeatRuns.agentId, binding.agentId), eq(heartbeatRuns.nativeIssueId, binding.issueId), eq(heartbeatRuns.runtimeMode, "native"))).for("update").limit(1);
    if (!run) return;
    const checkpoint = record(run.result?.nativeUsageCheckpoint);
    if (checkpoint.version !== 1) return;
    checkpoint.notifiedSeq = Math.max(Number(checkpoint.notifiedSeq ?? 0), seq);
    if (stopReason) checkpoint.stopReason = stopReason;
    await tx.update(heartbeatRuns).set({ resultJson: sql`jsonb_set(${heartbeatRuns.resultJson}, '{nativeUsageCheckpoint}', ${JSON.stringify(checkpoint)}::jsonb, true)` }).where(eq(heartbeatRuns.id, binding.runId));
  });
}

export async function notifyNativeUsageCheckpoint(db: Db, binding: NativeUsageBinding, sourceEventId: string, provider: { kind: string; agent?: string }, observer: (checkpoint: NativeUsageCheckpoint) => Promise<{ stopReason?: string } | void>) {
  const checkpoint = await projectNativeUsageCheckpoint(db, binding, sourceEventId, provider);
  if (!checkpoint || !checkpoint.needsNotification) return checkpoint;
  const response = await observer(checkpoint);
  const stopReason = checkpoint.stopReason ?? response?.stopReason;
  await acknowledgeNativeUsageCheckpoint(db, binding, checkpoint.seq, stopReason);
  return { ...checkpoint, needsNotification: false, stopReason };
}
