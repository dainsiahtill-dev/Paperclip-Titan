import { formatTokens } from "./utils";
import { v3t } from "@/i18n";

/** Unknown cache semantics cannot be converted into an exact aggregate. */
export function totalTokenUsage(rows: readonly { totalTokens?: number | null }[]): number | null {
  let total = 0;
  for (const row of rows) {
    if (typeof row.totalTokens !== "number" || !Number.isFinite(row.totalTokens) || row.totalTokens < 0) return null;
    total += row.totalTokens;
  }
  return total;
}
export function formatTokenTotal(value: number | null | undefined): string {
  return typeof value === "number" ? formatTokens(value) : v3t("reliability.unknown");
}
