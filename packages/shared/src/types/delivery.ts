import type { IssueWorkProductType } from "./work-product.js";

export type DeliveryMode = "agent_claim_policy" | "verified_delivery";
export interface DeliveryCriterion {
  id: string;
  requirement: string;
  artifactType?: IssueWorkProductType;
  scope?: "issue" | "subtree";
}
export interface DeliveryPolicy {
  version: 1;
  mode: DeliveryMode;
  criteria?: DeliveryCriterion[];
  reviewerAgentIds?: string[];
  managerAgentIds?: string[];
}
export interface DeliveryDecisionInput {
  requestId: string;
  criterionId: string;
  workProductId: string;
  expectedContractHash: string;
  expectedCriterionDigest: string;
  expectedMaterialVersion: string;
  expectedContentDigest: string;
  verdict: "accepted" | "rejected";
  reason: string;
  reviewInteractionId?: string | null;
}
export interface DeliveryCriterionAssessment extends DeliveryCriterion {
  criterionDigest: string;
  state: "accepted" | "rejected" | "missing" | "stale";
  workProductId: string | null;
  workProductIssueId?: string | null;
  materialVersion: string | null;
  contentDigest: string | null;
  decisionId: string | null;
  reason: string | null;
  provenance?: { decisionId: string; actorType: string; actorId: string; agentId: string | null; runId: string | null; createdAt: string; reviewerName?: string | null } | null;
}
export interface DeliveryAssessment {
  version: 1;
  mode: DeliveryMode;
  contractId: string;
  contractRevision: number;
  contractHash: string;
  criteria: DeliveryCriterionAssessment[];
  canComplete: boolean;
  reviewerAgentIds: string[];
  permissions?: { canReview: boolean; canManagePolicy: boolean };
}
