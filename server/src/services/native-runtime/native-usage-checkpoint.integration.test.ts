import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { agents, companies, createDb, heartbeatRuns, issues, nativeRunFinalizations } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../../__tests__/helpers/embedded-postgres.js";
import { appendHeartbeatRunEvent } from "../heartbeat-run-events.js";
import { projectNativeUsageCheckpoint, notifyNativeUsageCheckpoint } from "./native-usage-checkpoint.js";

it("projects canonical durable usage once and retains highwater after restart/replay", async () => {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-token-checkpoint-"); const db = createDb(temporary.connectionString);
  try {
    const binding = { runId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID() };
    await db.insert(companies).values({ id: binding.companyId, name: "Native usage", issuePrefix: "NU" });
    await db.insert(agents).values({ id: binding.agentId, companyId: binding.companyId, name: "Native", role: "engineer", status: "running", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: binding.issueId, companyId: binding.companyId, title: "Native usage" });
    await db.insert(heartbeatRuns).values({ id: binding.runId, companyId: binding.companyId, agentId: binding.agentId, nativeIssueId: binding.issueId, runtimeMode: "native", status: "running", invocationSource: "assignment", resultJson: { unrelated: "preserve" } });
    await db.insert(nativeRunFinalizations).values({ runId: binding.runId, companyId: binding.companyId, issueId: binding.issueId, phase: "executing", attempt: 1 });
    const append = async (seq: number, tokens: number, outputTokens: number | null = 10) => {
      const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(), normalizedSessionId: "fixture-session", turnId: "fixture-turn", runId: binding.runId, sourceKind: "runner", sourceInstanceId: "fixture-source", sourceEventId: `usage-${seq}`, sourceSeq: seq, eventType: "usage.reported", payload: { runDelta: { inputTokens: tokens, outputTokens, cacheReadTokens: 5 } } };
      await appendHeartbeatRunEvent(db, { ...binding, eventType: event.eventType, payload: { prpEvent: event }, nativeSource: { ...event, protocolSchemaVersion: 1, canonicalPayload: event } });
    };
    await append(1, 100);
    expect(await projectNativeUsageCheckpoint(db, binding, "usage-1", { kind: "codex" })).toMatchObject({ totalTokens: 110, needsNotification: true });
    expect(await projectNativeUsageCheckpoint(db, binding, "usage-1", { kind: "codex" })).toMatchObject({ totalTokens: 110 });
    await append(2, 130);
    expect(await projectNativeUsageCheckpoint(db, binding, "usage-2", { kind: "codex" })).toMatchObject({ totalTokens: 140 });
    const [row] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
    expect(row?.resultJson?.unrelated).toBe("preserve"); expect(row?.usageJson?.totalTokens).toBe(140);
    const notifications: number[] = [];
    const observer = async (value: { totalTokens?: number }) => { notifications.push(value.totalTokens!); return { stopReason: "resource_run_token_limit" }; };
    expect(await notifyNativeUsageCheckpoint(db, binding, "usage-2", { kind: "codex" }, observer)).toMatchObject({ totalTokens: 140, stopReason: "resource_run_token_limit" });
    await notifyNativeUsageCheckpoint(db, binding, "usage-2", { kind: "codex" }, observer);
    expect(notifications).toEqual([140]);
    await append(3, 150);
    await expect(notifyNativeUsageCheckpoint(db, binding, "usage-3", { kind: "codex" }, async () => { throw new Error("observer interrupted"); })).rejects.toThrow("observer interrupted");
    expect(await notifyNativeUsageCheckpoint(db, binding, "usage-3", { kind: "codex" }, observer)).toMatchObject({ totalTokens: 160 });
    expect(notifications).toEqual([140, 160]);
    expect(await projectNativeUsageCheckpoint(db, { ...binding, companyId: randomUUID() }, "usage-2", { kind: "codex" })).toBeNull();
    expect(await projectNativeUsageCheckpoint(db, binding, "not-durable", { kind: "codex" })).toBeNull();
    expect(await projectNativeUsageCheckpoint(db, { ...binding, sourceInstanceId: "other-owner" }, "usage-3", { kind: "codex" })).toBeNull();
    expect(await projectNativeUsageCheckpoint(db, { ...binding, sessionId: "other-session" }, "usage-3", { kind: "codex" })).toBeNull();
    await db.update(nativeRunFinalizations).set({ attempt: 2 }).where(eq(nativeRunFinalizations.runId, binding.runId));
    await append(4, 200, null);
    expect(await projectNativeUsageCheckpoint(db, binding, "usage-4", { kind: "codex" })).toMatchObject({ usageUnknown: true, totalTokens: undefined });
    await db.update(nativeRunFinalizations).set({ attempt: 3 }).where(eq(nativeRunFinalizations.runId, binding.runId));
    await append(5, 50);
    expect(await projectNativeUsageCheckpoint(db, binding, "usage-5", { kind: "codex" })).toMatchObject({ usageUnknown: true, totalTokens: undefined });
  } finally { await temporary.cleanup(); }
}, 20_000);

