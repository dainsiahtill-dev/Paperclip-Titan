// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { IssueWorkProduct } from "@paperclipai/shared";
import { RichWorkProductCard } from "./RichWorkProductCard";

const open = vi.hoisted(() => vi.fn());
const viewer = vi.hoisted(() => ({ enabled: true }));
const content = vi.hoisted(() => vi.fn());
vi.mock("@/context/FileViewerContext", () => ({ useFileViewer: () => viewer.enabled ? { open } : null }));
vi.mock("@/api/file-resources", () => ({ fileResourcesApi: { content } }));
vi.mock("@/components/FileViewerSheet", () => ({ FileContentViewer: ({ content: result }: { content: { content: { data: string } } }) => <div>{result.content.data}</div> }));
const issueId = "11111111-1111-4111-8111-111111111111";
const projectId = "22222222-2222-4222-8222-222222222222";
const workspaceId = "33333333-3333-4333-8333-333333333333";
const resourceRef = { kind: "workspace_file", issueId, projectId, workspaceId,
  workspaceKind: "execution_workspace", relativePath: "reports/REPORT.md", displayPath: "reports/REPORT.md" };
let root: Root | undefined;
let container: HTMLDivElement | undefined;
afterEach(() => { flushSync(() => root?.unmount()); container?.remove(); open.mockClear(); content.mockReset(); viewer.enabled = true; });
function render(ref: unknown, href: string | null = null) {
  container = document.createElement("div"); document.body.appendChild(container); root = createRoot(container);
  const product: IssueWorkProduct = { id: "55555555-5555-4555-8555-555555555555", companyId: "company-1",
    issueId, projectId, executionWorkspaceId: workspaceId, runtimeServiceId: null, externalId: null,
    type: "document", title: "Independent report", provider: "paperclip", isPrimary: true, healthStatus: "unknown",
    summary: null, createdByRunId: null, createdAt: new Date(), updatedAt: new Date(),
    status: "ready_for_review", reviewState: "needs_board_review", url: null,
    metadata: { resourceRef: ref } };
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  flushSync(() => root!.render(<QueryClientProvider client={client}><RichWorkProductCard workProduct={product} href={href} variant="compact" /></QueryClientProvider>));
  return container;
}
it("opens a declared report in its pinned execution workspace", () => {
  const card = render(resourceRef);
  const button = card.querySelector<HTMLButtonElement>("button[data-workspace-file-path='reports/REPORT.md']");
  expect(button).not.toBeNull();
  flushSync(() => button!.click());
  expect(open).toHaveBeenCalledWith({ path: "reports/REPORT.md", workspace: "execution", projectId, workspaceId, line: null, column: null });
});
it.each([{ ...resourceRef, issueId: "44444444-4444-4444-8444-444444444444" },
  { ...resourceRef, workspaceId: "invalid" }])("does not offer a file action for an unbound reference", (ref) => {
  const card = render(ref);
  expect(card.querySelector("button[data-workspace-file-path]")).toBeNull();
  expect(open).not.toHaveBeenCalled();
});
it("retains the ordinary document link when no file reference exists", () => {
  const card = render(null, "https://example.com/report");
  expect(card.querySelector("a")?.getAttribute("href")).toBe("https://example.com/report");
});
it("opens a bound report while the experimental file viewer is disabled", async () => {
  viewer.enabled = false;
  content.mockResolvedValue({ content: { data: "Report scope: source_accepted=false" } });
  const card = render(resourceRef);
  const button = card.querySelector<HTMLButtonElement>("button[data-workspace-file-path='reports/REPORT.md']");
  expect(button).not.toBeNull();
  flushSync(() => button!.click());
  await vi.waitFor(() => expect(document.body.textContent).toContain("Report scope: source_accepted=false"));
  expect(content).toHaveBeenCalledWith(issueId, { path: "reports/REPORT.md", workspace: "execution", projectId, workspaceId });
  expect(open).not.toHaveBeenCalled();
});
