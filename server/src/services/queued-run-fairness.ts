export interface QueuedCandidate { id: string; agentId: string; createdAt: Date; lastAdmittedAt: Date | null; ready: boolean; status?: string | null; priority?: string | null }
export function compareQueuedCandidates(a: QueuedCandidate, b: QueuedCandidate, now: Date) {
  if (a.ready !== b.ready) return a.ready ? -1 : 1;
  if (a.agentId !== b.agentId) {
    const admission = (a.lastAdmittedAt?.getTime() ?? 0) - (b.lastAdmittedAt?.getTime() ?? 0);
    if (admission) return admission;
  }
  const rank = (candidate: QueuedCandidate) => {
    const age = Math.floor(Math.max(0, now.getTime() - candidate.createdAt.getTime()) / 300_000);
    const priority = ({ critical: 0, high: 1, medium: 2, low: 3 } as Record<string, number>)[candidate.priority ?? "medium"] ?? 2;
    const work = candidate.status === "in_progress" || (candidate.ready && age > 0) ? 0 : 1;
    return [work, Math.max(0, priority - age)];
  };
  const left = rank(a), right = rank(b);
  return left[0]! - right[0]! || left[1]! - right[1]! || a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id);
}
