import { expect, it } from "vitest";
import { normalizeNativeUsage, mergeNativeUsageCheckpoint } from "./native-usage-normalization.js";

it("uses only this Codex run delta and never adds its cached subset twice", () => {
  expect(normalizeNativeUsage({ total: { inputTokens: 10000, outputTokens: 5000 }, runDelta: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 80 } }, { kind: "codex" })).toMatchObject({ inputTokens: 100, outputTokens: 20, cachedInputTokens: 80, totalTokens: 120 });
});
it("preserves unavailable or partial totals as unknown", () => {
  expect(normalizeNativeUsage({ runDeltaAvailable: false, runDelta: { inputTokens: 0, outputTokens: 0 }, total: { inputTokens: 5000, outputTokens: 2000 } }, { kind: "codex" })?.totalTokens).toBeUndefined();
  expect(normalizeNativeUsage({ runDelta: { inputTokens: 100 } }, { kind: "codex" })?.totalTokens).toBeUndefined();
  expect(normalizeNativeUsage({ runDelta: {}, total: { inputTokens: 5000, outputTokens: 2000 } }, { kind: "codex" })?.totalTokens).toBeUndefined();
});
it("uses qualified Claude aggregate input, cache creation/read and output once", () => {
  expect(normalizeNativeUsage({ cumulative: { inputTokens: 12, outputTokens: 30, cachedReadTokens: 40, cachedWriteTokens: 50 } }, { kind: "acpx", agent: "claude" })?.totalTokens).toBe(132);
  expect(normalizeNativeUsage({ cumulative: { inputTokens: 12, outputTokens: 30, cachedReadTokens: 40 } }, { kind: "acpx", agent: "claude" })?.totalTokens).toBeUndefined();
});

it("qualified Codex ACP counts uncached input plus cached reads once", () => {
  expect(normalizeNativeUsage({ cumulative: { inputTokens: 4013, cachedReadTokens: 39936, outputTokens: 640 } }, { kind: "acpx", agent: "codex" })?.totalTokens).toBe(44589);
});

it("final native usage preserves the durable multi-attempt checkpoint and earlier unknown usage", () => {
  expect(mergeNativeUsageCheckpoint({ inputTokens: 20, outputTokens: 2, totalTokens: 22 }, { version: 1, totalTokens: 160, usageUnknown: false })).toEqual({ inputTokens: 20, outputTokens: 2, totalTokens: 160 });
  expect(mergeNativeUsageCheckpoint({ inputTokens: 20, outputTokens: 2, totalTokens: 22 }, { version: 1, totalTokens: null, usageUnknown: true })).toEqual({ inputTokens: 20, outputTokens: 2 });
  expect(mergeNativeUsageCheckpoint({ inputTokens: 70, outputTokens: 10, totalTokens: 80 }, { version: 1, totalTokens: 160, attempts: { 1: 110, 2: 50 }, usageUnknown: false }, 2)?.totalTokens).toBe(190);
});
