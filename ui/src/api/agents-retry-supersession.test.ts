import { expect, it, vi } from "vitest";
const post = vi.hoisted(() => vi.fn(async () => ({ id: "successor" })));
vi.mock("./client", async importOriginal => ({ ...await importOriginal<typeof import("./client")>(), api: { post } }));
import { agentsApi } from "./agents";

it("sends an explicit superseding decision through the existing exact-source endpoint", async () => {
  const decision = { requestId: "request", expectedIssueRevision: "2026-10-05T02:00:00.000Z", expectedAssigneeAgentId: "current-owner",
    residualObjective: "Complete the reviewed remaining work.", maxRunSeconds: 120 };
  expect(await agentsApi.retryFailedRun("current-owner", "old-source", "company", decision)).toEqual({ runId: "successor", issueId: null });
  expect(post).toHaveBeenCalledWith("/agents/current-owner/wakeup?companyId=company", { source: "on_demand", triggerDetail: "manual", reason: "retry_failed_run", failedRunId: "old-source", retrySupersession: decision });
});
