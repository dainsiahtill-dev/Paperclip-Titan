import { randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { runChildProcess, runningProcesses } from "./server-utils.js";

it("aborted hello process retains ownership until its real close and logs drain", async () => {
  const id = randomUUID(), controller = new AbortController();
  let ready!: () => void; const started = new Promise<void>(r => { ready = r; });
  let settled = false;
  const execution = runChildProcess(id, process.execPath, ["-e", "process.on('SIGTERM', () => setTimeout(() => process.exit(0), 150)); console.log('ready'); setInterval(() => {}, 1000)"], {
    cwd: process.cwd(), env: {}, signal: controller.signal, timeoutSec: 2, graceSec: 1,
    onLog: async (_, chunk) => { if (chunk.includes("ready")) ready(); },
  }).then(result => { settled = true; return result; });
  await started;
  controller.abort();
  await new Promise(r => setTimeout(r, 30));
  expect(settled).toBe(false); expect(runningProcesses.has(id)).toBe(true);
  const result = await execution;
  expect(result.stdout).toContain("ready"); expect(runningProcesses.has(id)).toBe(false);
  expect(result.timedOut).toBe(false);
});

it("pre-aborted probe starts no physical child", async () => {
  const id = randomUUID(), controller = new AbortController(); controller.abort();
  await expect(runChildProcess(id, process.execPath, ["-e", "console.log('unexpected')"], { cwd: process.cwd(), env: {}, signal: controller.signal, timeoutSec: 2, graceSec: 1, onLog: async () => {} })).rejects.toThrow();
  expect(runningProcesses.has(id)).toBe(false);
});
