import { z } from "zod";

const tokenLimit = z.number().int().positive().max(2147483647).nullable().optional();
export const issueResourceLimitsSchema = z.object({
  maxTokensPerIssue: tokenLimit,
  maxTokensPerRun: tokenLimit,
  maxAutomaticRuns: z.number().int().positive().max(10000).nullable().optional(),
  maxNoProgressRuns: z.number().int().positive().max(20).nullable().optional(),
  maxRunSeconds: z.number().int().positive().max(604800).nullable().optional(),
}).strict();
export type IssueResourceLimits = z.infer<typeof issueResourceLimitsSchema>;
