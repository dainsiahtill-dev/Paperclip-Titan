import { expect, it } from "vitest";
import { compareQueuedCandidates, type QueuedCandidate } from "./queued-run-fairness.js";
const now = 2_000_000;
const base: QueuedCandidate = { id: "a", agentId: "busy", createdAt: new Date(now), lastAdmittedAt: new Date(now - 1), ready: true, status: "in_progress", priority: "critical" };
it("ranks unserved Agent first within a shared pool", () => {
  const other = { ...base, id: "b", agentId: "other", lastAdmittedAt: null };
  expect([base, other].sort((a, b) => compareQueuedCandidates(a, b, new Date(now)))[0]).toBe(other);
});
it("ages old ready todo above continuing new critical work and never ages an unready task", () => {
  const old = { ...base, id: "old", priority: "low", status: "todo", createdAt: new Date(now - 15 * 60_000) };
  const blocked = { ...old, id: "blocked", ready: false, createdAt: new Date(0) };
  expect([base, old, blocked].sort((a, b) => compareQueuedCandidates(a, b, new Date(now))).map(run => run.id)).toEqual(["old", "a", "blocked"]);
});
