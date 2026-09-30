import { z } from "zod";
import { aiConnectionBindingSchema } from "./ai-connections.js";

export const quotaFallbackBackupSchema = z.object({
  adapterType: z.enum(["claude_local", "codex_local"]),
  model: z.string().trim().min(1).max(200),
  thinkingEffort: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
  fastMode: z.boolean().optional(),
  concurrencyGroup: z.string().trim().regex(/^(?:[a-z][a-z0-9_-]{0,31})?$/).optional(),
  aiConnection: aiConnectionBindingSchema.optional(),
}).strict();

export const agentQuotaFallbackConfigSchema = z.object({
  enabled: z.boolean().default(false),
  backup: quotaFallbackBackupSchema.optional(),
  recoveryEnabled: z.boolean().default(true),
  primaryCheckIntervalSec: z.number().int().min(60).max(86400).default(900),
}).strict().superRefine((value, ctx) => {
  if (value.enabled && !value.backup) ctx.addIssue({ code: "custom", path: ["backup"], message: "Configure a backup model before enabling quota fallback" });
});

export type QuotaFallbackBackup = z.infer<typeof quotaFallbackBackupSchema>;
export type AgentQuotaFallbackConfig = z.infer<typeof agentQuotaFallbackConfigSchema>;

export interface AgentQuotaFallbackStatus {
  enabled: boolean;
  usingBackup: boolean;
  primaryAdapterType: string;
  primaryModel: string | null;
  backupAdapterType: string | null;
  backupModel: string | null;
  lastQuotaAt: string | null;
  lastPrimaryCheckAt: string | null;
  lastPrimaryCheckResult: "available" | "unavailable" | "busy" | "error" | null;
  nextPrimaryCheckAt: string | null;
  checkingPrimary: boolean;
}
