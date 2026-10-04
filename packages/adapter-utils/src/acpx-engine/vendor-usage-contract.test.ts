import fs from "node:fs";
import { fileURLToPath } from "node:url";
import vm from "node:vm";
import { expect, it } from "vitest";

it("the shipped Codex ACP producer preserves inclusive physical counters and actual session/scope identities", () => {
  const patch = fs.readFileSync(fileURLToPath(new URL("../../../../patches/@agentclientprotocol__codex-acp@1.6.2.patch", import.meta.url)), "utf8");
  const match = patch.match(/^\+function paperclipCumulativeUsage\([\s\S]*?^\+}/m);
  expect(match).not.toBeNull();
  const source = match![0].split("\n").map((line) => line.slice(1)).join("\n");
  const producer = vm.runInNewContext(`(${source})`, { process: { env: { PAPERCLIP_COMPANY_ID: "company", PAPERCLIP_AGENT_ID: "agent", PAPERCLIP_TASK_ID: "issue", PAPERCLIP_RUN_ID: "run" } } });
  const state = { sessionId: "actual-provider-session", paperclipUsageTurnId: "actual-provider-turn", cwd: "/effective/cwd", currentModelId: "gpt-6.1-sol[xhigh]", paperclipCumulativeRaw: { inputTokens: 384467, cachedInputTokens: 319360, outputTokens: 10679, totalTokens: 395146 }, totalTokenUsage: { inputTokens: 65107, cachedInputTokens: 319360, outputTokens: 10679, totalTokens: 395146 }, lastTokenUsage: { totalTokens: 79301 } };
  expect(producer(state, true)).toMatchObject({ producer: "codex-acp@1.6.2", source: "codex_session_cumulative", sessionId: "actual-provider-session", providerTurnId: "actual-provider-turn", complete: true, scope: { companyId: "company", agentId: "agent", issueId: "issue", runId: "run", cwd: "/effective/cwd", model: "gpt-6.1-sol" }, cumulative: { inputTokens: 384467, cachedInputTokens: 319360, outputTokens: 10679, totalTokens: 395146 } });
  expect(producer({ ...state, paperclipCumulativeRaw: null })).toBeUndefined();
  expect(producer({ ...state, paperclipUsageTurnId: undefined })).toBeUndefined();
  expect(patch).toContain("this.sessionState.paperclipCumulativeRaw = params.tokenUsage.total");
  expect(patch).toContain("paperclipUsage: paperclipCumulativeUsage(this.sessionState)");
  // Existing producer scope/privacy patches survive regenerated patch output.
  expect(patch).toContain("baseInstructions: paperclipBaseInstructions(request)");
  expect(patch).toContain("!context.isToolApproval && this.shouldUseAcpElicitation(params)");
});
