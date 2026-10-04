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
