import path from "node:path";
import { createHash } from "node:crypto";
import type { AdapterUsageObservation, UsageSummary } from "../types.js";

export interface AcpUsageScope {
  companyId: string;
  agentId: string;
  issueId: string | null;
  runId: string;
  cwd: string;
  model: string | null;
}
export interface CodexCumulativeUsage {
  inputTokens: number;
  cachedInputTokens: number;
  outputTokens: number;
  totalTokens: number;
}
const record = (value: unknown): Record<string, any> | null => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, any> : null;
const integer = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
export function readCodexCumulativeUsage(value: unknown): CodexCumulativeUsage | null {
  const x = record(value);
  if (!x || ![x.inputTokens, x.cachedInputTokens, x.outputTokens, x.totalTokens].every(integer)) return null;
  if (x.cachedInputTokens > x.inputTokens || x.inputTokens + x.outputTokens !== x.totalTokens) return null;
  return { inputTokens: x.inputTokens, cachedInputTokens: x.cachedInputTokens, outputTokens: x.outputTokens, totalTokens: x.totalTokens };
}
function delta(after: CodexCumulativeUsage, before: CodexCumulativeUsage): UsageSummary | null {
  const difference = readCodexCumulativeUsage(Object.fromEntries(Object.keys(before).map((key) => [key, after[key as keyof CodexCumulativeUsage] - before[key as keyof CodexCumulativeUsage]])));
  if (!difference) return null;
  return { inputTokens: difference.inputTokens - difference.cachedInputTokens, cachedInputTokens: difference.cachedInputTokens, outputTokens: difference.outputTokens, totalTokens: difference.totalTokens };
}
function sameScope(actual: unknown, expected: AcpUsageScope): boolean {
  const x = record(actual);
  return Boolean(x && x.companyId === expected.companyId && x.agentId === expected.agentId && (x.issueId ?? null) === expected.issueId && x.runId === expected.runId && typeof x.cwd === "string" && path.resolve(x.cwd) === path.resolve(expected.cwd) && (x.model ?? null) === expected.model);
}

/** Only correlated protocol frames can establish a prompt/session boundary. */
export class AcpUsageAccounting {
  private requests = new Map<string, { method: string; sessionId?: string; cwd?: string }>();
  private freshSessions = new Set<string>();
  private effectiveModels = new Map<string, string>();
  private sessionId: string | null = null;
  private promptRequestId: string | null = null;
  private baseline: CodexCumulativeUsage | null = null;
  private latest: CodexCumulativeUsage | null = null;
  private invalidReason: string | null = null;
  private boundary = false;
  private validatedTerminal = false;
  private completionNote: string | null = null;
  private source: AdapterUsageObservation["usageAccounting"]["source"] = "window_only";
  private baselineSource: string | null = null;
  private producerName: string | null = null;
  private producerVersion: string | null = null;
  constructor(readonly scope: AcpUsageScope, readonly agent: string) {}

  bindSession(sessionId: string) {
    this.sessionId = sessionId;
    if (this.scope.model === null && this.effectiveModels.has(sessionId)) this.scope.model = this.effectiveModels.get(sessionId)!;
    if (this.freshSessions.has(sessionId)) {
      this.baseline = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
      this.baselineSource = "correlated_fresh_session";
    }
  }
  setBaseline(usage: CodexCumulativeUsage, source: string) {
    if (this.promptRequestId !== null || this.baseline) return;
    this.baseline = usage;
    this.baselineSource = source;
  }
  needsBaseline() { return this.baseline === null; }
  certifyTerminal(status: string, stopReason: string | undefined) { this.validatedTerminal = status === "completed" && stopReason === "end_turn"; }
  invalidate(reason: string) { this.invalidReason ??= reason; }

