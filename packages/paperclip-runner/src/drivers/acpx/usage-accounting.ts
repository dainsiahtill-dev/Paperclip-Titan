import type { QualifiedAcpxAgent } from "./qualified-profiles.js";

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function providerTokenTotal(input: { provider: string | null; inputTokens: unknown; outputTokens: unknown; cachedReadTokens: unknown; cachedWriteTokens: unknown; explicitTotal: unknown }): number | undefined {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (valid(input.explicitTotal)) return input.explicitTotal;
  if (!valid(input.inputTokens) || !valid(input.outputTokens) || !valid(input.cachedReadTokens)) return undefined;
  const write = input.provider === "codex_acp" && input.cachedWriteTokens === undefined ? 0 : input.cachedWriteTokens;
  if (!valid(write)) return undefined;
  const total = input.inputTokens + input.outputTokens + input.cachedReadTokens + write;
  return valid(total) ? total : undefined;
}

/** Normalize only semantics established by the pinned, qualified ACP servers. */
export function qualifiedAcpxUsageBreakdown(
  agent: QualifiedAcpxAgent | null,
  value: unknown,
): unknown {
  if (value === null || value === undefined) return value;
  const breakdown = record(value);
  if (agent !== "claude" && agent !== "codex") return breakdown;
  const totalTokens = providerTokenTotal({ provider: agent === "codex" ? "codex_acp" : agent, inputTokens: breakdown.inputTokens, outputTokens: breakdown.outputTokens, cachedReadTokens: breakdown.cachedReadTokens, cachedWriteTokens: breakdown.cachedWriteTokens, explicitTotal: breakdown.totalTokens });
  // Claude SDK aggregate output and Codex ACP toPromptUsage.outputTokens both
  // INCLUDE reasoning. PRP folds thought into output, so its additive component
  // is zero here, not the provider's diagnostic reasoning-token subset.
  return {
    ...breakdown,
    ...(totalTokens === undefined ? {} : { totalTokens }),
    thoughtTokens: 0,
    // Codex ACP 1.6.2 has no cache-write billing category. Do not apply this
    // provider-specific zero to Claude/Pi or to an explicitly invalid value.
    ...(agent === "codex" && breakdown.cachedWriteTokens === undefined
      ? { cachedWriteTokens: 0 }
      : {}),
  };
}

/**
 * ACPX persists terminal prompt-response usage but does not stream it. Recover
 * exactly the new prompt receipt belonging to this turn, never a prior receipt
 * or the misleadingly named cumulative_token_usage (which is last-write-wins).
 */
export function persistedAcpxTurnUsage(
  before: unknown,
  after: unknown,
  requestId: string,
): Record<string, unknown> | null {
  const current = record(after);
  if (current.lastRequestId !== requestId) return null;
  const previousReceipts = record(record(before).requestTokenUsage);
  const receipts = record(current.requestTokenUsage);
  const added = Object.keys(receipts).filter(
    (key) => !Object.hasOwn(previousReceipts, key),
  );
  if (added.length !== 1) return null;
  const usage = record(receipts[added[0]!]);
  return {
    type: "status",
    tag: "usage_update",
    text: "terminal prompt usage",
    cost: current.usageCost,
    breakdown: {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cachedReadTokens: usage.cache_read_input_tokens,
      cachedWriteTokens: usage.cache_creation_input_tokens,
      thoughtTokens: usage.thought_tokens,
      totalTokens: usage.total_tokens,
    },
  };
}
