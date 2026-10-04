/** Only qualified provider semantics can supply a total when it was omitted. */
export function providerTokenTotal(input: {
  provider?: "codex" | "codex_acp" | "claude" | null;
  inputTokens?: unknown; outputTokens?: unknown; cachedReadTokens?: unknown;
  cachedWriteTokens?: unknown; explicitTotal?: unknown;
}): number | undefined {
  const valid = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
  if (valid(input.explicitTotal)) return input.explicitTotal;
  if (!valid(input.inputTokens) || !valid(input.outputTokens)) return undefined;
  let total: number;
  if (input.provider === "codex") {
    // Codex input already includes cache reads; reasoning is included in output.
    if (valid(input.cachedReadTokens) && input.cachedReadTokens > input.inputTokens) return undefined;
    total = input.inputTokens + input.outputTokens;
  } else if (input.provider === "codex_acp") {
    // Pinned codex-acp toTokenCount subtracts cached input before reporting.
    if (!valid(input.cachedReadTokens)) return undefined;
    if (input.cachedWriteTokens !== undefined && input.cachedWriteTokens !== 0) return undefined;
    total = input.inputTokens + input.outputTokens + input.cachedReadTokens;
  } else if (input.provider === "claude") {
    if (!valid(input.cachedReadTokens) || !valid(input.cachedWriteTokens)) return undefined;
    total = input.inputTokens + input.outputTokens + input.cachedReadTokens + input.cachedWriteTokens;
  } else return undefined;
  return valid(total) ? total : undefined;
}
