// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { DeliveryAssessment } from "@paperclipai/shared/types/delivery";
import { DeliveryAssessmentPanel } from "./DeliveryAssessmentPanel";
let root: Root | null = null; let host: HTMLDivElement | null = null;
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); root=null; host=null; });
const assessment: DeliveryAssessment = { version: 1, mode: "verified_delivery", contractId: "contract", contractRevision: 2, contractHash: "a".repeat(64), canComplete: false, reviewerAgentIds: [], permissions: { canReview: true, canManagePolicy: true }, criteria: [{ id: "login", requirement: "登录后的主要流程可用", criterionDigest: "b".repeat(64), state: "stale", workProductId: "product", materialVersion: "2", contentDigest: "c".repeat(64), decisionId: null, reason: null }] };
async function render(value=assessment, onDecision=vi.fn(), error?:string) { host=document.createElement("div"); document.body.append(host); root=createRoot(host); await act(async()=>root!.render(<DeliveryAssessmentPanel assessment={value} onDecision={onDecision} error={error}/>)); return { host:host!,onDecision }; }
describe("DeliveryAssessmentPanel", () => {
  it("shows criterion changes and asks for independent acceptance without treating display status as evidence", async () => {
    const { host }=await render(); expect(host.textContent).toContain("内容或条件已变更"); expect(host.textContent).toContain("登录后的主要流程可用"); expect(host.textContent).toContain("独立验收"); expect(host.textContent).not.toContain("aaaaaaaa");
  });
  it("uses server permission metadata before offering verdict actions", async () => {
    const { host }=await render({ ...assessment, permissions: { canReview:false, canManagePolicy:false } }); expect(host.querySelector("button")).toBeNull();
  });
  it("disables acceptance for unverified engineering evidence and shows the remedy", async () => {
    const { host } = await render({ ...assessment, criteria: [{ ...assessment.criteria[0]!, engineeringEvidence: { verified: false, reason: "Source has an undrained managed writer; retry after it stops." } }] });
    const accept = [...host.querySelectorAll("button")].find(button => button.textContent === "验收通过");
    expect(accept?.disabled).toBe(true);
    expect(host.textContent).toContain("retry after it stops");
  });
  it("keeps a server denial visible as an actionable inline error", async () => {
    const { host }=await render(assessment,vi.fn(),"当前执行者不能验收自己的产物，请交给指定 QA。"); expect(host.querySelector('[role="alert"]')?.textContent).toContain("指定 QA");
  });
});
