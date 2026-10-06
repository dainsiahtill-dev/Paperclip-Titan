import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { constants } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { buildLocalProcessSandboxSpawnTarget } from "@paperclipai/adapter-utils/local-process-sandbox";
import type { AgentPreflightCheck } from "@paperclipai/shared";

export class GovernedProbeError extends Error {
  constructor(public readonly code: string, message: string) { super(message); }
}
const fail = (code: string, message: string) => new GovernedProbeError(code, message);
const within = (root: string, file: string) => { const relative = path.relative(root, file); return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative)); };

export async function existingProbeCwd(cwd: string): Promise<string> {
  if (!path.isAbsolute(cwd)) throw fail("cwd_unavailable", "An existing absolute workspace is required.");
  try { if (!(await fs.stat(cwd)).isDirectory()) throw new Error(); return await fs.realpath(cwd); }
  catch { throw fail("cwd_unavailable", "Workspace is missing or inaccessible; it was not created."); }
}
export async function resolveProbeCommand(command: string, searchPath: string): Promise<string> {
  const candidates = path.isAbsolute(command) ? [command] : command.includes("/") ? [] : searchPath.split(path.delimiter).filter(path.isAbsolute).map(dir => path.join(dir, command));
  for (const candidate of candidates) {
    try { await fs.access(candidate, constants.X_OK); if ((await fs.stat(candidate)).isFile()) return await fs.realpath(candidate); } catch { /* next exact candidate */ }
  }
  throw fail("command_unavailable", "Required executable is not available on the selected PATH.");
}

/** Fresh filesystem/PID namespace. Never loads a user home or provider credentials. */
async function startConfined(input: { command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv; readPaths?: string[]; allowNetwork?: boolean }) {
  const cwd = await existingProbeCwd(input.cwd);
  const searchPath = input.env?.PATH ?? process.env.PATH ?? "/usr/bin:/bin";
  if (["npx", "npm", "pnpm", "yarn", "uv", "uvx", "pip", "pip3"].includes(path.basename(input.command))) throw fail("provisioning_unverified", "Package launchers are not run by basic checks. Approve an already installed executable.");
  const command = await resolveProbeCommand(input.command, searchPath);
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-governed-probe-"));
  if (within(cwd, home)) { await fs.rm(home, { recursive: true, force: true }); throw fail("confinement_unverified", "Workspace overlaps private probe storage."); }
  let target: Awaited<ReturnType<typeof buildLocalProcessSandboxSpawnTarget>>;
  try {
    target = await buildLocalProcessSandboxSpawnTarget({ executable: command, args: input.args, cwd,
      options: { workspaceDir: cwd, workspaceAccess: "ro", filesystemScope: "workspace", networkScope: input.allowNetwork ? undefined : "deny",
        managedPaths: [{ path: home, access: "rw" }], extraPaths: (input.readPaths ?? []).map(p => ({ path: p, access: "ro" })), homeDir: home } });
  } catch { await fs.rm(home, { recursive: true, force: true }); throw fail("confinement_unverified", "Read-only process confinement is unavailable on this host."); }
  const env: NodeJS.ProcessEnv = { ...input.env, PATH: searchPath, HOME: home, XDG_CONFIG_HOME: home, XDG_CACHE_HOME: home, TMPDIR: "/tmp", ...target.env };
  // Template credential refs are the only extra env source; loader/home overrides are never honored.
  for (const key of Object.keys(env)) if (/^(LD_|DYLD_|NODE_OPTIONS$|PYTHONPATH$|PYTHONHOME$|BASH_ENV$|ENV$|CODEX_HOME$|CLAUDE_CONFIG_DIR$)/i.test(key)) delete env[key];
  const child = spawn(target.command, target.args, { cwd: target.cwd, env, stdio: ["pipe", "pipe", "pipe"], detached: true });
  let closed = false;
  const close = new Promise<void>((resolve) => { child.once("close", () => { closed = true; resolve(); }); child.once("error", () => { closed = true; resolve(); }); });
  child.stdin.on("error", () => {});
  const stop = async () => {
    const kill = (signal: NodeJS.Signals) => { if (!closed && child.pid) { try { process.kill(-child.pid, signal); } catch { child.kill(signal); } } };
    child.stdin.end(); kill("SIGTERM");
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([close, new Promise<void>(resolve => { timer = setTimeout(resolve, 150); })]);
    if (timer) clearTimeout(timer);
    kill("SIGKILL");
    await Promise.race([close, new Promise<void>(resolve => { timer = setTimeout(resolve, 1000); })]);
    if (timer) clearTimeout(timer);
    await target.cleanup?.();
    await fs.rm(home, { recursive: true, force: true });
    if (!closed) throw fail("cleanup_unverified", "Probe process termination could not be verified.");
  };
  return { child, stop };
}

