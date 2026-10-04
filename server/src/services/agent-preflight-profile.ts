import { createHash } from "node:crypto";
import { heartbeatRuns, type Db } from "@paperclipai/db";
import { and, eq, sql } from "drizzle-orm";
import type { AgentPreflightProfile } from "@paperclipai/shared";
import { enforceAgentSafetyPreset } from "@paperclipai/shared";
import { effectiveCodexLocalReasoningEffort } from "@paperclipai/adapter-codex-local";

export const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const string = (value: unknown) => typeof value === "string" && value.trim() ? value.trim() : null;
export function preflightProfile(input: { adapterType: string; config: Record<string, unknown>; runtimeConfig: unknown; cwd?: string | null; projectId?: string | null; target: string; source: AgentPreflightProfile["source"] }): AgentPreflightProfile {
  const config = enforceAgentSafetyPreset(input.adapterType, input.runtimeConfig, input.config);
  const model = string(config.model);
  const configuredEffort = string(config.modelReasoningEffort) ?? string(config.reasoningEffort);
  return { source: input.source, adapterType: input.adapterType, cwd: Object.hasOwn(input, "cwd") ? input.cwd ?? null : string(config.cwd), projectId: input.projectId ?? null, target: input.target,
    sandbox: config.dangerouslyBypassApprovalsAndSandbox || config.dangerouslyBypassSandbox ? "danger-full-access" : string(config.sandboxMode) ?? (input.adapterType === "codex_local" ? "workspace-write" : null),
    model, effort: input.adapterType === "codex_local" ? effectiveCodexLocalReasoningEffort(model, configuredEffort) || null : configuredEffort };
}
export function preflightDigest(value: unknown): string { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }

export async function freezeGovernedStdioProfile(db: Db, input: { runId: string; companyId: string; agentId: string; profile: AgentPreflightProfile }): Promise<void> {
  const payload = { version: 1, runId: input.runId, companyId: input.companyId, agentId: input.agentId, ...input.profile };
  const encoded = JSON.stringify(payload);
  const rows = await db.update(heartbeatRuns).set({ runnerProfileJson: sql`coalesce(${heartbeatRuns.runnerProfileJson}, '{}'::jsonb) || ${JSON.stringify({ governedStdioV1: payload })}::jsonb` })
    .where(and(eq(heartbeatRuns.id, input.runId), eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.agentId, input.agentId), eq(heartbeatRuns.status, "running"),
      sql`(${heartbeatRuns.runnerProfileJson}->'governedStdioV1' is null or ${heartbeatRuns.runnerProfileJson}->'governedStdioV1' = ${encoded}::jsonb)`))
    .returning({ id: heartbeatRuns.id });
  if (!rows.length) throw new Error("Governed stdio profile changed or its registered run is no longer active.");
}
