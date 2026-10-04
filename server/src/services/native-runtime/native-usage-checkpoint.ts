import { and, desc, eq, lt, sql } from "drizzle-orm";
import { heartbeatRuns, heartbeatRunEvents, nativeRunFinalizations, type Db } from "@paperclipai/db";
import { nativeSha256 } from "./canonical.js";
import { normalizeNativeUsage } from "./native-usage-normalization.js";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
export type NativeUsageBinding = { runId: string; companyId: string; agentId: string; issueId: string; sourceInstanceId?: string; sessionId?: string };
export interface NativeUsageCheckpoint { totalTokens?: number; seq: number; needsNotification: boolean; usageUnknown: boolean; stopReason?: string }

/** PRP turnId is controller correlation; only a bound start proves the ACP call. */
export async function readNativeAcpxTurnProof(db: Db, binding: NativeUsageBinding, beforeSeq?: number, controllerTurnId?: string | null) {
  if (!binding.sourceInstanceId || !binding.sessionId) return null;
  const [row] = await db.select().from(heartbeatRunEvents).where(and(
    eq(heartbeatRunEvents.runId, binding.runId), eq(heartbeatRunEvents.companyId, binding.companyId), eq(heartbeatRunEvents.agentId, binding.agentId), eq(heartbeatRunEvents.eventType, "turn.started"), eq(heartbeatRunEvents.sourceInstanceId, binding.sourceInstanceId),
    sql`${heartbeatRunEvents.payload}->'prpEvent'->>'normalizedSessionId' = ${binding.sessionId}`,
    controllerTurnId ? sql`${heartbeatRunEvents.payload}->'prpEvent'->>'turnId' = ${controllerTurnId}` : undefined,
    beforeSeq === undefined ? undefined : lt(heartbeatRunEvents.seq, beforeSeq),
  )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  if (!row || !row.sourcePayloadSha256) return null;
  const event = record(row.payload?.prpEvent), payload = record(event.payload);
  if (event.eventType !== "turn.started" || event.sourceKind !== "runner" || event.runId !== binding.runId || event.sourceEventId !== row.sourceEventId || event.sourceInstanceId !== binding.sourceInstanceId || nativeSha256(event) !== row.sourcePayloadSha256 || (payload.provider !== undefined && payload.provider !== "acpx")) return null;
  const providerTurnId = typeof payload.providerTurnId === "string" && payload.providerTurnId.length > 0 && payload.providerTurnId.length <= 240 ? payload.providerTurnId : null;
  return providerTurnId ? { providerTurnId, sourceEventId: row.sourceEventId!, seq: row.seq } : null;
}

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
    const migrateAcpx = provider.kind === "acpx" && previous.version === 1 && previous.accountingBasis !== "provider_turn";
    if (row.seq <= priorSeq && !migrateAcpx) return { seq: priorSeq, totalTokens: typeof previous.totalTokens === "number" ? previous.totalTokens : undefined, usageUnknown: previous.usageUnknown === true, needsNotification: notifiedSeq < priorSeq, stopReason: typeof previous.stopReason === "string" ? previous.stopReason : undefined };
    const [owner] = await tx.select({ attempt: nativeRunFinalizations.attempt }).from(nativeRunFinalizations).where(and(eq(nativeRunFinalizations.runId, binding.runId), eq(nativeRunFinalizations.companyId, binding.companyId), eq(nativeRunFinalizations.issueId, binding.issueId))).limit(1);
    if (!owner || owner.attempt < 1) return null;
    const payload = record(event.payload), usage = normalizeNativeUsage(record(payload.usage ?? payload), provider);
    const attempts = { ...record(previous.attempts) };
    const unknownAttempts = { ...record(previous.unknownAttempts) };
    const key = String(owner.attempt), prior = Number(attempts[key] ?? 0);
    if (owner.attempt > 1 && previous.version !== 1) unknownAttempts.prior = true;
    let currentTurn: { attempt: number; providerTurnId: string | null; startSourceEventId: string | null; totalTokens: number | null; usageUnknown: boolean } | undefined;
    if (provider.kind === "acpx") {
      // ACP breakdowns are per turn. Retain bounded server metadata on the
      // durable event, then aggregate there rather than growing run JSON by turn.
      const proof = await readNativeAcpxTurnProof(tx as unknown as Db, { ...binding, sourceInstanceId: row.sourceInstanceId, sessionId: typeof event.normalizedSessionId === "string" ? event.normalizedSessionId : undefined }, row.seq, typeof event.turnId === "string" ? event.turnId : null);
      const providerTurnId = proof?.providerTurnId ?? null;
      const projection = { version: 1, provider: "acpx", attempt: owner.attempt, providerTurnId, startSourceEventId: proof?.sourceEventId ?? null, totalTokens: providerTurnId ? usage?.totalTokens ?? null : null, usageUnknown: !providerTurnId || usage?.totalTokens === undefined };
      await tx.update(heartbeatRunEvents).set({ payload: sql`jsonb_set(${heartbeatRunEvents.payload}, '{nativeUsageProjection}', ${JSON.stringify(projection)}::jsonb, true)` }).where(eq(heartbeatRunEvents.id, row.id));
      const scope = and(eq(heartbeatRunEvents.runId, binding.runId), eq(heartbeatRunEvents.companyId, binding.companyId), eq(heartbeatRunEvents.agentId, binding.agentId), eq(heartbeatRunEvents.eventType, "usage.reported"), sql`${heartbeatRunEvents.payload}->'prpEvent'->>'sourceKind' = 'runner'`);
      const metadata = sql`${heartbeatRunEvents.payload}->'nativeUsageProjection'`;
      const attemptValue = sql<number>`(${metadata}->>'attempt')::int`;
      const turnValue = sql<string>`${metadata}->>'providerTurnId'`;
      const perTurn = tx.select({
        attempt: attemptValue.as("attempt"), turnId: turnValue.as("turn_id"),
        totalTokens: sql<number | null>`max(case when jsonb_typeof(${metadata}->'totalTokens') = 'number' then (${metadata}->>'totalTokens')::numeric else null end)::double precision`.as("turn_total"),
        usageUnknown: sql<boolean>`coalesce(max(${heartbeatRunEvents.seq}) filter (where ${metadata}->>'usageUnknown' = 'true'), 0) > coalesce(max(${heartbeatRunEvents.seq}) filter (where ${metadata}->>'usageUnknown' = 'false'), 0)`.as("turn_unknown"),
      }).from(heartbeatRunEvents).where(and(scope, sql`${metadata}->>'version' = '1' and ${metadata}->>'provider' = 'acpx'`)).groupBy(attemptValue, turnValue).as("native_acpx_turn_usage");
      const totals = await tx.select({ attempt: perTurn.attempt, totalTokens: sql<number>`coalesce(sum(${perTurn.totalTokens}), 0)::double precision`, usageUnknown: sql<boolean>`bool_or(${perTurn.usageUnknown})` }).from(perTurn).groupBy(perTurn.attempt);
      for (const value of totals) {
        const attemptKey = String(value.attempt);
        attempts[attemptKey] = value.totalTokens;
        if (value.usageUnknown || !Number.isSafeInteger(value.totalTokens)) unknownAttempts[attemptKey] = true;
        else delete unknownAttempts[attemptKey];
      }
      const [unprojected] = await tx.select({ count: sql<number>`count(*)::int` }).from(heartbeatRunEvents).where(and(scope, sql`((${metadata}->>'version') is distinct from '1' or (${metadata}->>'provider') is distinct from 'acpx')`));
      if (unprojected?.count || migrateAcpx) unknownAttempts.legacy = true;
      const [turn] = providerTurnId ? await tx.select().from(perTurn).where(and(eq(perTurn.attempt, owner.attempt), eq(perTurn.turnId, providerTurnId))).limit(1) : [];
      currentTurn = { attempt: owner.attempt, providerTurnId, startSourceEventId: proof?.sourceEventId ?? null, totalTokens: turn?.totalTokens ?? null, usageUnknown: turn?.usageUnknown ?? true };
    } else {
      if (usage?.totalTokens === undefined) unknownAttempts[key] = true;
      else { attempts[key] = Math.max(prior, usage.totalTokens); delete unknownAttempts[key]; }
    }
    const sum = Object.values(attempts).reduce<number>((total, value) => total + (typeof value === "number" ? value : 0), 0);
    const usageUnknown = Object.keys(unknownAttempts).length > 0 || !Number.isSafeInteger(sum);
    const totalTokens = usageUnknown ? undefined : sum;
    const seq = Math.max(priorSeq, row.seq), nextNotifiedSeq = migrateAcpx ? Math.min(notifiedSeq, seq - 1) : notifiedSeq;
    const checkpoint = { version: 1, seq, notifiedSeq: nextNotifiedSeq, accountingBasis: provider.kind === "acpx" ? "provider_turn" : "attempt", attempts, unknownAttempts, ...(currentTurn ? { currentTurn } : {}), totalTokens: totalTokens ?? null, usageUnknown, ...(typeof previous.stopReason === "string" ? { stopReason: previous.stopReason } : {}) };
    await tx.update(heartbeatRuns).set({
      usageJson: sql`(case when jsonb_typeof(${heartbeatRuns.usageJson}) = 'object' then ${heartbeatRuns.usageJson} else '{}'::jsonb end) || ${JSON.stringify({ ...usage, totalTokens: totalTokens ?? null })}::jsonb`,
      resultJson: sql`jsonb_set(case when jsonb_typeof(${heartbeatRuns.resultJson}) = 'object' then ${heartbeatRuns.resultJson} else '{}'::jsonb end, '{nativeUsageCheckpoint}', ${JSON.stringify(checkpoint)}::jsonb, true)`,
    }).where(eq(heartbeatRuns.id, binding.runId));
    return { totalTokens, seq, needsNotification: nextNotifiedSeq < seq, usageUnknown, stopReason: typeof previous.stopReason === "string" ? previous.stopReason : undefined };
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