function boundedOutput(child: ChildProcessWithoutNullStreams, reject: (reason: Error) => void, onLine: (line: string) => void) {
  let buffer = ""; let total = 0;
  child.stdout.setEncoding("utf8");
  child.stderr.resume(); // No credential-bearing stderr is returned to callers.
  child.stdout.on("data", (chunk: string) => {
    total += Buffer.byteLength(chunk);
    if (total > 1_048_576) { reject(fail("stdio_output_limit", "MCP response exceeded the probe limit.")); return; }
    buffer += chunk;
    let index: number;
    while ((index = buffer.indexOf("\n")) >= 0) { const line = buffer.slice(0, index); buffer = buffer.slice(index + 1); if (line.trim()) onLine(line); }
  });
  child.once("error", () => reject(fail("confinement_unverified", "The confined executable could not start.")));
  child.once("exit", () => reject(fail("stdio_process_exited", "The confined server exited before completing the handshake/request.")));
}

export async function callGovernedStdio(input: {
  command: string; args: string[]; cwd: string; env?: NodeJS.ProcessEnv;
  method: string; params?: Record<string, unknown>; timeoutMs: number;
  /** Runtime callers may preserve their existing network access. Basic
   * checks and audit-profile calls keep the default network denial. */
  allowNetwork?: boolean;
  /** Preserve the gateway's existing normalized (at most 60s) deadline for
   * ordinary runtime calls. Audit/basic calls retain their 30s ceiling. */
  preserveRuntimeTimeout?: boolean;
}): Promise<unknown> {
  const { child, stop } = await startConfined(input);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await new Promise<unknown>((resolve, reject) => {
      const send = (message: Record<string, unknown>) => child.stdin.write(`${JSON.stringify(message)}\n`);
      let initialized = false;
      boundedOutput(child, reject, line => {
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); } catch { reject(fail("stdio_protocol_error", "MCP server returned invalid protocol data.")); return; }
        if (!message || message.jsonrpc !== "2.0" || message.id !== (initialized ? 2 : 1)) return;
        if (message.error !== undefined || !Object.hasOwn(message, "result")) { reject(fail("stdio_protocol_error", "MCP server rejected the handshake/request.")); return; }
        if (!initialized) {
          const result = message.result as Record<string, unknown> | null;
          if (!result || typeof result.protocolVersion !== "string" || typeof result.capabilities !== "object" || !result.serverInfo) { reject(fail("stdio_protocol_error", "MCP initialize response is incomplete.")); return; }
          initialized = true;
          send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
          send({ jsonrpc: "2.0", id: 2, method: input.method, params: input.params ?? {} });
        } else resolve(message.result);
      });
      timer = setTimeout(() => reject(fail("stdio_timeout", "MCP handshake/request timed out.")), Math.min(Math.max(input.timeoutMs, 50), input.preserveRuntimeTimeout ? 60_000 : 30_000));
      send({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "paperclip-governed-tools", version: "1" } } });
    });
  } finally { if (timer) clearTimeout(timer); await stop(); }
}

export async function probeInterpreter(command: "python" | "python3" | "node" | "git", cwd: string, searchPath?: string): Promise<AgentPreflightCheck> {
  const code = `interpreter:${command}`;
  try {
    const { child, stop } = await startConfined({ command, args: ["--version"], cwd, env: searchPath ? { PATH: searchPath } : {} });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      const version = await new Promise<string>((resolve, reject) => {
        let output = "";
        for (const stream of [child.stdout, child.stderr]) stream.on("data", chunk => { output = (output + String(chunk)).slice(0, 1024); });
        child.once("error", () => reject(fail("confinement_unverified", "The confined interpreter could not start.")));
        child.once("exit", exitCode => {
          const match = output.match(/(?:Python |git version |v)\d+\.\d+(?:\.\d+)?/);
          if (exitCode === 0 && match) resolve(match[0]); else reject(fail("interpreter_probe_failed", "The confined version probe did not succeed."));
        });
        timer = setTimeout(() => reject(fail("interpreter_timeout", "Interpreter version probe timed out.")), 3000);
      });
      return { code, status: "resolved", message: `${command} resolved and answered its fixed version probe.`, detail: version };
    } finally { if (timer) clearTimeout(timer); await stop(); }
  } catch (error) { return { code, status: error instanceof GovernedProbeError && error.code.includes("unverified") ? "unverified" : "error", message: error instanceof GovernedProbeError ? error.message : "Interpreter probe failed." }; }
}