it("sums distinct ACP turns within one attempt, deduplicates each turn and retains unknown earlier turns", async () => {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-acp-turn-usage-"); const db = createDb(temporary.connectionString);
  try {
    const binding = { runId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID() };
    await db.insert(companies).values({ id: binding.companyId, name: "ACP usage", issuePrefix: "AT" });
    await db.insert(agents).values({ id: binding.agentId, companyId: binding.companyId, name: "ACP", role: "engineer", status: "running", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: binding.issueId, companyId: binding.companyId, title: "Continuous goal" });
    await db.insert(heartbeatRuns).values({ id: binding.runId, companyId: binding.companyId, agentId: binding.agentId, nativeIssueId: binding.issueId, runtimeMode: "native", status: "running", invocationSource: "assignment" });
    await db.insert(nativeRunFinalizations).values({ runId: binding.runId, companyId: binding.companyId, issueId: binding.issueId, phase: "executing", attempt: 1 });
    const provider = { kind: "acpx", agent: "claude" };
    const totals: Array<number | undefined> = [];
    const observer = async (value: { totalTokens?: number }) => { totals.push(value.totalTokens); return value.totalTokens !== undefined && value.totalTokens >= 150 ? { stopReason: "resource_run_token_limit" } : undefined; };
    let sourceSeq = 0;
    let activeProviderTurnId: string | null | undefined;
    const report = async (seq: number, providerTurnId: string | null, input = 20, complete = true) => {
      const common = { schema: "paperclip.prp.event.v1", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(), normalizedSessionId: "continuous-session", turnId: "immutable-controller-turn", runId: binding.runId, sourceKind: "runner", sourceInstanceId: "continuous-source" };
      if (providerTurnId !== activeProviderTurnId) {
        activeProviderTurnId = providerTurnId;
        const started = { ...common, sourceEventId: `turn-start-${++sourceSeq}`, sourceSeq, eventType: "turn.started", payload: { provider: "acpx", providerTurnId, status: "inProgress" } };
        await appendHeartbeatRunEvent(db, { ...binding, eventType: started.eventType, payload: { prpEvent: started }, nativeSource: { ...started, protocolSchemaVersion: 1, canonicalPayload: started } });
      }
      const event = { ...common, sourceEventId: `turn-usage-${seq}`, sourceSeq: ++sourceSeq, eventType: "usage.reported", payload: { provider: "acpx", runDeltaAvailable: complete, runDelta: { inputTokens: input, ...(complete ? { outputTokens: 20 } : {}), cacheReadTokens: 20, cacheWriteTokens: 20 } } };
      await appendHeartbeatRunEvent(db, { ...binding, eventType: event.eventType, payload: { prpEvent: event }, nativeSource: { ...event, protocolSchemaVersion: 1, canonicalPayload: event } });
      return notifyNativeUsageCheckpoint(db, binding, event.sourceEventId, provider, observer);
    };
    expect(await report(1, "turn-a")).toMatchObject({ totalTokens: 80, usageUnknown: false });
    await notifyNativeUsageCheckpoint(db, binding, "turn-usage-1", provider, observer);
    expect(totals).toEqual([80]);
    expect(await report(2, "turn-a", 10)).toMatchObject({ totalTokens: 80 });
    expect(await report(3, "turn-b")).toMatchObject({ totalTokens: 160, stopReason: "resource_run_token_limit" });
    expect(totals).toEqual([80, 80, 160]);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
    expect(run?.usageJson?.totalTokens).toBe(160);
    expect(await report(4, "turn-unknown", 20, false)).toMatchObject({ totalTokens: undefined, usageUnknown: true });
    expect(await report(5, "turn-unknown")).toMatchObject({ totalTokens: 240, usageUnknown: false });
    expect(await report(6, "turn-incomplete", 20, false)).toMatchObject({ totalTokens: undefined, usageUnknown: true });
    expect(await report(7, "turn-later")).toMatchObject({ totalTokens: undefined, usageUnknown: true });
    expect(await report(8, null)).toMatchObject({ totalTokens: undefined, usageUnknown: true });
    expect(await report(9, "")).toMatchObject({ totalTokens: undefined, usageUnknown: true });
  } finally { await temporary.cleanup(); }
}, 20_000);

