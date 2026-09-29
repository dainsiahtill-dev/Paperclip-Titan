import type { DashboardSummary } from "@paperclipai/shared";

type DeliveryEvidenceCardProps = {
  runAttempts: number;
  evidence: DashboardSummary["evidence"];
};

export function DeliveryEvidenceCard({ runAttempts, evidence }: DeliveryEvidenceCardProps) {
  return (
    <section aria-label="Work evidence" className="rounded-xl border border-border bg-card p-4 sm:p-5">
      <div className="space-y-1">
        <h2 className="text-sm font-semibold text-foreground">Work evidence</h2>
        <p className="text-sm text-muted-foreground">Last {evidence.windowDays} days · activity and registered output</p>
      </div>
      <dl className="mt-4 grid grid-cols-1 gap-3 sm:grid-cols-3">
        <div>
          <dt className="text-sm text-muted-foreground">Run attempts</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{runAttempts}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Registered work products</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{evidence.registeredWorkProducts}</dd>
        </div>
        <div>
          <dt className="text-sm text-muted-foreground">Reviewed work products</dt>
          <dd className="mt-1 text-2xl font-semibold tabular-nums text-foreground">{evidence.reviewedWorkProducts}</dd>
        </div>
      </dl>
      <p className="mt-4 border-t border-border pt-3 text-sm text-muted-foreground">
        Product acceptance is not tracked here. Check the project&apos;s acceptance evidence before treating a completed issue as a delivered product.
      </p>
    </section>
  );
}
