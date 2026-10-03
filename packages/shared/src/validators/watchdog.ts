import { z } from "zod";

const stopFingerprint = z.string().regex(/^task_watchdog_stop:[a-f0-9]{64}$/);
export const recoveryMutationSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("set_status"), issueId: z.string().uuid(), status: z.enum(["todo", "in_progress", "in_review", "blocked"]) }).strict(),
  z.object({ kind: z.literal("comment"), issueId: z.string().uuid(), body: z.string().trim().min(1).max(10_000) }).strict(),
  z.object({ kind: z.literal("set_blockers"), issueId: z.string().uuid(), blockerIssueIds: z.array(z.string().uuid()).max(100) }).strict(),
]);

export const recoveryBatchSchema = z.object({
  requestId: z.string().uuid(),
  watchdogRunId: z.string().uuid(),
  expectedStopFingerprint: stopFingerprint,
  mutations: z.array(recoveryMutationSchema).min(1).max(3),
}).strict();

export const watchdogDispositionSchema = z.object({
  requestId: z.string().uuid(),
  watchdogRunId: z.string().uuid(),
  expectedStopFingerprint: stopFingerprint,
  disposition: z.enum(["legitimate_stop", "restoration_claimed"]),
  evidence: z.string().trim().min(1).max(10_000),
}).strict();

export type WatchdogDispositionInput = z.infer<typeof watchdogDispositionSchema>;
