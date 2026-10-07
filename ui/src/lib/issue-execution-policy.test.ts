import { afterEach, describe, expect, it, vi } from "vitest";
import { issueExecutionPolicySchema } from "@paperclipai/shared";
import { buildExecutionPolicy } from "./issue-execution-policy";

const AGENT_ID = "00000000-0000-4000-8000-000000000001";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("buildExecutionPolicy", () => {
  it("declares requested report paths with the named reviewer and preserves lifetime limits", () => {
    const policy = buildExecutionPolicy({ existingPolicy: { mode: "normal", commentRequired: true, stages: [], resourceLimits: { maxAutomaticRuns: 1 } },
      reviewerValues: ["user:local-board"], approverValues: [], reportPaths: "reports/REPORT.md\n\n reports/REPORT.json " });
    expect(policy?.reportDelivery).toEqual({ version: 1, files: ["reports/REPORT.md", "reports/REPORT.json"] });
    expect(policy?.stages[0].participants[0]).toMatchObject({ type: "user", userId: "local-board" });
    expect(policy?.resourceLimits).toEqual({ maxAutomaticRuns: 1 });
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
  });
  it.each([
    { reportPaths: "reports/REPORT.md", reviewerValues: [] },
    { reportPaths: "", reviewerValues: ["user:local-board"] },
    { reportPaths: "../REPORT.md", reviewerValues: ["user:local-board"] },
    { reportPaths: "reports/REPORT.md\nreports/REPORT.md", reviewerValues: ["user:local-board"] },
    { reportPaths: "reports/REPORT.md", reviewerValues: [`agent:${AGENT_ID}`], reporterAgentId: AGENT_ID },
  ])("rejects report-only creation without a valid output/review contract", input => {
    expect(() => buildExecutionPolicy({ ...input, approverValues: [] })).toThrow();
  });
  it("preserves output and resource contracts when editing review participants", () => {
    const reportDelivery = { version: 1 as const, files: ["reports/REPORT.md"] };
    const policy = buildExecutionPolicy({ existingPolicy: { mode: "normal", commentRequired: true,
      stages: [], reportDelivery, resourceLimits: { maxNoProgressRuns: 1 } }, reviewerValues: ["user:local-board"], approverValues: [] });
    expect(policy?.reportDelivery).toEqual(reportDelivery);
    expect(policy?.resourceLimits).toEqual({ maxNoProgressRuns: 1 });
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("generates schema-valid UUIDs when crypto.randomUUID is unavailable", () => {
    vi.stubGlobal("crypto", {
      getRandomValues: (bytes: Uint8Array) => {
        for (let index = 0; index < bytes.length; index += 1) {
          bytes[index] = index;
        }
        return bytes;
      },
    });

    const policy = buildExecutionPolicy({
      existingPolicy: null,
      reviewerValues: [`agent:${AGENT_ID}`],
      approverValues: ["user:local-board"],
    });

    expect(policy).not.toBeNull();
    expect(issueExecutionPolicySchema.safeParse(policy).success).toBe(true);
    expect(policy?.stages).toHaveLength(2);

    for (const stage of policy?.stages ?? []) {
      expect(stage.id).toMatch(UUID_PATTERN);
      expect(stage.participants).toHaveLength(1);
      expect(stage.participants[0]?.id).toMatch(UUID_PATTERN);
    }
  });
});
