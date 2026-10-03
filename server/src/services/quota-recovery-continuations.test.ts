import { expect, it } from "vitest";
import { reconcileQuotaContinuations } from "./quota-recovery-continuations.js";

it("visits every matching predecessor and preserves gates and existing successors", async () => {
  const effects = new Set<string>(["covered"]);
  const sources = ["one", "two", "covered", "held", "other-account"].map(id => ({ id }));
  const result = await reconcileQuotaContinuations({
    page: async cursor => cursor ? [] : sources,
    matches: async run => run.id !== "other-account",
    eligible: async run => run.id !== "held",
    continue: async run => { if (effects.has(run.id)) return "alreadyCovered"; effects.add(run.id); return "scheduled"; },
  });
  expect([...effects].sort()).toEqual(["covered", "one", "two"]);
  expect(result).toMatchObject({ examined: 5, scheduled: 2, alreadyCovered: 1, gateHeld: 1 });
});
it("a partial failure remains retryable and durable predecessors are not duplicated", async () => {
  const effects = new Set<string>(); let fail = true;
  const dependencies = {
    page: async (cursor: string | null) => cursor ? [] : [{ id: "one" }, { id: "two" }, { id: "three" }],
    matches: async () => true, eligible: async () => true,
    continue: async (run: { id: string }) => {
      if (run.id === "two" && fail) throw new Error("storage unavailable");
      if (effects.has(run.id)) return "alreadyCovered" as const;
      effects.add(run.id); return "scheduled" as const;
    },
  };
  await expect(reconcileQuotaContinuations(dependencies)).rejects.toThrow("storage unavailable");
  fail = false;
  expect(await reconcileQuotaContinuations(dependencies)).toMatchObject({ scheduled: 2, alreadyCovered: 1 });
  expect(effects.size).toBe(3);
});
