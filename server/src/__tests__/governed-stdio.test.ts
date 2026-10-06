import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { callGovernedStdio, probeInterpreter } from "../services/governed-stdio.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true }); });
async function workspace() { const root = await fs.mkdtemp(path.join(os.tmpdir(), "stdio-probe-")); roots.push(root); return root; }
const fixture = (initializeFails = false) => `
const fs = require('node:fs'); const readline = require('node:readline');
process.on('SIGTERM', () => {});
readline.createInterface({ input: process.stdin }).on('line', line => {
 const msg = JSON.parse(line); if (!msg.id) return;
 if (msg.method === 'initialize') { process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, ${initializeFails ? "error: { code: -1, message: 'secret-canary' }" : "result: { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1' } }"} }) + '\\n'); return; }
 let denied = false; try { fs.writeFileSync('source.txt', 'bad'); } catch { denied = true; }
 process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { tools: [{ name: denied ? 'write_denied' : 'write_allowed', inputSchema: {type:'object'} }], cwd: process.cwd(), home: process.env.HOME, ambient: process.env.OPENAI_API_KEY || null } }) + '\\n');
});`;

describe.runIf(Boolean(process.env.PAPERCLIP_TEST_BWRAP))("governed stdio real process", () => {
  it.each([false, true])("preserves runtime deadlines without enlarging the basic/audit ceiling (runtime: %s)", async preserveRuntimeTimeout => {
    const timer = vi.spyOn(globalThis, "setTimeout");
    try {
      await callGovernedStdio({ command: process.execPath, args: ["-e", fixture()], cwd: await workspace(), method: "tools/list", timeoutMs: 40_000, preserveRuntimeTimeout });
      expect(timer.mock.calls.some(([, delay]) => delay === (preserveRuntimeTimeout ? 40_000 : 30_000))).toBe(true);
    } finally { timer.mockRestore(); }
  });
  it("handshakes in the exact cwd with denied source writes and no ambient auth", async () => {
    const cwd = await workspace(); await fs.writeFile(path.join(cwd, "source.txt"), "original");
    const result = await callGovernedStdio({ command: process.execPath, args: ["-e", fixture()], cwd, method: "tools/list", timeoutMs: 1500 });
    expect(result).toMatchObject({ tools: [{ name: "write_denied" }], cwd, ambient: null });
    expect(await fs.readFile(path.join(cwd, "source.txt"), "utf8")).toBe("original");
    await expect(fs.stat((result as {home:string}).home)).rejects.toThrow();
  });
  it("rejects advertised tools when initialize fails without leaking server error text", async () => {
    const error = await callGovernedStdio({ command: process.execPath, args: ["-e", fixture(true)], cwd: await workspace(), method: "tools/list", timeoutMs: 1000 }).catch(error => error);
    expect(error).toMatchObject({ code: "stdio_protocol_error" });
    expect(String(error)).not.toContain("secret-canary");
  });
  it("bounds an unresponsive server and rejects missing cwd without creating it", async () => {
    const cwd = await workspace(); const missing = path.join(cwd, "missing");
    await expect(callGovernedStdio({ command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"], cwd, method: "tools/list", timeoutMs: 100 })).rejects.toMatchObject({ code: "stdio_timeout" });
    await expect(callGovernedStdio({ command: process.execPath, args: [], cwd: missing, method: "tools/list", timeoutMs: 100 })).rejects.toMatchObject({ code: "cwd_unavailable" });
    await expect(fs.stat(missing)).rejects.toThrow();
  });
  it("distinguishes python and python3 without installing either", async () => {
    const cwd = await workspace();
    const python = await probeInterpreter("python", cwd, "/usr/bin:/bin");
    const python3 = await probeInterpreter("python3", cwd, "/usr/bin:/bin");
    expect(python.status).toBe("error");
    expect(python3.status).toBe("resolved");
    expect(python3.detail).toMatch(/^Python 3\./);
  });
});
