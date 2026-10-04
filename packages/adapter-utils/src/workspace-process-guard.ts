import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import type { Duplex } from "node:stream";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";
import { ensurePathInEnv, resolveCommandForLogs, sanitizeInheritedPaperclipEnv, type runChildProcess, type RunProcessResult } from "./server-utils.js";

export type WorkspaceLaunchIdentity = {
  launchId: string; pid: number; processGroupId: number; startedAt: string;
  namespacePid: number; namespace: string; namespaceStart: string; bootId: string;
  observerNamespace: string; observerMountNamespace: string; sourceAccess?: "ro";
};

/** Host closures only. Never serialize this capability into agent config/env. */
export interface WorkspaceProcessGuard {
  root: string; device: string; inode: string; signal?: AbortSignal;
  /** Exact server-derived credential/runtime roots, never adapter extraPaths. */
  privateRoots?: string[];
  /** Host-owned verification capability; never read from adapter or API JSON. */
  sourceAccess?: "ro";
  beforeLaunch(): Promise<string>;
  bindLaunch(identity: WorkspaceLaunchIdentity): Promise<void>;
  recordDrain(identity: WorkspaceLaunchIdentity): Promise<void>;
  markUnknown(launchId: string): Promise<void>;
  markStopping?(): Promise<void>;
}
const scope = new AsyncLocalStorage<WorkspaceProcessGuard>();
export const withWorkspaceProcessGuard = <T>(guard: WorkspaceProcessGuard, work: () => Promise<T>): Promise<T> => scope.run(guard, work);
export const currentWorkspaceProcessGuard = () => scope.getStore();

async function processStart(pid: number) {
  const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
  return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]!;
}