it("downgrades a legacy ACP attempt checkpoint on replay and notifies unknown usage once", async () => {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-native-acp-legacy-usage-"); const db = createDb(temporary.connectionString);
  try {
    const binding = { runId: randomUUID(), companyId: randomUUID(), agentId: randomUUID(), issueId: randomUUID() };
    await db.insert(companies).values({ id: binding.companyId, name: "Legacy ACP", issuePrefix: "LA" });
    await db.insert(agents).values({ id: binding.agentId, companyId: binding.companyId, name: "ACP", role: "engineer", status: "running", adapterType: "paperclip_runner" });
    await db.insert(issues).values({ id: binding.issueId, companyId: binding.companyId, title: "Legacy usage" });
    await db.insert(heartbeatRuns).values({ id: binding.runId, companyId: binding.companyId, agentId: binding.agentId, nativeIssueId: binding.issueId, runtimeMode: "native", status: "running", invocationSource: "assignment", resultJson: { nativeUsageCheckpoint: { version: 1, seq: 1, notifiedSeq: 1, attempts: { 1: 80 }, totalTokens: 80, usageUnknown: false } } });
    await db.insert(nativeRunFinalizations).values({ runId: binding.runId, companyId: binding.companyId, issueId: binding.issueId, phase: "executing", attempt: 1 });
    const event = { schema: "paperclip.prp.event.v1", schemaVersion: 1, priority: 1, emittedAt: new Date().toISOString(), normalizedSessionId: "legacy-session", turnId: "turn-a", runId: binding.runId, sourceKind: "runner", sourceInstanceId: "legacy-source", sourceEventId: "legacy-usage", sourceSeq: 1, eventType: "usage.reported", payload: { provider: "acpx", runDelta: { inputTokens: 20, outputTokens: 20, cacheReadTokens: 20, cacheWriteTokens: 20 } } };
    await appendHeartbeatRunEvent(db, { ...binding, eventType: event.eventType, payload: { prpEvent: event }, nativeSource: { ...event, protocolSchemaVersion: 1, canonicalPayload: event } });
    let notifications = 0;
    const observer = async () => { notifications += 1; return { stopReason: "resource_run_token_usage_unknown" }; };
    expect(await notifyNativeUsageCheckpoint(db, binding, event.sourceEventId, { kind: "acpx", agent: "claude" }, observer)).toMatchObject({ totalTokens: undefined, usageUnknown: true, stopReason: "resource_run_token_usage_unknown" });
    await notifyNativeUsageCheckpoint(db, binding, event.sourceEventId, { kind: "acpx", agent: "claude" }, observer);
    expect(notifications).toBe(1);
    const [run] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, binding.runId));
    expect(run?.usageJson?.totalTokens).toBeNull();
    expect(run?.resultJson?.nativeUsageCheckpoint).toMatchObject({ accountingBasis: "provider_turn", unknownAttempts: { legacy: true } });
  } finally { await temporary.cleanup(); }
}, 20_000);
