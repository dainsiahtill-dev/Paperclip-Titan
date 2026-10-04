import { useState } from "react";
import type { DeliveryAssessment, DeliveryCriterionAssessment } from "@paperclipai/shared/types/delivery";
import { Button } from "./ui/button";
import { Textarea } from "./ui/textarea";

const stateLabels = { accepted: "已独立验收", rejected: "需要修改", stale: "内容或条件已变更", missing: "等待评审" } as const;
export interface DeliveryAssessmentPanelProps {
  assessment: DeliveryAssessment;
  onDecision?: (criterion: DeliveryCriterionAssessment, verdict: "accepted" | "rejected", reason: string) => void | Promise<void>;
  pending?: boolean;
  error?: string | null;
}
export function DeliveryAssessmentPanel({ assessment, onDecision, pending, error }: DeliveryAssessmentPanelProps) {
  const [reason, setReason] = useState("");
  if (assessment.mode !== "verified_delivery") return <p className="text-sm text-muted-foreground">普通任务沿用现有完成策略，无需逐项独立验收。</p>;
  return (
    <section className="flex flex-col gap-3" aria-label="交付验收">
      <div className="flex flex-col gap-1">
        <h3 className="text-sm font-medium">独立验收</h3>
        <p className="text-xs text-muted-foreground">验收绑定当前条件与产物内容。执行者自报通过不会授予验收权限；仅变更的条件需要重验。</p>
      </div>
      <div className="flex flex-col gap-3">
        {assessment.criteria.map((criterion) => (
          <div className="flex flex-col gap-1" key={criterion.id}>
            <div className="flex items-start justify-between gap-2">
              <p className="text-sm">{criterion.requirement}</p>
              <span className="shrink-0 text-xs text-muted-foreground">{stateLabels[criterion.state]}</span>
            </div>
            {criterion.reason ? <p className="text-xs text-muted-foreground">{criterion.reason}</p> : null}
            {criterion.provenance ? <p className="text-xs text-muted-foreground">评审：{criterion.provenance.reviewerName || "独立评审者"}{Number.isFinite(Date.parse(criterion.provenance.createdAt)) ? <> · <time dateTime={criterion.provenance.createdAt}>{new Date(criterion.provenance.createdAt).toLocaleString()}</time></> : null}</p> : null}
            {assessment.permissions?.canReview && onDecision && criterion.workProductId && criterion.materialVersion && criterion.contentDigest ? (
              <div className="flex items-center gap-2">
                {criterion.state !== "accepted" ? <Button size="sm" variant="outline" disabled={pending} onClick={() => onDecision(criterion, "accepted", reason.trim() || "已检查当前条件与产物内容，验收通过。")}>验收通过</Button> : null}
                <Button size="sm" variant="outline" disabled={pending || !reason.trim()} onClick={() => onDecision(criterion, "rejected", reason.trim())}>要求修改</Button>
              </div>
            ) : null}
          </div>
        ))}
      </div>
      {assessment.permissions?.canReview && onDecision ? <Textarea value={reason} onChange={(event) => setReason(event.target.value)} placeholder="写明检查结果或具体实现问题；拒绝时必填。" aria-label="验收意见" rows={3} /> : null}
      {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : null}
      <p role="status" aria-atomic="true" className="text-xs text-muted-foreground">{assessment.canComplete ? "当前条件均已通过独立验收，可按正常流程完成任务。" : "仍有条件待验收或需要修改，任务将保留现有负责人。"}</p>
    </section>
  );
}
