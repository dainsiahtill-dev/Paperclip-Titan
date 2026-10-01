import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createCodexAcpExecutor } from "../../packages/adapters/codex-local/src/server/acp.ts";
import { createClaudeAcpExecutor } from "../../packages/adapters/claude-local/src/server/acp.ts";

const provider = process.argv[2];
if (!["codex", "claude"].includes(provider)) throw new Error("Expected codex or claude");
const root = await fs.mkdtemp(path.join(os.tmpdir(), `paperclip-adapter-${provider}-`));
const env = { CUDA_VISIBLE_DEVICES: "", CODEX_PATH: process.env.PAPERCLIP_STEERING_SMOKE_CODEX_BINARY ?? "codex" };
if (provider === "claude") {
  const settings = JSON.parse(await fs.readFile(path.join(os.homedir(), ".claude/settings.json"), "utf8"));
  for (const [key, value] of Object.entries(settings.env ?? {})) {
    if (key.startsWith("ANTHROPIC_") && typeof value === "string") env[key] = value;
  }
}
const config = {
  cwd: root, engine: "acp", mode: "persistent", warmHandleIdleMs: 1, stateDir: path.join(root, "state"),
  model: provider === "codex" ? "gpt-6.1-sol" : "MiniMax-M3.1-Flash-Preview",
  permissionMode: "approve-all", nonInteractivePermissions: "approve-all", timeoutSec: 90,
  dangerouslySkipPermissions: true, dangerouslyBypassApprovalsAndSandbox: true, env,
  promptTemplate: "This is a standalone adapter smoke test, with no Paperclip task or API work. Only work inside this scratch directory. Use CPU only. Run commands beginning with rtk. Write original.txt containing ORIGINAL, then write finish.txt containing FINISHED. Briefly report completion.",
};
let acknowledgement;
let cleanup = false;
let output = "";
const runId = randomUUID();
const execute = provider === "codex" ? createCodexAcpExecutor() : createClaudeAcpExecutor();
const result = await execute({
  runId, agent: { id: randomUUID(), companyId: randomUUID(), name: "Steering smoke", adapterType: `${provider}_local`, adapterConfig: config },
  runtime: {}, config,
  context: { prompt: "Only work inside this scratch directory. Use CPU only. Run commands beginning with rtk. Write original.txt containing ORIGINAL, then write finish.txt containing FINISHED. Briefly report completion." },
  onLog: async (stream, text) => {
    if (stream === "stdout") output += text;
    else await fs.appendFile(path.join(root, "stderr.log"), text, { mode: 0o600 });
  },
  onSteeringReady: async (control) => {
    if (!control) { cleanup = true; return; }
    if (acknowledgement || (await control.state()).busy) return;
    const answer = await control.send({ correlationId: "real-agent-handoff", text: "Additional handoff: keep the original two files, and also write handoff.txt containing RECEIVED_IN_SAME_TURN before finishing. Mention SAME_TURN_HANDOFF in your final reply. Only CPU commands beginning with rtk." });
    if (answer.outcome === "injected") acknowledgement = answer;
  },
});
const files = {};
for (const file of ["original.txt", "finish.txt", "handoff.txt"]) {
  files[file] = await fs.readFile(path.join(root, file), "utf8").catch(() => null);
}
const receipt = {
  provider, root, runId, exitCode: result.exitCode, errorCode: result.errorCode,
  acknowledgement, cleanup, files, finalMarker: output.includes("SAME_TURN_HANDOFF"),
  passed: result.exitCode === 0 && acknowledgement?.outcome === "injected" && cleanup &&
    files["original.txt"]?.trimEnd() === "ORIGINAL" && files["finish.txt"]?.trimEnd() === "FINISHED" && files["handoff.txt"]?.trimEnd() === "RECEIVED_IN_SAME_TURN",
};
await fs.writeFile(path.join(root, "receipt.json"), JSON.stringify(receipt, null, 2), "utf8");
console.log(JSON.stringify(receipt));
if (!receipt.passed) process.exitCode = 1;
