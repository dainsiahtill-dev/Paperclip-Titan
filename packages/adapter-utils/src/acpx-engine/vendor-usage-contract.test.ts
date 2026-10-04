import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import vm from "node:vm";
import { expect, it } from "vitest";

it("the installed raw tap follows the current observer through handler cleanup and detaches after settlement", async () => {
  const require = createRequire(import.meta.url);
  const runtimeDir = path.dirname(require.resolve("acpx/runtime"));
  const installed = path.join(runtimeDir, fs.readdirSync(runtimeDir).find((name) => /^live-checkpoint-.*\.js$/.test(name))!);
  const { k: AcpClient } = await import(pathToFileURL(installed).href);
  const effects: string[] = [];
  const sink: { current?: (direction: string, message: any) => void } = { current: (_direction, message) => effects.push(`first:${message.id}`) };
  const client = Object.create(AcpClient.prototype);
  client.options = { onAcpMessage: (_direction: string, message: any) => effects.push(`wrong-initial:${message.id}`) };
  client.eventHandlers = {};
  client.suppressReplaySessionUpdateMessages = false;
  let feed!: ReadableStreamDefaultController;
  const tapped = client.createTappedStream({ readable: new ReadableStream({ start(controller) { feed = controller; } }), writable: new WritableStream() });
  const reader = tapped.readable.getReader();
  const send = async (id: number) => { feed.enqueue({ jsonrpc: "2.0", id, result: {} }); await reader.read(); };
  try {
    client.setEventHandlers({ onAcpMessage: (direction: string, message: any) => sink.current?.(direction, message) });
    await send(1);
    client.clearEventHandlers();
    await send(2);
    sink.current = (_direction, message) => effects.push(`successor:${message.id}`);
    client.setEventHandlers({ onAcpMessage: (direction: string, message: any) => sink.current?.(direction, message) });
    await send(3);
    client.clearEventHandlers();
    await send(4);
    client.clearEventHandlers();
    sink.current = undefined;
    await send(5);
    expect(effects).toEqual(["first:1", "first:2", "successor:3", "successor:4"]);
  } finally {
    feed.close(); await reader.read(); reader.releaseLock();
  }
});

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

it("the frozen installed Codex ACP usage-update producer carries physical totals while keeping the window unchanged", () => {
  const installed = fileURLToPath(new URL("../../../adapters/codex-local/node_modules/@agentclientprotocol/codex-acp/dist/index.js", import.meta.url));
  const source = fs.readFileSync(installed, "utf8");
  const functionBody = source.match(/^function paperclipCumulativeUsage\([\s\S]*?^}/m)![0];
  const countBody = source.match(/^function toTokenCount\([\s\S]*?^}/m)![0];
  const handlerBody = source.match(/^  handleTokenUsageUpdated\(params\) \{[\s\S]*?^  }/m)![0];
  const updateBody = source.match(/^  createUsageUpdate\(params\) \{[\s\S]*?^  }/m)![0];
  const implementation = vm.runInNewContext(`${functionBody}\n${countBody}\n({${handlerBody},${updateBody}})`, { process: { env: { PAPERCLIP_COMPANY_ID: "company", PAPERCLIP_AGENT_ID: "agent", PAPERCLIP_TASK_ID: "issue", PAPERCLIP_RUN_ID: "run" } } });
  implementation.sessionState = { sessionId: "actual-provider-session", cwd: "/effective/cwd", currentModelId: "gpt-6.1-sol" };
  const notification = { threadId: "actual-provider-session", turnId: "actual-provider-turn", tokenUsage: { last: { inputTokens: 60, cachedInputTokens: 20, outputTokens: 20, totalTokens: 80 }, total: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 40, totalTokens: 160 }, modelContextWindow: 272000 } };
  expect(implementation.createUsageUpdate(notification)).toMatchObject({ used: 80, size: 272000, _meta: { paperclipUsage: { sessionId: "actual-provider-session", providerTurnId: "actual-provider-turn", cumulative: { inputTokens: 120, cachedInputTokens: 40, outputTokens: 40, totalTokens: 160 } } } });
});