/** Exact kernel namespace proof; a wall-clock timeout never produces a receipt. */
export async function workspaceNamespaceDrained(identity: WorkspaceLaunchIdentity): Promise<boolean> {
  if (process.platform !== "linux" || (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim() !== identity.bootId) return false;
  if (await fs.readlink("/proc/self/ns/pid") !== identity.observerNamespace || await fs.readlink("/proc/self/ns/mnt") !== identity.observerMountNamespace) return false;
  try {
    if (await processStart(identity.namespacePid) === identity.namespaceStart) {
      const stat = await fs.readFile(`/proc/${identity.namespacePid}/stat`, "utf8");
      if (!["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!)) return false;
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") return false; }
  for (const entry of await fs.readdir("/proc")) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      if (await fs.readlink(`/proc/${entry}/ns/pid`) !== identity.namespace) continue;
      const stat = await fs.readFile(`/proc/${entry}/stat`, "utf8");
      if (!["Z", "X"].includes(stat.slice(stat.lastIndexOf(")") + 2).split(" ")[0]!)) return false;
    } catch (error) {
      // Other users' namespaces are outside this same-uid, cap-dropped realm.
      if (!["ENOENT", "EACCES", "EPERM"].includes((error as NodeJS.ErrnoException).code ?? "")) return false;
    }
  }
  return true;
}

export async function runGuardedWorkspaceProcess(
  guard: WorkspaceProcessGuard, runId: string, command: string, args: string[], opts: Parameters<typeof runChildProcess>[3],
): Promise<RunProcessResult> {
  if (process.platform !== "linux" || opts.remoteExecution) throw new Error("Protected workspace requires a supported local Linux process");
  const signals = [opts.signal, guard.signal].filter((value): value is AbortSignal => Boolean(value));
  const signal = signals.length ? AbortSignal.any(signals) : undefined;
  signal?.throwIfAborted();
  const root = await fs.realpath(guard.root);
  if (root !== guard.root) throw new Error("Protected workspace root changed before launch");
  const anchor = await fs.open(root, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let target: Awaited<ReturnType<typeof buildLocalProcessSandboxSpawnTarget>> | undefined;
  let launchId: string | undefined;
  const privateAnchors: Array<{ root: string; handle: Awaited<ReturnType<typeof fs.open>> }> = [];
  try {
    const stat = await anchor.stat();
    if (String(stat.dev) !== guard.device || String(stat.ino) !== guard.inode) throw new Error("Protected workspace root changed before launch");
    const cwd = await fs.realpath(opts.cwd);
    const relative = path.relative(root, cwd);
    if (relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error("Protected process cwd is outside its writable root");
    const sandbox = opts.localProcessSandbox;
    const env = ensurePathInEnv({ ...sanitizeInheritedPaperclipEnv(process.env), ...opts.env });
    for (const key of ["CLAUDECODE", "CLAUDE_CODE_ENTRYPOINT", "CLAUDE_CODE_SESSION", "CLAUDE_CODE_PARENT_SESSION"]) delete env[key];
    // These affect bwrap/the ACK shell itself, before the provider gate. Do
    // not allow dynamic-loader constructors or shell startup hooks to run
    // with the controller's unconfined filesystem authority.
    for (const key of Object.keys(env)) {
      if (/^(LD_|DYLD_|BASH_FUNC_)/.test(key) || ["ENV", "BASH_ENV", "SHELLOPTS", "BASHOPTS", "GCONV_PATH", "LOCPATH", "GLIBC_TUNABLES"].includes(key)) delete env[key];
    }
    if (sandbox?.homeDir) env.HOME = sandbox.homeDir;
    const executable = await resolveCommandForLogs(command, cwd, env);
    for (const candidate of guard.privateRoots ?? []) {
      const canonical = await fs.realpath(candidate).catch(() => null);
      if (!canonical) continue;
      if (canonical !== path.resolve(candidate)) throw new Error("Protected runtime root must not be a symlink");
      const inside = (a: string, b: string) => { const rel = path.relative(a, b); return !rel || (!rel.startsWith("..") && !path.isAbsolute(rel)); };
      if (inside(canonical, root) || inside(root, canonical)) throw new Error("Protected runtime root overlaps source workspace");
      const handle = await fs.open(canonical, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const st = await handle.stat();
      if (st.uid !== process.getuid?.()) { await handle.close(); throw new Error("Protected runtime root owner is unverified"); }
      privateAnchors.push({ root: canonical, handle });
    }
    if (sandbox?.pathAliases?.length) throw new Error("Protected workspace path aliases require pinned mount support");
    for (const extra of [...(sandbox?.managedPaths ?? []), ...(sandbox?.extraPaths ?? [])]) {
      if (extra.access !== "rw") continue;
      const candidate = await fs.realpath(extra.path);
      if (candidate !== root && !privateAnchors.some(entry => entry.root === candidate)) throw new Error("Protected workspace disallows additional writable roots");
    }
    target = await buildLocalProcessSandboxSpawnTarget({ executable, args, cwd, options: {
      ...sandbox, command: "/usr/bin/bwrap", filesystemScope: "workspace", workspaceDir: root,
      workspaceAccess: guard.sourceAccess ?? "rw", managedPaths: [...(sandbox?.managedPaths?.filter(p => p.access === "ro") ?? []), ...privateAnchors.map(entry => ({ path: entry.root, access: "rw" as const }))],
      extraPaths: sandbox?.extraPaths?.filter(p => p.access === "ro"),
    } });
    const mount = target.args.findIndex((value, index) => ["--bind", "--ro-bind"].includes(value) && target!.args[index + 1] === root && target!.args[index + 2] === root);
    if (mount < 0) throw new Error("Protected workspace writable mount missing");
    target.args.splice(mount, 3, guard.sourceAccess === "ro" ? "--ro-bind-fd" : "--bind-fd", "4", root);
    for (const [index, entry] of privateAnchors.entries()) {
      const position = target.args.findIndex((value, offset) => value === "--bind" && target!.args[offset + 1] === entry.root && target!.args[offset + 2] === entry.root);
      if (position < 0) throw new Error("Protected runtime mount missing");
      target.args.splice(position, 3, "--bind-fd", String(index + 6), entry.root);
    }
    target.args.unshift("--unshare-user", "--disable-userns", "--cap-drop", "ALL", "--block-fd", "3", "--json-status-fd", "5");
    // bwrap --block-fd also wakes on EOF. A dead controller must not turn
    // that EOF into permission to exec an argv-driven writer. The inner gate
    // accepts one explicit host nonce; it consumes only its line, preserving
    // the provider's remaining stdin. It performs no source/runtime writes.
    const acknowledgement = randomUUID();
    const payload = target.args.indexOf("--");
    if (payload < 0) throw new Error("Protected process payload boundary missing");
    target.args.splice(payload + 1, 0, "/bin/sh", "-c", 'IFS= read -r ack && [ "$ack" = "$1" ] || exit 125; shift; exec "$@"', "paperclip-launch-gate", acknowledgement);
    launchId = await guard.beforeLaunch();
    signal?.throwIfAborted();
    const startedAt = new Date().toISOString();
    const child = spawn(target.command, target.args, { cwd, env: { ...env, ...target.env },
      detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", anchor.fd, "pipe", ...privateAnchors.map(entry => entry.handle.fd)] });
    const gate = child.stdio[3] as Duplex;
    const status = (child.stdio as unknown as Duplex[])[5]!;
    let stdout = "", stderr = "", statusText = "", timedOut = false;
    let launchError: unknown;
    let identity: WorkspaceLaunchIdentity | undefined;
    let namespacePid: number | undefined;
    let namespaceStart: string | undefined;
    let committing: Promise<void> | undefined;
    let logChain = Promise.resolve();
    let stopping: Promise<void> | undefined;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalCleanup = false;
    const stop = () => {
      stopping ??= guard.markStopping?.().catch(error => { launchError ??= error; }) ?? Promise.resolve();
      // During --block-fd setup bwrap has not installed every parent-death
      // handler yet. Kill the namespace init before closing any gate fd.
      if (namespacePid && namespaceStart) { try {
        const stat = readFileSync(`/proc/${namespacePid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] === namespaceStart) process.kill(namespacePid, "SIGKILL");
      } catch (error) { if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) launchError ??= error; } }
      child.kill("SIGKILL");
    };
    const timeout = opts.timeoutSec > 0 ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutSec * 1000) : null;
    signal?.addEventListener("abort", stop, { once: true });
    const log = (stream: "stdout" | "stderr", chunk: unknown) => {
      if (stream === "stdout") stdout = (stdout + String(chunk)).slice(-4_000_000);
      else stderr = (stderr + String(chunk)).slice(-4_000_000);
      logChain = logChain.then(() => opts.onLog(stream, String(chunk))).catch(error => { opts.onLogError?.(error, runId, "failed to append protected process log"); });
      try {
        if (!terminalTimer && opts.terminalResultCleanup?.hasTerminalResult({ stdout, stderr })) {
          terminalTimer = setTimeout(() => { terminalCleanup = true; stop(); }, Math.max(0, opts.terminalResultCleanup.graceMs ?? 5_000));
        }
      } catch (error) { opts.onLogError?.(error, runId, "failed to inspect protected process output"); }
    };
    child.stdout?.on("data", chunk => log("stdout", chunk));
    child.stderr?.on("data", chunk => log("stderr", chunk));
    // EOF is not an ACK. Keep the write side open on failure until namespace death.
    gate.on("error", error => { launchError ??= error; stop(); });
    status.on("error", error => { launchError ??= error; stop(); });
    child.stdin?.on("error", error => { if ((error as NodeJS.ErrnoException).code !== "EPIPE") { launchError ??= error; stop(); } });
    status.on("data", chunk => {
      statusText += String(chunk);
      for (;;) {
        const newline = statusText.indexOf("\n"); if (newline < 0) break;
        const line = statusText.slice(0, newline); statusText = statusText.slice(newline + 1);
        let info: Record<string, unknown>; try { info = JSON.parse(line); } catch { continue; }
        if (typeof info["child-pid"] !== "number" || committing) continue;
        namespacePid = info["child-pid"] as number;
        try { const stat = readFileSync(`/proc/${namespacePid}/stat`, "utf8"); namespaceStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; }
        catch (error) { launchError = error; stop(); continue; }
        committing = (async () => {
          identity = { ...(guard.sourceAccess === "ro" ? { sourceAccess: "ro" as const } : {}), launchId: launchId!, pid: child.pid!, processGroupId: child.pid!, startedAt,
            namespacePid: namespacePid!, namespace: await fs.readlink(`/proc/${namespacePid}/ns/pid`),
            namespaceStart: await processStart(namespacePid!), bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
            observerNamespace: await fs.readlink("/proc/self/ns/pid"), observerMountNamespace: await fs.readlink("/proc/self/ns/mnt") };
          if (identity.namespace === await fs.readlink("/proc/self/ns/pid")) throw new Error("Protected process namespace was not isolated");
          await guard.bindLaunch(identity);
          await opts.onSpawn?.({ pid: child.pid!, processGroupId: child.pid!, startedAt });
          const current = await fs.stat(guard.root);
          if (String(current.dev) !== guard.device || String(current.ino) !== guard.inode) throw new Error("Protected workspace root changed before launch ACK");
          for (const entry of privateAnchors) {
            const pinned = await entry.handle.stat(), selected = await fs.stat(entry.root);
            if (pinned.dev !== selected.dev || pinned.ino !== selected.ino) throw new Error("Protected runtime root changed before launch ACK");
          }
          signal?.throwIfAborted();
          gate.write("1");
          child.stdin?.end(`${acknowledgement}\n${opts.stdin ?? ""}`);
        })().catch(error => { launchError = error; stop(); });
      }
    });
    if (signal?.aborted) stop();
    child.on("exit", () => { stop(); gate.destroy(); child.stdin?.destroy(); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject); child.on("close", (code, stoppedSignal) => resolve({ code, signal: stoppedSignal }));
    }).finally(() => { if (timeout) clearTimeout(timeout); if (terminalTimer) clearTimeout(terminalTimer); signal?.removeEventListener("abort", stop); });
    await committing;
    await stopping;
    await logChain;
    if (launchError) throw launchError;
    if (!identity) throw new Error(`Protected process did not establish a namespace identity: ${stderr}`);
    if (!await workspaceNamespaceDrained(identity)) throw new Error("Protected process namespace drain unverified");
    await guard.recordDrain(identity);
    return { exitCode: result.code, signal: result.signal, timedOut, stdout, stderr, pid: child.pid ?? null, startedAt,
      ...(terminalCleanup ? { terminalResultCleanup: { kind: "terminal_result_cleanup" as const, stopped: true as const,
        stopReason: "unmanaged_background_task_stopped" as const, reason: "unmanaged background task stopped; no durable live path" as const,
        terminalResultSeen: true, signal: "SIGKILL" as const, forceKilled: true } } : {}),
    };
  } catch (error) {
    if (launchId) await guard.markUnknown(launchId);
    throw error;
  } finally { await anchor.close(); await Promise.all(privateAnchors.map(entry => entry.handle.close())); await target?.cleanup?.(); }
}
