import type { Issue } from "@paperclipai/shared";
import type { OfficeAgent, OfficeExecution, OfficePhase, OfficeRun } from "./pixel-office";

export type OfficeTask = Pick<Issue, "id" | "companyId" | "status" | "assigneeAgentId" | "executionRunId">;

export function selectOfficeTask<I extends OfficeTask>(issues: I[], agentId: string, preferredId?: string | null): I | undefined {
  const assigned = issues.filter(i => i.assigneeAgentId === agentId);
  const preferred = preferredId ? assigned.find(i => i.id === preferredId) : undefined;
  const ranks = { in_progress: 0, in_review: 1, blocked: 2, todo: 3, backlog: 4, done: 5, cancelled: 6 };
  return preferred ?? assigned.sort((a, b) => ranks[a.status] - ranks[b.status] || a.id.localeCompare(b.id))[0];
}
export interface OfficeSnapshotSource<A extends OfficeAgent, I extends OfficeTask> {
  agents(companyId: string): Promise<A[]>;
  runs(companyId: string): Promise<OfficeRun[]>;
  issues(companyId: string): Promise<I[]>;
  execution(issueId: string): Promise<{ runId: string; agentId: string; execution?: { phase: OfficePhase } | null } | null>;
}

export async function fetchOfficeSnapshot<A extends OfficeAgent, I extends OfficeTask>(companyId: string, source: OfficeSnapshotSource<A, I>) {
  const [allAgents, allRuns, allIssues] = await Promise.all([source.agents(companyId), source.runs(companyId), source.issues(companyId)]);
  const agents = allAgents.filter(a => a.companyId === companyId);
  const members = new Map(agents.map(a => [a.id, a]));
  const issues = allIssues.filter(i => i.companyId === companyId && i.assigneeAgentId && members.has(i.assigneeAgentId) && !["done", "cancelled"].includes(i.status));
  const current = new Map(issues.map(i => [i.id, i]));
  const runs = allRuns.filter(r => members.has(r.agentId)).map(r => ({ ...r, currentTask: !!r.issueId && current.get(r.issueId)?.assigneeAgentId === r.agentId }));
  // Keep paused/error employees' tasks for the inspector; only reduce projection requests.
  const requests = issues.filter(i => {
    const status = members.get(i.assigneeAgentId!)!.status;
    return !["paused", "terminated", "pending_approval"].includes(status) && (!!i.executionRunId || ["in_progress", "in_review", "blocked"].includes(i.status));
  }).sort((a, b) => a.id.localeCompare(b.id));
  const executions: OfficeExecution[] = [];
  let cursor = 0, projectionFailures = 0;
  await Promise.all(Array.from({ length: Math.min(4, requests.length) }, async () => {
    while (cursor < requests.length) {
      const issue = requests[cursor++];
      try {
        const value = await source.execution(issue.id);
        if (value?.execution && value.agentId === issue.assigneeAgentId && (!issue.executionRunId || value.runId === issue.executionRunId)) {
          executions.push({ agentId: value.agentId, phase: value.execution.phase, issueId: issue.id, runId: value.runId, currentRun: true });
        }
      } catch { projectionFailures++; }
    }
  }));
  executions.sort((a, b) => (a.issueId ?? "").localeCompare(b.issueId ?? ""));
  return { agents, runs, issues, executions, projectionFailures };
}