  observe(direction: string, value: unknown) {
    const message = record(value);
    if (!message) return;
    const id = typeof message.id === "number" || typeof message.id === "string" ? String(message.id) : null;
    if (direction === "outbound" && id && typeof message.method === "string") {
      const request = { method: message.method, sessionId: message.params?.sessionId, cwd: message.params?.cwd };
      this.requests.set(id, request);
      if (request.method === "session/prompt") {
        if (request.sessionId !== this.sessionId) this.invalidate("prompt_session_mismatch");
        this.promptRequestId = id;
      }
      return;
    }
    if (direction !== "inbound") return;
    if (message.method === "session/update") {
      const params = record(message.params), update = record(params?.update);
      if (update?.sessionUpdate === "usage_update" && update._meta?.paperclipUsage) this.accept(update._meta.paperclipUsage, params?.sessionId, false);
      return;
    }
    if (!id) return;
    const request = this.requests.get(id);
    if (!request) return;
    if (request.method === "initialize") {
      this.producerName = typeof message.result?.agentInfo?.name === "string" ? message.result.agentInfo.name : null;
      this.producerVersion = typeof message.result?.agentInfo?.version === "string" ? message.result.agentInfo.version : null;
    }
    if (this.scope.model === null && ["session/new", "session/load", "session/resume", "session/set_model", "session/set_config_option"].includes(request.method)) {
      const result = record(message.result);
      const option = Array.isArray(result?.configOptions) ? result.configOptions.find((entry: any) => entry?.id === "model" || entry?.category === "model") : null;
      const model = result?.models?.currentModelId ?? result?.currentModelId ?? option?.currentValue;
      const sessionId = request.method === "session/new" ? result?.sessionId : request.sessionId;
      if (typeof model === "string" && model.trim() && typeof sessionId === "string") {
        const effective = model.trim().replace(/\[.*?\]$/, "");
        this.effectiveModels.set(sessionId, effective);
        if (sessionId === this.sessionId) this.scope.model = effective;
      }
    }
    if (request.method === "session/new" && typeof message.result?.sessionId === "string" && typeof request.cwd === "string" && path.resolve(request.cwd) === path.resolve(this.scope.cwd)) this.freshSessions.add(message.result.sessionId);
    if (request.method === "session/prompt" && id === this.promptRequestId && message.result?._meta?.paperclipUsage) {
      const final = message.result.stopReason === "end_turn" && message.result._meta.paperclipUsage.complete === true;
      this.accept(message.result._meta.paperclipUsage, request.sessionId, final);
    }
    if (request.method === "session/prompt" && id === this.promptRequestId && this.agent === "claude" && request.sessionId === this.sessionId && this.producerName === "@agentclientprotocol/claude-agent-acp" && this.producerVersion === "0.73.0") {
      const usage = record(message.result?.usage);
      if (usage && [usage.inputTokens, usage.outputTokens, usage.cachedReadTokens, usage.cachedWriteTokens, usage.totalTokens].every(integer) && usage.inputTokens + usage.outputTokens + usage.cachedReadTokens + usage.cachedWriteTokens === usage.totalTokens) {
        this.baseline = { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, totalTokens: 0 };
        this.baselineSource = "producer_prompt_usage_reset";
        this.latest = { inputTokens: usage.inputTokens + usage.cachedReadTokens + usage.cachedWriteTokens, cachedInputTokens: usage.cachedReadTokens, outputTokens: usage.outputTokens, totalTokens: usage.totalTokens };
        this.source = "claude_prompt_usage";
        this.boundary = message.result.stopReason === "end_turn";
      }
    }
  }

  private accept(raw: unknown, notificationSession: unknown, final: boolean) {
    const x = record(raw);
    if (this.agent !== "codex" || !x || x.version !== 1 || x.source !== "codex_session_cumulative" || x.producer !== "codex-acp@1.6.2") return;
    if (!this.sessionId || x.sessionId !== this.sessionId || notificationSession !== this.sessionId) { this.invalidate("usage_session_mismatch"); return; }
    if (!this.promptRequestId || !sameScope(x.scope, this.scope)) { this.invalidate("usage_scope_mismatch"); return; }
    if (typeof x.providerTurnId !== "string" || !x.providerTurnId.trim()) { this.invalidate("missing_provider_turn"); return; }
    const cumulative = readCodexCumulativeUsage(x.cumulative);
    if (!cumulative) { this.invalidate("invalid_cumulative_usage"); return; }
    if (this.latest && !delta(cumulative, this.latest)) { this.invalidate("cumulative_usage_regressed"); return; }
    if (this.baseline && !delta(cumulative, this.baseline)) { this.invalidate("baseline_usage_regressed"); return; }
    if (this.boundary && !final && this.latest && cumulative.totalTokens > this.latest.totalTokens) {
      // Later scoped spending is still a real lower bound, but the earlier
      // reply cannot certify a counter value it did not contain.
      this.boundary = false;
      this.completionNote = "counter_after_typed_reply";
    }
    this.latest = cumulative;
    this.source = "codex_session_cumulative_delta";
    this.boundary ||= final;
  }

  result(): { usage: UsageSummary | null; usageUnknown: boolean; usageAccounting: AdapterUsageObservation["usageAccounting"] } {
    const observedUsage = this.latest && this.baseline ? delta(this.latest, this.baseline) : null;
    const bindingVerified = this.latest !== null && this.invalidReason === null;
    const complete = Boolean(bindingVerified && this.baseline && observedUsage && observedUsage.totalTokens! > 0 && this.boundary && this.validatedTerminal);
    const scopeHash = createHash("sha256").update(JSON.stringify([this.scope.companyId, this.scope.agentId, this.scope.issueId, this.scope.runId, path.resolve(this.scope.cwd), this.scope.model, this.sessionId])).digest("hex");
    return {
      usage: complete ? observedUsage : null,
      usageUnknown: !complete,
      usageAccounting: {
        version: 1,
        source: this.source,
        completeness: complete ? "complete" : this.latest ? "partial" : "unknown",
        runId: this.scope.runId,
        sessionId: this.sessionId,
        scopeHash,
        bindingVerified,
        baselineVerified: this.baseline !== null,
        baselineSource: this.baselineSource,
        boundary: this.boundary ? "typed_prompt_reply" : null,
        invalidReason: this.invalidReason,
        completionNote: this.completionNote,
        ...(observedUsage ? { observedUsage } : {}),
        ...(this.latest ? { observedSessionCumulative: this.latest } : {}),
      },
    };
  }
}
