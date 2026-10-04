// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DeliveryAssessment } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { IssueDeliveryAssessment } from "./IssueDeliveryAssessment";

vi.mock("../api/issues", () => ({ issuesApi: { getDeliveryAssessment: vi.fn(), recordDeliveryDecision: vi.fn() } }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let container: HTMLDivElement, root: Root, client: QueryClient;
const assessment: DeliveryAssessment = { version: 1, mode: "verified_delivery", contractId: "contract", contractRevision: 2, contractHash: "contract-hash", canComplete: false, reviewerAgentIds: [], permissions: { canReview: true, canManagePolicy: true }, criteria: [{ id: "api", requirement: "API rejects invalid status", criterionDigest: "criterion-hash", state: "missing", workProductId: "product", materialVersion: "2", contentDigest: "content-hash", decisionId: null, reason: null }] };
beforeEach(() => {
  vi.clearAllMocks();
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  vi.mocked(issuesApi.getDeliveryAssessment).mockResolvedValue(assessment);
  vi.mocked(issuesApi.recordDeliveryDecision).mockResolvedValue({});
});
afterEach(() => { act(() => root.unmount()); client.clear(); container.remove(); });
async function render() { act(() => { root.render(<QueryClientProvider client={client}><IssueDeliveryAssessment issueId="issue" /></QueryClientProvider>); }); await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); }
describe("issue delivery review", () => {
  it("submits the current server content and criterion pins, then refreshes authority", async () => {
    await render();
    const button = [...container.querySelectorAll("button")].find((node) => node.textContent === "验收通过");
    expect(button).toBeDefined();
    await act(async () => { button!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(issuesApi.recordDeliveryDecision).toHaveBeenCalledWith("issue", expect.objectContaining({ requestId: expect.any(String), criterionId: "api", workProductId: "product", expectedContractHash: "contract-hash", expectedCriterionDigest: "criterion-hash", expectedMaterialVersion: "2", expectedContentDigest: "content-hash", verdict: "accepted" }));
    expect(issuesApi.getDeliveryAssessment).toHaveBeenCalledTimes(2);
  });
  it("uses server permissions and keeps a stale-content rejection visible", async () => {
    vi.mocked(issuesApi.getDeliveryAssessment).mockResolvedValue({ ...assessment, permissions: { canReview: false, canManagePolicy: false } });
    await render();
    expect(container.textContent).toContain("等待评审");
    expect(container.querySelector("button")).toBeNull();
  });
  it("surfaces failed decisions and offers a fresh assessment", async () => {
    vi.mocked(issuesApi.recordDeliveryDecision).mockRejectedValue(new Error("Current artifact changed"));
    await render();
    await act(async () => { [...container.querySelectorAll("button")].find((node) => node.textContent === "验收通过")!.click(); await new Promise((resolve) => setTimeout(resolve, 20)); });
    expect(container.querySelector('[role="alert"]')?.textContent).toContain("Current artifact changed");
    expect(issuesApi.getDeliveryAssessment).toHaveBeenCalledTimes(2);
  });
  it("does not add review controls to ordinary tasks", async () => {
    vi.mocked(issuesApi.getDeliveryAssessment).mockResolvedValue({ ...assessment, mode: "agent_claim_policy" });
    await render();
    expect(container.textContent).toBe("");
  });
});
