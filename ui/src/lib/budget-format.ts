import type { BudgetMetric } from "@paperclipai/shared";
import { formatCents } from "./utils";

export function formatBudgetAmount(metric: BudgetMetric, value: number) {
  return metric === "billed_cents" ? formatCents(value) : `${value.toLocaleString("en-US")} tokens`;
}
export function budgetInputValue(metric: BudgetMetric, value: number) {
  return metric === "billed_cents" ? (value / 100).toFixed(2) : String(value);
}
export function parseBudgetAmount(metric: BudgetMetric, text: string): number | null {
  const value = text.trim();
  if (!value) return 0;
  if (metric !== "billed_cents" && !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < 0) return null;
  const amount = metric === "billed_cents" ? Math.round(parsed * 100) : parsed;
  return Number.isSafeInteger(amount) ? amount : null;
}
