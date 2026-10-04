import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, expect, it } from "vitest";
import { createAcpxEngineExecutor } from "./execute.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });

it("attributes two physical 80-token requests to one 160-token logical prompt over real ACP stdio", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-physical-usage-"));
  roots.push(root);
  const fixture = fileURLToPath(new URL("./.test-fixtures/physical-usage-agent.mjs", import.meta.url));
  const result = await createAcpxEngineExecutor()({
    runId: "677a8d74-451c-4a2c-b2b8-51e4eea8beaf",
    agent: { id: "eaf0c4c8-290b-4739-a6a0-7ce276378472", companyId: "f35fbb9a-76d1-45db-a095-f867475c3bf0", adapterType: "codex_local" },
    runtime: {},
    config: { agent: "codex", agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`, cwd: root, model: "gpt-6.1-sol", stateDir: path.join(root, "state"), env: { CODEX_HOME: path.join(root, "codex-home") } },
    context: { issueId: "e6597c9f-e154-49b6-a09f-64f3c7a00617", taskId: "e6597c9f-e154-49b6-a09f-64f3c7a00617" },
    onLog: async () => {},
  } as never);
  expect(result.errorMessage).toBeNull();
  expect(result.usage).toEqual({ inputTokens: 80, cachedInputTokens: 40, outputTokens: 40, totalTokens: 160 });
  expect(result.usageBasis).toBe("per_run");
  expect(result.resultJson).toMatchObject({ usageUnknown: false, usageAccounting: { version: 1, source: "codex_session_cumulative_delta", completeness: "complete", bindingVerified: true, baselineVerified: true } });
});

async function runFixture(input: { root?: string; runId?: string; runtime?: Record<string, unknown>; env?: Record<string, string>; onUsage?: (observation: any) => Promise<void>; signal?: AbortSignal; onSpawn?: (meta: any) => Promise<void> }) {
  const root = input.root ?? await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-physical-stream-"));
  if (!input.root) roots.push(root);
  const fixture = fileURLToPath(new URL("./.test-fixtures/physical-usage-agent.mjs", import.meta.url));
  return createAcpxEngineExecutor()({ runId: input.runId ?? "677a8d74-451c-4a2c-b2b8-51e4eea8beaf", agent: { id: "eaf0c4c8-290b-4739-a6a0-7ce276378472", companyId: "f35fbb9a-76d1-45db-a095-f867475c3bf0", adapterType: "codex_local" }, runtime: input.runtime ?? {}, config: { agent: "codex", agentCommand: `${JSON.stringify(process.execPath)} ${JSON.stringify(fixture)}`, cwd: root, model: "gpt-6.1-sol", stateDir: path.join(root, "state"), env: { CODEX_HOME: path.join(root, "codex-home"), ...input.env } }, context: { issueId: "e6597c9f-e154-49b6-a09f-64f3c7a00617", taskId: "e6597c9f-e154-49b6-a09f-64f3c7a00617" }, onLog: async () => {}, ...(input.signal ? { signal: input.signal } : {}), onUsage: input.onUsage, onSpawn: input.onSpawn } as never);
}

it("persists an actual 160-token lower bound before stopping at cap150 and keeps incomplete usage unknown", async () => {
  const control = new AbortController();
  const observations: number[] = [];
  let pid: number | null = null;
  let ownedProcessAliveAtCap = false;
  const result = await runFixture({ env: { PHYSICAL_USAGE_HOLD: "1" }, signal: control.signal, onSpawn: async (meta) => { pid = meta.pid; }, onUsage: async (observation) => {
    observations.push(observation.observedTotalTokens);
    expect(observation.usageAccounting).toMatchObject({ bindingVerified: true, baselineVerified: true, completeness: "partial" });
    if (observation.observedTotalTokens >= 150) {
      process.kill(pid!, 0); ownedProcessAliveAtCap = true;
      // The callback never waits for cancellation/ACK/drain on its own stack.
      queueMicrotask(() => control.abort());
    }
  } });
  expect(observations).toEqual([80, 160]);
  expect(ownedProcessAliveAtCap).toBe(true);
  expect(result.resultJson).toMatchObject({ usageUnknown: true, usageAccounting: { completeness: "partial", observedUsage: { totalTokens: 160 } } });
  expect(result.usage).toBeUndefined();
});

it("retains qualified partial counters when ACP throws after physical usage updates", async () => {
  const result = await runFixture({ env: { PHYSICAL_USAGE_THROW: "1" } });
  expect(result.exitCode).toBe(1);
  expect(result.usage).toBeUndefined();
  expect(result.resultJson).toMatchObject({ usageUnknown: true, usageAccounting: { completeness: "partial", observedUsage: { totalTokens: 160 } } });
});

it("captures the exact owned file baseline before a real resumed prompt and excludes prior session usage", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-acp-resume-physical-")); roots.push(root);
  const first = await runFixture({ root });
  const sessionId = first.sessionId!;
  const file = path.join(root, "codex-home/sessions/2026/10/04", `rollout-fixture-${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const rows = [
    { type: "session_meta", payload: { id: sessionId, originator: "acpx", cwd: root } },
    { type: "turn_context", payload: { cwd: root, model: "gpt-6.1-sol" } },
    { type: "response_item", payload: { role: "developer", content: [{ type: "input_text", text: "f35fbb9a-76d1-45db-a095-f867475c3bf0 eaf0c4c8-290b-4739-a6a0-7ce276378472 e6597c9f-e154-49b6-a09f-64f3c7a00617" }] } },
    { timestamp: new Date(Date.now() - 1000).toISOString(), type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 120, cached_input_tokens: 40, output_tokens: 40, total_tokens: 160 } } } },
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  await fs.writeFile(path.join(root, "fixture-provider-baseline.json"), "160");
  const resumed = await runFixture({ root, runId: "99bd73b6-7d8f-4e6c-aa31-cc978d7ee4a8", runtime: { sessionParams: first.sessionParams } });
  expect(resumed.usage?.totalTokens).toBe(160);
  expect(resumed.resultJson).toMatchObject({ usageUnknown: false, usageAccounting: { baselineSource: "scoped_rollout_pre_prompt" } });
});

it.each(["PHYSICAL_USAGE_WRONG_SESSION", "PHYSICAL_USAGE_WINDOW_ONLY"])("never trusts %s as a per-run lower bound", async (kind) => {
  const observations: number[] = [];
  const result = await runFixture({ env: { [kind]: "1" }, onUsage: async (observation) => { observations.push(observation.observedTotalTokens); } });
  expect(observations).toEqual([]);
  expect(result.usage).toBeUndefined();
  expect(result.resultJson?.usageUnknown).toBe(true);
});
