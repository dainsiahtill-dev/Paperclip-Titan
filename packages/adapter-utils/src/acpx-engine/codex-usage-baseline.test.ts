import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readScopedCodexRollout } from "./codex-usage-baseline.js";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true }))); });
const sessionId = "01a105ed-2b52-7432-860c-486e0cf8a7f5";
const scope = { companyId: "company-owned", agentId: "agent-owned", issueId: "issue-owned", runId: "current-run-owned", cwd: "/owned/effective-cwd", model: "gpt-6.1-sol" };
async function fixture() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-codex-usage-baseline-")); roots.push(home);
  const file = path.join(home, "sessions/2026/10/04", `rollout-fixture-${sessionId}.jsonl`);
  await fs.mkdir(path.dirname(file), { recursive: true });
  const rows = [
    { type: "session_meta", payload: { id: sessionId, originator: "acpx", cwd: scope.cwd } },
    { type: "turn_context", payload: { cwd: scope.cwd, model: scope.model } },
    { type: "response_item", payload: { role: "developer", content: [{ type: "input_text", text: JSON.stringify(scope) }] } },
    { timestamp: "2026-10-04T08:05:46.358Z", type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 384467, cached_input_tokens: 319360, output_tokens: 10679, total_tokens: 395146 }, last_token_usage: { total_tokens: 79301 } } } },
  ];
  await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  return { home, file, rows };
}
it("extracts the exact cumulative total from an actual-format scoped rollout, not last window usage", async () => {
  const { home } = await fixture();
  const evidence = await readScopedCodexRollout({ codexHome: home, sessionId, scope, requireCurrentRun: true });
  expect(evidence?.usage).toEqual({ inputTokens: 384467, cachedInputTokens: 319360, outputTokens: 10679, totalTokens: 395146 });
  expect(evidence?.fileSha256).toMatch(/^[a-f0-9]{64}$/);
});
it.each(["wrong_session", "wrong_writer", "stale_total", "changed_file", "symlink"])("rejects %s rollout evidence", async (kind) => {
  const { home, file, rows } = await fixture();
  const baseline = await readScopedCodexRollout({ codexHome: home, sessionId, scope });
  let options = { codexHome: home, sessionId, scope };
  if (kind === "wrong_session") options = { ...options, sessionId: "00000000-0000-4000-8000-000000000000" };
  if (kind === "wrong_writer") options = { ...options, scope: { ...scope, agentId: "other-agent" } };
  if (kind === "stale_total") {
    rows.push({ ...rows[3], timestamp: "2026-10-04T08:07:35.888Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 1, cached_input_tokens: 0, output_tokens: 1, total_tokens: 2 } } } } as never);
    await fs.writeFile(file, rows.map((row) => JSON.stringify(row)).join("\n") + "\n");
  }
  if (kind === "changed_file") { const bytes = await fs.readFile(file); await fs.unlink(file); await fs.writeFile(file, bytes); }
  if (kind === "symlink") { await fs.rename(file, file + ".original"); await fs.symlink(file + ".original", file); }
  expect(await readScopedCodexRollout({ ...options, expectedFileIdentity: kind === "changed_file" ? baseline!.fileIdentity : undefined })).toBeNull();
});
