import { describe, expect, it } from "vitest";
import { deliveryPolicySchema } from "./delivery.js";
const id = "11111111-1111-4111-8111-111111111111";
const engineeringEvidence = { version: 1, sourceScope: { projectId: id, executionWorkspaceId: id, files: [
  { path: "src/main.ts", role: "implementation" }, { path: "test/main.ts", role: "test" }, { path: "vitest.config.ts", role: "harness" }, { path: "package.json", role: "manifest" },
]}, requiredJobs: [{ id: "test", role: "test" }, { id: "verify", role: "verifier" }] };
describe("engineering delivery contract", () => {
  it("accepts the strict versioned Board scope on verified delivery", () => {
    expect(deliveryPolicySchema.safeParse({ version: 1, mode: "verified_delivery", engineeringEvidence }).success).toBe(true);
  });
  it.each([
    { ...engineeringEvidence, passed: true },
    { ...engineeringEvidence, sourceScope: { ...engineeringEvidence.sourceScope, files: [{ path: "../secret", role: "implementation" }] } },
    { ...engineeringEvidence, requiredJobs: [{ id: "test", role: "test" }] },
  ])("refuses claims, incomplete scope or absent semantic verifier", (policy) => {
    expect(deliveryPolicySchema.safeParse({ version: 1, mode: "verified_delivery", engineeringEvidence: policy }).success).toBe(false);
  });
  it("cannot opt engineering evidence into ordinary claim policy", () => {
    expect(deliveryPolicySchema.safeParse({ version: 1, mode: "agent_claim_policy", engineeringEvidence }).success).toBe(false);
  });
});
