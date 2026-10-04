import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { DeliveryCriterionAssessment, DeliveryDecisionInput } from "@paperclipai/shared";
import { issuesApi } from "../api/issues";
import { queryKeys } from "../lib/queryKeys";
import { DeliveryAssessmentPanel } from "./DeliveryAssessmentPanel";
import { Button } from "./ui/button";

/** Review identity, content pins and completion authority always come from the server. */
export function IssueDeliveryAssessment({ issueId }: { issueId: string }) {
  const client = useQueryClient();
  const assessment = useQuery({
    queryKey: queryKeys.issues.deliveryAssessment(issueId),
    queryFn: () => issuesApi.getDeliveryAssessment(issueId),
    refetchInterval: 10_000,
  });
  const decision = useMutation({
    mutationFn: (input: DeliveryDecisionInput) => issuesApi.recordDeliveryDecision(issueId, input),
    onSettled: () => Promise.all([
      client.invalidateQueries({ queryKey: queryKeys.issues.deliveryAssessment(issueId) }),
      client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId) }),
      client.invalidateQueries({ queryKey: queryKeys.issues.activity(issueId) }),
      client.invalidateQueries({ queryKey: queryKeys.issues.comments(issueId) }),
    ]),
  });
  if (assessment.isError) return <div className="flex flex-col gap-2"><p role="alert" className="text-sm text-destructive">无法读取交付验收：{assessment.error.message}</p><Button size="sm" variant="outline" onClick={() => void assessment.refetch()}>重试</Button></div>;
  if (!assessment.data || assessment.data.mode !== "verified_delivery") return null;
  const review = (criterion: DeliveryCriterionAssessment, verdict: "accepted" | "rejected", reason: string) => {
    if (!assessment.data?.contractHash || !criterion.workProductId || !criterion.materialVersion || !criterion.contentDigest) return;
    decision.mutate({ requestId: crypto.randomUUID(), criterionId: criterion.id,
      workProductId: criterion.workProductId, expectedContractHash: assessment.data.contractHash,
      expectedCriterionDigest: criterion.criterionDigest, expectedMaterialVersion: criterion.materialVersion,
      expectedContentDigest: criterion.contentDigest, verdict, reason });
  };
  return <DeliveryAssessmentPanel assessment={assessment.data} onDecision={review}
    pending={decision.isPending || assessment.isFetching} error={decision.error?.message} />;
}
