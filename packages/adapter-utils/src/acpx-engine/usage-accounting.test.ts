import { describe, expect, it } from "vitest";
import { AcpUsageAccounting, type AcpUsageScope } from "./usage-accounting.js";

const scope: AcpUsageScope = { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", cwd: "/owned/cwd", model: "gpt-6.1-sol" };
const sessionId = "provider-owned-session";
function counter(total: number) { return { inputTokens: total * .75, cachedInputTokens: total * .25, outputTokens: total * .25, totalTokens: total }; }
function meta(total: number, extra: Record<string, unknown> = {}) { return { version: 1, source: "codex_session_cumulative", producer: "codex-acp@1.6.2", sessionId, providerTurnId: "actual-provider-turn", scope, cumulative: counter(total), ...extra }; }
function collector(fresh = true) {
  const result = new AcpUsageAccounting(scope, "codex");
  if (fresh) {
    result.observe("outbound", { id: 1, method: "session/new", params: { cwd: scope.cwd } });
    result.observe("inbound", { id: 1, result: { sessionId } });
  }
  result.bindSession(sessionId);
  return result;
}
function prompt(c: AcpUsageAccounting) { c.observe("outbound", { id: 2, method: "session/prompt", params: { sessionId } }); }
function update(c: AcpUsageAccounting, usage: unknown) { c.observe("inbound", { method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 80, size: 272000, _meta: { paperclipUsage: usage } } } }); }
function finish(c: AcpUsageAccounting, usage: unknown, id = 2) { c.observe("inbound", { id, result: { stopReason: "end_turn", _meta: { paperclipUsage: usage } } }); c.certifyTerminal("completed", "end_turn"); }

describe("physical ACP usage accounting", () => {
  it("deduplicates repeated cumulative updates and counts cache once", () => {
    const c = collector(); prompt(c); update(c, meta(80)); update(c, meta(160)); update(c, meta(160)); finish(c, meta(160, { complete: true }));
    expect(c.result().usage).toEqual({ inputTokens: 80, cachedInputTokens: 40, outputTokens: 40, totalTokens: 160 });
    expect(c.result().usageUnknown).toBe(false);
  });
  it("excludes the independently captured resume baseline", () => {
    const c = collector(false); c.setBaseline(counter(400), "scoped_rollout_pre_prompt"); prompt(c); update(c, meta(480)); finish(c, meta(560, { complete: true }));
    expect(c.result().usage?.totalTokens).toBe(160);
  });
  it.each(["abort", "throw"])("retains observed lower bounds as partial without a final counter boundary on %s", () => {
    const c = collector(); prompt(c); update(c, meta(160));
    expect(c.result()).toMatchObject({ usage: null, usageUnknown: true, usageAccounting: { completeness: "partial", observedUsage: { totalTokens: 160 } } });
  });
  it("does not invent a zero baseline for a resumed session", () => {
    const c = collector(false); prompt(c); finish(c, meta(160, { complete: true }));
    expect(c.result()).toMatchObject({ usage: null, usageUnknown: true, usageAccounting: { baselineVerified: false } });
  });
  it("does not certify a stale unchanged cumulative total as a zero-token run", () => {
    const c = collector(false); c.setBaseline(counter(160), "scoped_rollout_pre_prompt"); prompt(c); finish(c, meta(160, { complete: true }));
    expect(c.result().usageUnknown).toBe(true);
    expect(c.result().usage).toBeNull();
  });
  it.each(["session", "writer", "regression", "window", "uncorrelated_reply", "missing_turn"])("rejects %s evidence as complete usage", (kind) => {
    const c = collector(); prompt(c);
    if (kind === "session") finish(c, meta(160, { complete: true, sessionId: "unrelated" }));
    if (kind === "writer") finish(c, meta(160, { complete: true, scope: { ...scope, runId: "other-writer" } }));
    if (kind === "regression") { update(c, meta(160)); finish(c, meta(80, { complete: true })); }
    if (kind === "window") finish(c, { used: 160, size: 272000, complete: true });
    if (kind === "uncorrelated_reply") finish(c, meta(160, { complete: true }), 999);
    if (kind === "missing_turn") finish(c, meta(160, { complete: true, providerTurnId: undefined }));
    expect(c.result().usageUnknown).toBe(true);
    expect(c.result().usage).toBeNull();
  });
  it("does not promote Claude context-window metadata to a physical total", () => {
    const c = new AcpUsageAccounting(scope, "claude"); c.bindSession(sessionId); prompt(c); finish(c, meta(160, { complete: true }));
    expect(c.result().usageUnknown).toBe(true);
  });
  it("retains Claude's actual producer prompt aggregate capability, separately from window updates", () => {
    const c = new AcpUsageAccounting(scope, "claude");
    c.observe("outbound", { id: 1, method: "initialize", params: {} });
    c.observe("inbound", { id: 1, result: { agentInfo: { name: "@agentclientprotocol/claude-agent-acp", version: "0.73.0" } } });
    c.bindSession(sessionId); prompt(c);
    c.observe("inbound", { id: 2, result: { stopReason: "end_turn", usage: { inputTokens: 12, cachedReadTokens: 40, cachedWriteTokens: 50, outputTokens: 30, totalTokens: 132 } } });
    c.certifyTerminal("completed", "end_turn");
    expect(c.result()).toMatchObject({ usageUnknown: false, usage: { inputTokens: 62, cachedInputTokens: 40, outputTokens: 30, totalTokens: 132 }, usageAccounting: { source: "claude_prompt_usage" } });
  });
});
