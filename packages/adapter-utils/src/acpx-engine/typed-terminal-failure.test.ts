import { readdir, readFile } from "node:fs/promises";
import vm from "node:vm";
import { expect, it } from "vitest";

const providerMessage = "The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.";
const title = JSON.stringify({ type: "error", status: 400, error: { type: "invalid_request_error", message: providerMessage } });

for (const [version, directory] of [
  ["0.12", new URL("../../node_modules/acpx/dist/", import.meta.url)],
  ["0.13", new URL("../../../paperclip-runner/node_modules/acpx/dist/", import.meta.url)],
] as const) {
  async function promptTurn(response: unknown) {
    const filename = (await readdir(directory)).find(name => /^live-checkpoint-.*\.js$/.test(name))!;
    const source = await readFile(new URL(filename, directory), "utf8");
    const start = source.indexOf("//#region src/runtime/engine/prompt-turn.ts");
    const end = source.indexOf("//#endregion", start);
    const context = vm.createContext({ withTimeout: (promise: unknown) => promise, recordPromptResponseUsage: () => {}, TimeoutError: class extends Error {} });
    const run = vm.runInContext(`${source.slice(start, end)}\nrunPromptTurn`, context);
    return run({ client: { prompt: async () => response, waitForSessionUpdatesIdle: async () => {} }, sessionId: "bound-session", prompt: [], conversation: {} });
  }
  it(`ACPX ${version} retains the typed terminal provider title as a bounded cause`, async () => {
    const failure = { severity: "error", category: "service", title };
    let error: { message?: string; cause?: { message?: string; typedSessionFailure?: boolean } } | undefined;
    try { await promptTurn({ stopReason: "end_turn", _meta: { jetbrains: { air: { version: 1, sessionFailure: failure } } } }); }
    catch (value) { error = value as typeof error; }
    expect(error?.message).toBe("ACP agent reported a terminal service failure.");
    expect(error?.cause).toMatchObject({ message: title, typedSessionFailure: true });
  });
  it(`ACPX ${version} does not turn narration or unversioned metadata into a typed failure`, async () => {
    expect(await promptTurn({ stopReason: "end_turn", title, _meta: { jetbrains: { air: { sessionFailure: { severity: "error", category: "service", title } } } } })).toMatchObject({ stopReason: "end_turn" });
  });
}
