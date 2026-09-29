// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { queryKeys } from "@/lib/queryKeys";
import { useIssueDocuments } from "./useIssueDocuments";
import { useIssuePlanDocument } from "./useIssuePlanDocument";

const { listDocuments, getDocument } = vi.hoisted(() => ({
  listDocuments: vi.fn(),
  getDocument: vi.fn(),
}));
vi.mock("@/api/issues", () => ({ issuesApi: { listDocuments, getDocument } }));

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;

describe("optional issue Plan document", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;

  function View() {
    const all = useIssueDocuments("issue-1");
    const plan = useIssuePlanDocument("issue-1");
    return <div data-testid="documents">{all.data?.length ?? "loading"}|{plan.data?.body ?? "no-plan"}</div>;
  }

  beforeEach(() => {
    listDocuments.mockReset().mockResolvedValue([]);
    getDocument.mockReset().mockResolvedValue(null);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    client.clear();
    container.remove();
  });

  it("shares the document list and avoids a 404 when no Plan exists", async () => {
    await act(async () => root.render(
      <QueryClientProvider client={client}><View /></QueryClientProvider>,
    ));
    await vi.waitFor(() => expect(container.textContent).toBe("0|no-plan"));
    expect(listDocuments).toHaveBeenCalledTimes(1);
    expect(getDocument).not.toHaveBeenCalled();

    listDocuments.mockResolvedValue([{ key: "plan", body: "Ready plan" } as IssueDocument]);
    await act(async () => {
      await client.invalidateQueries({ queryKey: queryKeys.issues.documents("issue-1") });
    });
    await vi.waitFor(() => expect(container.textContent).toBe("1|Ready plan"));
    expect(getDocument).not.toHaveBeenCalled();
  });
});
