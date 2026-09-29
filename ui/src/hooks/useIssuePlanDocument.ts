import { useQuery } from "@tanstack/react-query";
import type { IssueDocument } from "@paperclipai/shared";
import { issuesApi } from "@/api/issues";
import { queryKeys } from "@/lib/queryKeys";

/**
 * The issue's optional `plan` document. The full-document list is already
 * shared by the task panels; selecting from that cache avoids a noisy 404 for
 * tasks that have no Plan and still follows document-scope invalidations.
 */
export function useIssuePlanDocument(issueId: string | null | undefined) {
  return useQuery<IssueDocument[], Error, IssueDocument | null>({
    queryKey: [...queryKeys.issues.documents(issueId ?? ""), "list"],
    enabled: Boolean(issueId) && !issueId?.startsWith("chat:"),
    queryFn: () => issuesApi.listDocuments(issueId!),
    select: (documents) => documents.find((document) => document.key === "plan") ?? null,
  });
}
