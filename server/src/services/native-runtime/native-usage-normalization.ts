import { providerTokenTotal } from "@paperclipai/adapter-utils/provider-token-total";
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};

export function numericUsageField(
  usage: Record<string, unknown> | null,
  keys: string[],
): number | undefined {
  if (!usage) return undefined;
  for (const key of keys) {
    const value = usage[key];
    if (typeof value === "number" && Number.isFinite(value) && value >= 0)
      return value;
  }
  return undefined;
}

export function nativeUsageMeasurement(usage: Record<string, unknown>) {
  const nestedUsage = record(usage.usage);
  // An explicit delta, even empty or incomplete, must never fall back to a
  // prior session's cumulative count.
  for (const owner of [usage, nestedUsage]) {
    if (Object.hasOwn(owner, "runDelta")) return record(owner.runDelta);
  }
  const candidates = [
    record(usage.total),
    record(nestedUsage.total),
    record(usage.cumulative),
    record(nestedUsage.cumulative),
    nestedUsage,
    usage,
  ];
  return (
    candidates.find(
      (candidate) =>
        numericUsageField(candidate, [
          "inputTokens",
          "input",
          "promptTokens",
          "outputTokens",
          "output",
          "completionTokens",
        ]) !== undefined,
    ) ?? usage
  );
}

export function normalizeNativeUsage(usage: Record<string, unknown> | null, provider?: { kind: string; agent?: string }) {
  if (!usage) return undefined;
  const measurement = nativeUsageMeasurement(usage);
  const cache = record(measurement.cache);
  const cachedInputTokens =
    numericUsageField(measurement, [
      "cachedInputTokens",
      "cacheReadInputTokens",
      "cacheReadTokens",
      "cachedReadTokens",
    ]) ?? numericUsageField(cache, ["read"]);
  const inputTokens = numericUsageField(measurement, ["inputTokens", "input", "promptTokens"]);
  const outputTokens = numericUsageField(measurement, ["outputTokens", "output", "completionTokens"]);
  const cachedWriteTokens = numericUsageField(measurement, ["cachedWriteTokens", "cacheWriteTokens", "cacheCreationInputTokens"]) ?? numericUsageField(cache, ["write"]);
  const kind = provider?.kind === "codex" ? "codex" : provider?.kind === "acpx" && provider.agent === "codex" ? "codex_acp" : provider?.kind === "acpx" && provider.agent === "claude" ? "claude" : null;
  const totalTokens = usage.runDeltaAvailable === false || record(usage.usage).runDeltaAvailable === false ? undefined : providerTokenTotal({ provider: kind, inputTokens, outputTokens, cachedReadTokens: cachedInputTokens, cachedWriteTokens, explicitTotal: numericUsageField(measurement, ["totalTokens", "total_tokens"]) });
  return {
    inputTokens:
      numericUsageField(measurement, [
        "inputTokens",
        "input",
        "promptTokens",
      ]) ?? 0,
    outputTokens:
      numericUsageField(measurement, [
        "outputTokens",
        "output",
        "completionTokens",
      ]) ?? 0,
    ...(cachedInputTokens === undefined ? {} : { cachedInputTokens }),
    ...(totalTokens === undefined ? {} : { totalTokens }),
  };
}

/** Final presentation must not erase usage already committed by prior attempts. */
export function mergeNativeUsageCheckpoint(usage: ReturnType<typeof normalizeNativeUsage>, value: unknown, attempt?: number) {
  const checkpoint = record(value);
  if (checkpoint.version !== 1) return usage;
  const result = { inputTokens: 0, outputTokens: 0, ...usage };
  if (checkpoint.usageUnknown === true) { delete result.totalTokens; return result; }
  const total = checkpoint.totalTokens;
  if (typeof total !== "number" || !Number.isSafeInteger(total) || total < 0) { delete result.totalTokens; return result; }
  const attempts = record(checkpoint.attempts);
  if (attempt && usage?.totalTokens !== undefined && typeof attempts[String(attempt)] === "number") {
    result.totalTokens = total + Math.max(0, usage.totalTokens - (attempts[String(attempt)] as number));
  } else result.totalTokens = Math.max(total, usage?.totalTokens ?? 0);
  return result;
}
