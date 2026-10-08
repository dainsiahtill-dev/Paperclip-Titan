import type { Issue } from "@paperclipai/shared";
import type { OfficeAction, OfficeAgent, OfficePhase, OfficePresence } from "./pixel-office";

export type OfficeActivityIssue = Pick<Issue, "id" | "companyId" | "assigneeAgentId" | "status" | "title" | "identifier">;

export interface OfficeActivity {
  action: OfficeAction;
  phase?: OfficePhase;
  issueId: string | null;
  summaryKey: `office.activity.${OfficeAction | "finishing" | "queued" | "preparing" | "confirming" | "reconnecting" | "retry" | "access" | "answer" | "recovery"}`;
  task?: Pick<OfficeActivityIssue, "id" | "title" | "identifier">;
}

const waitingSummaries: Partial<Record<OfficePhase, OfficeActivity["summaryKey"]>> = {
  queued: "office.activity.queued",
  preparing: "office.activity.preparing",
  confirming: "office.activity.confirming",
  reconnecting: "office.activity.reconnecting",
  retry_scheduled: "office.activity.retry",
  waiting_for_access: "office.activity.access",
  waiting_for_answer: "office.activity.answer",
};

/** Describe confirmed presence without inferring current work from the issue backlog. */
export function deriveOfficeActivity(
  agent: Pick<OfficeAgent, "id" | "companyId">,
  presence: OfficePresence,
  issues: readonly OfficeActivityIssue[],
): OfficeActivity {
  let summaryKey: OfficeActivity["summaryKey"] = `office.activity.${presence.action}`;
  if (presence.action === "working" && presence.phase === "finishing") {
    summaryKey = "office.activity.finishing";
  } else if (presence.action === "waiting" && presence.phase) {
    summaryKey = waitingSummaries[presence.phase] ?? "office.activity.waiting";
  } else if (presence.action === "error" && presence.phase === "recovery_needed") {
    summaryKey = "office.activity.recovery";
  }

  const activity: OfficeActivity = {
    action: presence.action,
    phase: presence.phase,
    issueId: presence.issueId || null,
    summaryKey,
  };
  if (activity.issueId && ["working", "waiting", "error"].includes(presence.action)) {
    const task = issues.find((candidate) =>
      candidate.id === activity.issueId
      && candidate.companyId === agent.companyId
      && candidate.assigneeAgentId === agent.id
      && candidate.status !== "done"
      && candidate.status !== "cancelled",
    );
    const title = task?.title.replace(/\s+/g, " ").trim();
    if (task && title) {
      activity.task = { id: task.id, title, identifier: task.identifier };
    }
  }
  return activity;
}
