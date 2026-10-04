// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { HeartbeatRun } from "@paperclipai/shared";
const mocks = vi.hoisted(() => ({ issue: vi.fn(), retry: vi.fn(), access: vi.fn(), agent: vi.fn() }));
vi.mock("../api/issues", () => ({ issuesApi: { get: mocks.issue } }));
vi.mock("../api/agents", () => ({ agentsApi: { retryFailedRun: mocks.retry, get: mocks.agent } }));
vi.mock("../api/access", () => ({ accessApi: { getCurrentBoardAccess: mocks.access } }));
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let root: Root | undefined;
afterEach(async () => { if (root) await act(async () => root!.unmount()); document.body.innerHTML = ""; vi.clearAllMocks(); });
const pause = () => new Promise(resolve => setTimeout(resolve, 20));
function button(text: string) { return [...document.querySelectorAll<HTMLButtonElement>("button")].find(element => element.textContent === text); }
async function input(element: HTMLInputElement | HTMLTextAreaElement, value: string) {
  await act(async () => { Object.getOwnPropertyDescriptor(element instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype, "value")!.set!.call(element, value); element.dispatchEvent(new Event("input", { bubbles: true })); });
}
it("requires explicit residual and wall budget, shows current owner/scope, and keeps stale errors visible", async () => {
  mocks.issue.mockResolvedValue({ id: "task", title: "Current requested task", description: "Changed scope for current owner", status: "blocked", assigneeAgentId: "current-agent",
    updatedAt: "2026-10-05T02:00:00.000Z", executionWorkspaceId: "workspace", activeRecoveryAction: { cause: "retry_suppressed", evidence: { sourceRunId: "source-run" } } });
  mocks.agent.mockResolvedValue({ name: "Current engineer" });
  mocks.access.mockResolvedValue({ source: "local_implicit", companyIds: ["company"] });
  mocks.retry.mockRejectedValue(new Error("The task changed. Refresh its current scope and owner before authorizing remaining work."));
  const module = await import("./RunRetrySupersession");
  const container = document.createElement("div"); document.body.append(container); root = createRoot(container);
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  const run: HeartbeatRun = { id: "source-run", companyId: "company", agentId: "old-agent", status: "timed_out", invocationSource: "assignment", triggerDetail: "system",
    responsibleUserId: "operator", startedAt: null, finishedAt: new Date(), error: "Original timeout", wakeupRequestId: null, exitCode: null,
    signal: null, usageJson: null, resultJson: null, sessionIdBefore: null, sessionIdAfter: null, logStore: null, logRef: null, logBytes: null,
    logSha256: null, logCompressed: false, stdoutExcerpt: null, stderrExcerpt: null, errorCode: "adapter_timeout", externalRunId: null,
    processPid: null, processStartedAt: null, lastOutputAt: null, lastOutputSeq: 0, lastOutputStream: null, lastOutputBytes: null,
    retryOfRunId: null, processLossRetryCount: 0, livenessState: null, livenessReason: null, continuationAttempt: 0, lastUsefulActionAt: null,
    nextAction: null, contextSnapshot: { issueId: "task" }, createdAt: new Date(), updatedAt: new Date() };
  await act(async () => { root!.render(<QueryClientProvider client={client}><module.RunRetrySupersession run={run} /></QueryClientProvider>); await pause(); });
  await act(async () => { await pause(); });
  expect(button("Authorize remaining work")).toBeDefined();
  await act(async () => { button("Authorize remaining work")!.click(); await pause(); });
  expect(document.body.textContent).toContain("Current requested task");
  expect(document.body.textContent).toContain("Current engineer");
  const submit = button("Authorize and continue")!;
  expect(submit.disabled).toBe(true);
  const objective = document.querySelector<HTMLTextAreaElement>("#retry-residual")!;
  const budget = document.querySelector<HTMLInputElement>("#retry-wall-budget")!;
  expect(budget.value).toBe("");
  await input(objective, "Complete the newly reviewed residual and report its pending verification.");
  expect(submit.disabled).toBe(true);
  await input(budget, "120");
  expect(submit.disabled).toBe(false);
  await act(async () => { submit.click(); await pause(); });
  expect(mocks.retry).toHaveBeenCalledWith("current-agent", "source-run", "company", expect.objectContaining({ expectedIssueRevision: "2026-10-05T02:00:00.000Z", expectedAssigneeAgentId: "current-agent", maxRunSeconds: 120 }));
  expect(document.querySelector('[role="alert"]')?.textContent).toContain("The task changed");
  expect(objective.value).toContain("newly reviewed residual");
  expect(button("Refresh current task")).toBeDefined();
});
