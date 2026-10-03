import { describe, expect, it } from "vitest";
import { createRecoveryScheduler, recoveryPhases, type RecoveryPhase } from "./recovery-scheduler.js";

function deferred() { let resolve!: () => void; const promise = new Promise<void>(r => { resolve = r; }); return { promise, resolve }; }
function callbacks(run: (phase: RecoveryPhase) => Promise<unknown>) {
  return Object.fromEntries(recoveryPhases.map(phase => [phase, () => run(phase)])) as Record<RecoveryPhase, () => Promise<unknown>>;
}
describe("physical recovery coordinator", () => {
  it("isolates failed reap while skipping dispatch without stop authority", async () => {
    const called: RecoveryPhase[] = [], failures: string[] = [];
    const scheduler = createRecoveryScheduler(callbacks(async phase => { called.push(phase); if (phase === "reap") throw new Error("private credential"); }), async () => true, phase => failures.push(phase));
    const result = await scheduler.tick();
    expect(called).toEqual(["reap", "dependencies", "watchdogs", "silence", "stale_locks"]);
    expect(result.filter(p => p.outcome === "skipped").map(p => p.phase)).toEqual(["promote", "queues", "stranded"]);
    expect(failures).toEqual(["reap"]);
  });
  it("shares one physical cycle across ticks and drain waits for settlement", async () => {
    const owner = deferred(), called: string[] = [];
    const scheduler = createRecoveryScheduler(callbacks(async phase => { called.push(phase); if (phase === "reap") await owner.promise; }), async () => true, () => {});
    const first = scheduler.tick(), second = scheduler.tick();
    expect(first).toBe(second);
    let drained = false; const drain = scheduler.drain().then(() => { drained = true; });
    await Promise.resolve(); expect(drained).toBe(false); expect(called).toEqual(["reap"]);
    owner.resolve(); await drain; await first;
    expect(called.filter(p => p === "reap")).toHaveLength(1);
  });
  it("stop during suppression check prevents new dispatch", async () => {
    const gate = deferred(), called: string[] = [];
    const scheduler = createRecoveryScheduler(callbacks(async phase => { called.push(phase); }), async () => { await gate.promise; return true; }, () => {});
    const cycle = scheduler.tick(); scheduler.stop(); gate.resolve();
    await cycle; await scheduler.drain(); expect(called).toEqual([]);
  });
  it("backs off failed phases without suppressing independent maintenance", async () => {
    let now = 0, reaps = 0, silence = 0;
    const scheduler = createRecoveryScheduler(callbacks(async phase => { if (phase === "reap") { reaps++; throw new Error(); } if (phase === "silence") silence++; }), async () => true, () => {}, { now: () => now, failureBackoffMs: 100 });
    await scheduler.tick(); await scheduler.tick(); expect(reaps).toBe(1); expect(silence).toBe(2);
    now = 100; await scheduler.tick(); expect(reaps).toBe(2);
  });
});
