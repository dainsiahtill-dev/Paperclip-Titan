import { z } from "zod";
import { issueWorkProductTypeSchema } from "./work-product.js";

export const deliveryCriterionSchema = z.object({
  id: z.string().trim().min(1).max(160),
  requirement: z.string().trim().min(1).max(4_000),
  artifactType: issueWorkProductTypeSchema.optional(),
  scope: z.enum(["issue", "subtree"]).optional().default("issue"),
}).strict();

const sourceFileSchema = z.object({
  path: z.string().min(1).max(500).refine(value => !value.startsWith("/") && !value.includes("\\") && !value.split("/").some(part => !part || part === "." || part === ".."), "Explicit workspace-relative file required"),
  role: z.enum(["implementation", "test", "harness", "manifest"]),
}).strict();
export const engineeringEvidencePolicySchema = z.object({
  version: z.literal(1),
  sourceScope: z.object({ projectId: z.string().uuid(), executionWorkspaceId: z.string().uuid(), files: z.array(sourceFileSchema).min(4).max(128) }).strict(),
  requiredJobs: z.array(z.object({ id: z.string().trim().min(1).max(160), role: z.enum(["test", "build", "verifier"]) }).strict()).min(2).max(16),
}).strict().superRefine((value, ctx) => {
  for (const role of ["implementation", "test", "harness", "manifest"]) if (!value.sourceScope.files.some(file => file.role === role)) ctx.addIssue({ code: "custom", message: `Source scope needs ${role} files` });
  for (const role of ["test", "verifier"]) if (!value.requiredJobs.some(job => job.role === role)) ctx.addIssue({ code: "custom", message: `Required jobs need ${role} role` });
  if (new Set(value.sourceScope.files.map(file => file.path)).size !== value.sourceScope.files.length) ctx.addIssue({ code: "custom", message: "Source paths must be unique" });
  if (new Set(value.requiredJobs.map(job => job.id)).size !== value.requiredJobs.length) ctx.addIssue({ code: "custom", message: "Job IDs must be unique" });
});
export const engineeringBundleSchema = z.object({
  version: z.literal(1),
  executionWorkspaceId: z.string().uuid(),
  operationIds: z.array(z.string().uuid()).min(2).max(16),
  unresolvedLimits: z.string().max(4000),
}).strict();

export const deliveryPolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["agent_claim_policy", "verified_delivery"]),
  criteria: z.array(deliveryCriterionSchema).max(32).optional(),
  engineeringEvidence: engineeringEvidencePolicySchema.optional(),
  reviewerAgentIds: z.array(z.string().uuid()).max(32).optional().default([]),
  managerAgentIds: z.array(z.string().uuid()).max(32).optional().default([]),
}).strict().superRefine((value, ctx) => {
  if (value.engineeringEvidence && value.mode !== "verified_delivery") ctx.addIssue({ code: "custom", message: "Engineering evidence requires verified_delivery" });
  if (value.criteria && new Set(value.criteria.map((criterion) => criterion.id)).size !== value.criteria.length) ctx.addIssue({ code: "custom", path: ["criteria"], message: "Delivery criterion IDs must be unique" });
});

const digest = z.string().regex(/^[a-f0-9]{64}$/);
export const deliveryDecisionSchema = z.object({
  requestId: z.string().uuid(), criterionId: z.string().trim().min(1).max(160), workProductId: z.string().uuid(),
  expectedContractHash: digest, expectedCriterionDigest: digest,
  expectedMaterialVersion: z.string().min(1).max(200), expectedContentDigest: digest,
  verdict: z.enum(["accepted", "rejected"]), reason: z.string().trim().min(1).max(4_000),
  reviewInteractionId: z.string().uuid().nullable().optional(),
}).strict();
