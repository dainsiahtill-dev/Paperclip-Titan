import { z } from "zod";
import { issueWorkProductTypeSchema } from "./work-product.js";

export const deliveryCriterionSchema = z.object({
  id: z.string().trim().min(1).max(160),
  requirement: z.string().trim().min(1).max(4_000),
  artifactType: issueWorkProductTypeSchema.optional(),
  scope: z.enum(["issue", "subtree"]).optional().default("issue"),
}).strict();

export const deliveryPolicySchema = z.object({
  version: z.literal(1),
  mode: z.enum(["agent_claim_policy", "verified_delivery"]),
  criteria: z.array(deliveryCriterionSchema).max(32).optional(),
  reviewerAgentIds: z.array(z.string().uuid()).max(32).optional().default([]),
  managerAgentIds: z.array(z.string().uuid()).max(32).optional().default([]),
}).strict().superRefine((value, ctx) => {
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
