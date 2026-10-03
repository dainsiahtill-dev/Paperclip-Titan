import type { ExecutionProjection } from "@paperclipai/shared";

interface RunExecutionState {
  status: string;
  execution?: ExecutionProjection | null;
}

const phaseLabels: Record<ExecutionProjection["phase"], string> = {
  preparing: "Preparing",
  confirming: "Confirming execution",
  working: "Working",
  reconnecting: "Reconnecting",
  retry_scheduled: "Retry scheduled",
  finishing: "Finishing",
  recovery_needed: "Recovery needed",
  waiting_for_access: "Waiting for access",
  waiting_for_answer: "Waiting for answer",
  queued: "Queued",
  completed: "Completed",
  failed: "Stopped",
};

/** A queued execution path is visible, but does not represent active work. */
export function isRunWorking(run: RunExecutionState): boolean {
  return run.status === "running" && run.execution?.phase === "working";
}

export function runActivityLabel({ status, execution }: RunExecutionState): string {
  if (status === "queued") return "Queued";
  if (execution) return execution.label?.trim() || phaseLabels[execution.phase];
  if (status === "scheduled_retry") return "Retry scheduled";
  return status === "running" ? "Confirming execution" : "Run ended";
}
