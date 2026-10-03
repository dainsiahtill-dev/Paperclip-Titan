import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { BudgetPolicySummary } from "@paperclipai/shared";
import { BudgetPolicyCard } from "./BudgetPolicyCard";

const summary: BudgetPolicySummary = {
  policyId: "tokens", companyId: "company", scopeType: "company", scopeId: "company", scopeName: "Company",
  metric: "total_tokens", windowKind: "lifetime", amount: 1000, observedAmount: 120,
  remainingAmount: 880, utilizationPercent: 12, warnPercent: 80, hardStopEnabled: true,
  notifyEnabled: true, isActive: true, status: "ok", paused: false, pauseReason: null,
  windowStart: new Date(0), windowEnd: new Date(),
};
describe("token budgets", () => {
  it("uses whole tokens rather than USD and gives the input an associated label", () => {
    const html = renderToStaticMarkup(<BudgetPolicyCard summary={summary} onSave={() => undefined} />);
    expect(html.includes("Budget (tokens)")).toBe(true);
    expect(html.includes("$1.20")).toBe(false);
    expect(html.includes('aria-label="Budget (tokens)"')).toBe(true);
  });
  it("shows incomplete usage explicitly rather than a healthy zero-resource claim", () => {
    const html = renderToStaticMarkup(<BudgetPolicyCard summary={{ ...summary, unknownUsageCount: 3 }} />);
    expect(html.includes("Usage incomplete")).toBe(true);
    expect(html.includes("3 usage records")).toBe(true);
  });
});
