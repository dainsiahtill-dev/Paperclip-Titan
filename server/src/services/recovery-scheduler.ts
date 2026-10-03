export const recoveryPhases = ["reap", "promote", "queues", "stranded", "dependencies", "watchdogs", "silence", "stale_locks"] as const;
export type RecoveryPhase = typeof recoveryPhases[number];
export type PhaseOutcome = "completed" | "failed" | "skipped";
export interface RecoveryPhaseResult { phase: RecoveryPhase; outcome: PhaseOutcome; durationMs: number }
export function createRecoveryScheduler(
  phases: Readonly<Record<RecoveryPhase, () => Promise<unknown>>>,
  canRunPhase: (phase: RecoveryPhase, priorResults: readonly RecoveryPhaseResult[]) => Promise<boolean>,
  logFailure: (phase: RecoveryPhase) => void,
  options: { now?: () => number; failureBackoffMs?: number } = {},
) {
  let active: Promise<readonly RecoveryPhaseResult[]> | null = null;
  let stopped = false;
  const retryAfter = new Map<RecoveryPhase, number>();
  const failures = new Map<RecoveryPhase, number>();
  const now = options.now ?? (() => performance.now());
  async function cycle(): Promise<readonly RecoveryPhaseResult[]> {
    const results: RecoveryPhaseResult[] = [];
    for (const phase of recoveryPhases) {
      const started = now();
      let outcome: PhaseOutcome = "skipped";
      const needsStopAuthority = phase === "promote" || phase === "queues" || phase === "stranded";
      const stopAuthority = results.some(result => result.phase === "reap" && result.outcome === "completed");
      try {
        if (!stopped && (!needsStopAuthority || stopAuthority) && started >= (retryAfter.get(phase) ?? 0) && await canRunPhase(phase, results) && !stopped) {
          await phases[phase]();
          outcome = "completed";
          failures.delete(phase); retryAfter.delete(phase);
        }
      } catch {
        outcome = "failed";
        const count = (failures.get(phase) ?? 0) + 1;
        failures.set(phase, count);
        retryAfter.set(phase, now() + Math.min(300_000, (options.failureBackoffMs ?? 5_000) * 2 ** Math.min(count - 1, 6)));
        // Logging must not turn an isolated phase failure into a failed cycle.
        try { logFailure(phase); } catch { /* fixed-code sink is best effort */ }
      }
      results.push({ phase, outcome, durationMs: Math.max(0, now() - started) });
    }
    return results;
  }
  return {
    tick(): Promise<readonly RecoveryPhaseResult[]> {
      if (active) return active;
      if (stopped) return Promise.resolve([]);
      active = cycle().finally(() => { active = null; });
      return active;
    },
    async drain() { if (active) await active; },
    stop() { stopped = true; },
  };
}
