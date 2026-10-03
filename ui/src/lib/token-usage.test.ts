import { describe, expect, it } from "vitest";
import { totalTokenUsage, formatTokenTotal } from "./token-usage";
describe("normalized token totals", () => {
  it("uses provider-normalized totals instead of re-adding cached input", () => {
    expect(totalTokenUsage([{ totalTokens: 120 }, { totalTokens: 200 }])).toBe(320);
  });
  it("does not turn unknown historical semantics into zero or an exact aggregate", () => {
    expect(totalTokenUsage([{ totalTokens: 120 }, { totalTokens: null }])).toBeNull();
    expect(totalTokenUsage([{}])).toBeNull();
    expect(formatTokenTotal(null)).toBe("Unknown");
    expect(totalTokenUsage([])).toBe(0);
  });
});
