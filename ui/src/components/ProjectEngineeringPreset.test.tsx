// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { ProjectEngineeringPreset } from "./ProjectEngineeringPreset";
import type { DeliveryPolicy } from "@paperclipai/shared/types/delivery";
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
let host: HTMLDivElement, root: Root;
afterEach(async () => { await act(async () => root?.unmount()); host?.remove(); });
const projectId = "11111111-1111-4111-8111-111111111111", workspaceId = "22222222-2222-4222-8222-222222222222";
async function render(policy: DeliveryPolicy | null, onSave = vi.fn().mockResolvedValue({})) {
  host = document.createElement("div"); document.body.append(host); root = createRoot(host);
  await act(async () => root.render(<ProjectEngineeringPreset projectId={projectId} policy={policy} onSave={onSave} />));
  return onSave;
}
it("keeps unsupported limits and invalid required configuration visible without saving", async () => {
  const save = await render(null); await act(async () => host.querySelector("button")!.click());
  expect(save).not.toHaveBeenCalled(); expect(host.querySelector('[role="alert"]')?.textContent).toContain("检查工作区");
  expect(host.textContent).toContain("所选文件范围不是整个仓库证明");
});
it("saves approved scope through the existing policy and retains reviewer and manager authority", async () => {
  const policy: DeliveryPolicy = { version: 1, mode: "verified_delivery", managerAgentIds: [projectId], reviewerAgentIds: [workspaceId], criteria: [{ id: "existing", requirement: "Existing requirements" }], engineeringEvidence: { version: 1, sourceScope: { projectId, executionWorkspaceId: workspaceId, files: [
    { path: "src.ts", role: "implementation" }, { path: "test.ts", role: "test" }, { path: "config.ts", role: "harness" }, { path: "package.json", role: "manifest" },
  ] }, requiredJobs: [{ id: "tests", role: "test" }, { id: "verify", role: "verifier" }] } };
  const save = await render(policy); await act(async () => host.querySelector("button")!.click());
  expect(save).toHaveBeenCalledWith(expect.objectContaining({ mode: "verified_delivery", managerAgentIds: [projectId], reviewerAgentIds: [workspaceId], engineeringEvidence: policy.engineeringEvidence }));
  expect(host.querySelector('[role="status"]')?.textContent).toContain("已保存");
});
