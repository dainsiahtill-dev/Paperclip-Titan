import { createInterface } from "node:readline";
import fs from "node:fs";
import path from "node:path";

const sessionId = "5c54a7f5-416a-4cc7-80cc-8c810642d598";
let cwd = "";
let pendingPrompt = null;
let pendingBaseline = 0;
const write = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
const usage = (total, complete = false) => ({
  version: 1,
  source: "codex_session_cumulative",
  producer: "codex-acp@1.6.2",
  sessionId,
  providerTurnId: `fixture-physical-turn-${total / 80}`,
  scope: {
    companyId: process.env.PAPERCLIP_COMPANY_ID,
    agentId: process.env.PAPERCLIP_AGENT_ID,
    issueId: process.env.PAPERCLIP_TASK_ID,
    runId: process.env.PAPERCLIP_RUN_ID,
    cwd,
    model: "gpt-6.1-sol",
  },
  cumulative: { inputTokens: total * 0.75, cachedInputTokens: total * 0.25, outputTokens: total * 0.25, totalTokens: total },
  ...(complete ? { complete: true } : {}),
});

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  let result = {};
  if (request.method === "initialize") result = { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } }, agentInfo: { name: "physical-usage-fixture", version: "1" } };
  else if (request.method === "session/new" || request.method === "session/load") {
    cwd = request.params.cwd;
    result = { sessionId, models: { currentModelId: "gpt-6.1-sol", availableModels: [{ modelId: "gpt-6.1-sol", name: "Fixture model" }] } };
  } else if (request.method === "session/prompt") {
    let fault = "";
    try { fault = JSON.parse(fs.readFileSync(path.join(cwd, "fixture-provider-fault.json"), "utf8")); } catch {}
    let baseline = 0;
    try { baseline = Number(JSON.parse(fs.readFileSync(path.join(cwd, "fixture-provider-baseline.json"), "utf8"))); } catch {}
    pendingBaseline = baseline;
    const send = (total) => {
      const metadata = usage(total);
      if (process.env.PHYSICAL_USAGE_WRONG_MODEL === "1") metadata.scope.model = "foreign-model";
      if (process.env.PHYSICAL_USAGE_WRONG_SESSION === "1") metadata.sessionId = "unrelated-provider-session";
      write({ method: "session/update", params: { sessionId, update: { sessionUpdate: "usage_update", used: 80, size: 272000, ...(process.env.PHYSICAL_USAGE_WINDOW_ONLY === "1" ? {} : { _meta: { paperclipUsage: metadata } }) } } });
    };
    if (process.env.PHYSICAL_USAGE_HOLD === "1" || fault === "hold") {
      pendingPrompt = request;
      send(baseline + 80);
      setTimeout(() => send(baseline + 160), 20);
      setTimeout(() => send(baseline + 160), 30);
      return;
    }
    for (const total of [baseline + 80, baseline + 160, baseline + 160]) send(total);
    if (process.env.PHYSICAL_USAGE_THROW === "1" || fault === "throw") {
      write({ id: request.id, error: { code: -32603, message: "Fixture transport failed after real usage updates" } });
      return;
    }
    result = { stopReason: "end_turn", usage: { inputTokens: 60, outputTokens: 20, cachedReadTokens: 20, totalTokens: 80 }, _meta: { paperclipUsage: usage(baseline + 160, true) } };
    if (process.env.PHYSICAL_USAGE_WRONG_SESSION === "1") result._meta.paperclipUsage.sessionId = "unrelated-provider-session";
    if (process.env.PHYSICAL_USAGE_WRONG_MODEL === "1") result._meta.paperclipUsage.scope.model = "foreign-model";
    if (process.env.PHYSICAL_USAGE_WINDOW_ONLY === "1") delete result._meta;
  } else if (request.method === "session/cancel" && pendingPrompt) {
    write({ id: pendingPrompt.id, result: { stopReason: "cancelled", _meta: { paperclipUsage: usage(pendingBaseline + 160) } } });
    pendingPrompt = null;
  } else if (!["session/close", "session/set_model", "session/set_config_option", "session/set_mode", "session/cancel"].includes(request.method)) {
    if (request.id !== undefined) write({ id: request.id, error: { code: -32601, message: "Unsupported fixture method" } });
    return;
  }
  if (request.id !== undefined) write({ id: request.id, result });
});
