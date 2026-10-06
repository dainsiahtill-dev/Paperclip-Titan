import { AsyncLocalStorage } from "node:async_hooks";
import { spawn } from "node:child_process";
import fs, { constants } from "node:fs/promises";
import path from "node:path";
import { readFileSync, readlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import os from "node:os";
import type { Duplex } from "node:stream";
import { buildLocalProcessSandboxSpawnTarget } from "./local-process-sandbox.js";
import { workspaceCustodianSeccomp } from "./workspace-custodian-seccomp.js";
import { ensurePathInEnv, resolveCommandForLogs, sanitizeInheritedPaperclipEnv, type runChildProcess, type RunProcessResult } from "./server-utils.js";

export type WorkspaceLaunchIdentity = {
  launchId: string; pid: number; processGroupId: number; startedAt: string;
  namespacePid: number; namespace: string; namespaceStart: string; bootId: string;
  observerNamespace: string; observerMountNamespace: string; sourceAccess?: "ro";
  payloadPid?: number; payloadStart?: string; payloadMountNamespace?: string;
};

export type WorkspaceStopObservation = { requestId: string | null; signal: NodeJS.Signals | null; forced: boolean };

/** Host closures only. Never serialize this capability into agent config/env. */
export interface WorkspaceProcessGuard {
  root: string; device: string; inode: string; signal?: AbortSignal;
  /** Exact server-derived credential/runtime roots, never adapter extraPaths. */
  privateRoots?: string[];
  /** Host-owned verification capability; never read from adapter or API JSON. */
  sourceAccess?: "ro";
  beforeLaunch(): Promise<string>;
  bindLaunch(identity: WorkspaceLaunchIdentity): Promise<void>;
  bindPayload?(identity: WorkspaceLaunchIdentity): Promise<void>;
  recordDrain(identity: WorkspaceLaunchIdentity, stop?: WorkspaceStopObservation): Promise<void>;
  markUnknown(launchId: string): Promise<void>;
  markStopping?(launchId?: string): Promise<void>;
  cancelBeforeSpawn?(launchId: string): Promise<void>;
  stopPolicy?: () => { signal: NodeJS.Signals; graceMs: number; requestId?: string };
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

/** SIGKILL and wrapper close do not synchronously finish kernel namespace
 * teardown. Retry the SAME strict proof briefly; timeout never becomes proof. */
export async function waitForWorkspaceNamespaceDrain(identity: WorkspaceLaunchIdentity, maxWaitMs = 1000): Promise<boolean> {
  const deadline = performance.now() + Math.min(1000, Math.max(0, Number.isFinite(maxWaitMs) ? maxWaitMs : 0));
  for (;;) {
    if (await workspaceNamespaceDrained(identity)) return true;
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, Math.min(10, Math.max(0, deadline - performance.now()))));
  }
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
  let spawned = false;
  let filterDirectory: string | undefined;
  let filter: Awaited<ReturnType<typeof fs.open>> | undefined;
  let namespacePin: Awaited<ReturnType<typeof fs.open>> | undefined;
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
      if (extra.access !== "rw") {
        const candidate = await fs.realpath(extra.path).catch(() => null);
        if (candidate) {
          const contains = (a: string, b: string) => { const rel = path.relative(a, b); return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
          if (contains(candidate, "/proc") || contains("/proc", candidate))
            throw new Error("Protected workspace disallows raw host proc mounts");
        }
        continue;
      }
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
      target.args.splice(position, 3, "--bind-fd", String(index + 7), entry.root);
    }
    const filterBytes = workspaceCustodianSeccomp();
    filterDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "pc-custodian-"));
    const filterPath = path.join(filterDirectory, "policy.bpf");
    await fs.writeFile(filterPath, filterBytes, { mode: 0o600 });
    filter = await fs.open(filterPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    // Descendant user namespaces are required by Codex's real tool sandbox.
    // Keep the PID lifetime boundary protected by an inherited kernel filter.
    target.args.unshift("--unshare-user", "--cap-drop", "ALL", "--seccomp", "6", "--block-fd", "3", "--json-status-fd", "5");
    // bwrap --block-fd also wakes on EOF. A dead controller must not turn
    // that EOF into permission to exec an argv-driven writer. The inner gate
    // accepts one explicit host nonce; it consumes only its line, preserving
    // the provider's remaining stdin. It performs no source/runtime writes.
    const acknowledgement = randomUUID();
    const bootstrapScript = 'IFS= read -r ack && [ "$ack" = "$1" ] || exit 125; shift; exec "$@"';
    const payload = target.args.indexOf("--");
    if (payload < 0) throw new Error("Protected process payload boundary missing");
    // Install the private procfs LAST, so an extra RO /proc or ancestor mount
    // cannot expose host processes or cover the custodian's memory mask.
    // Child userns cannot mount a new procfs for this ancestor PID namespace
    // or remove its locked proc child mount; no Yama setting is assumed.
    target.args.splice(payload, 0, "--proc", "/proc", "--tmpfs", "/proc/1", "--remount-ro", "/proc/1");
    // Give the ACK shell its own session before any provider code can run.
    // This keeps kill(0)/killpg tool cancellation away from the outer PID 1.
    target.args.splice(target.args.indexOf("--") + 1, 0, "/usr/bin/setsid", "/bin/sh", "-c", bootstrapScript, "paperclip-launch-gate", acknowledgement);
    launchId = await guard.beforeLaunch();
    signal?.throwIfAborted();
    const observer = { bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
      namespace: await fs.readlink("/proc/self/ns/pid"), mountNamespace: await fs.readlink("/proc/self/ns/mnt") };
    const startedAt = new Date().toISOString();
    const child = spawn(target.command, target.args, { cwd, env: { ...env, ...target.env },
      detached: true, stdio: ["pipe", "pipe", "pipe", "pipe", anchor.fd, "pipe", filter.fd, ...privateAnchors.map(entry => entry.handle.fd)] });
    spawned = true;
    const gate = child.stdio[3] as Duplex;
    const status = (child.stdio as unknown as Duplex[])[5]!;
    let stdout = "", stderr = "", statusText = "", timedOut = false;
    let launchError: unknown;
    let identity: WorkspaceLaunchIdentity | undefined;
    let namespacePid: number | undefined;
    let namespaceStart: string | undefined;
    let namespaceIdentity: string | undefined;
    let permissionGranted = false;
    let processBound = false;
    const stopObservation: WorkspaceStopObservation = { requestId: null, signal: null, forced: false };
    let forceTimer: ReturnType<typeof setTimeout> | undefined;
    let committing: Promise<void> | undefined;
    let logChain = Promise.resolve();
    let stopping: Promise<void> | undefined;
    let terminalTimer: ReturnType<typeof setTimeout> | undefined;
    let terminalCleanup = false;
    const signalNamespace = (requested: NodeJS.Signals) => {
      if (!namespacePid || !namespaceStart || !namespaceIdentity) return false;
      try {
        if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== observer.bootId ||
          readlinkSync("/proc/self/ns/pid") !== observer.namespace || readlinkSync("/proc/self/ns/mnt") !== observer.mountNamespace ||
          readlinkSync(`/proc/${namespacePid}/ns/pid`) !== namespaceIdentity || namespaceIdentity === observer.namespace) throw new Error("Protected stop namespace identity changed");
        const stat = readFileSync(`/proc/${namespacePid}/stat`, "utf8");
        if (stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] !== namespaceStart) throw new Error("Protected stop process identity changed");
        process.kill(namespacePid, requested);
        return true;
      } catch (error) {
        if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    };
    const signalPayload = (requested: NodeJS.Signals) => {
      if (!identity?.payloadPid || !identity.payloadStart || !identity.payloadMountNamespace)
        throw new Error("Protected payload identity is unavailable for graceful stop");
      try {
        if (readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim() !== identity.bootId ||
          readlinkSync("/proc/self/ns/pid") !== identity.observerNamespace || readlinkSync("/proc/self/ns/mnt") !== identity.observerMountNamespace ||
          readlinkSync(`/proc/${identity.payloadPid}/ns/pid`) !== identity.namespace ||
          readlinkSync(`/proc/${identity.payloadPid}/ns/mnt`) !== identity.payloadMountNamespace) throw new Error("Protected payload namespace changed");
        const stat = readFileSync(`/proc/${identity.payloadPid}/stat`, "utf8");
        const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
        if (fields[19] !== identity.payloadStart || Number(fields[1]) !== identity.namespacePid) throw new Error("Protected payload process identity changed");
        process.kill(identity.payloadPid, requested);
        return true;
      } catch (error) {
        if (!["ESRCH", "ENOENT"].includes((error as NodeJS.ErrnoException).code ?? "")) throw error;
      }
    };
    const bindBootstrapPayload = async (namespace: WorkspaceLaunchIdentity) => {
      const deadline = Date.now() + 5_000;
      while (Date.now() < deadline) {
        signal?.throwIfAborted();
        const children = (await fs.readFile(`/proc/${namespace.namespacePid}/task/${namespace.namespacePid}/children`, "utf8")).trim().split(/\s+/).filter(Boolean);
        if (children.length > 1) throw new Error("Protected bootstrap payload is ambiguous");
        if (children.length === 1) {
          const pid = Number(children[0]);
          const argv = (await fs.readFile(`/proc/${pid}/cmdline`)).toString().split("\0");
          if (argv[0] === "/bin/sh" && argv[1] === "-c" && argv[2] === bootstrapScript && argv[3] === "paperclip-launch-gate" && argv[4] === acknowledgement) {
            const stat = await fs.readFile(`/proc/${pid}/stat`, "utf8");
            const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
            if (Number(fields[1]) !== namespace.namespacePid || await fs.readlink(`/proc/${pid}/ns/pid`) !== namespace.namespace)
              throw new Error("Protected bootstrap payload binding changed");
            const initStat = await fs.readFile(`/proc/${namespace.namespacePid}/stat`, "utf8");
            const initFields = initStat.slice(initStat.lastIndexOf(")") + 2).split(" ");
            if (Number(fields[2]) !== pid || Number(fields[3]) !== pid || fields[3] === initFields[3])
              throw new Error("Protected bootstrap payload session is not isolated");
            return { ...namespace, payloadPid: pid, payloadStart: fields[19]!, payloadMountNamespace: await fs.readlink(`/proc/${pid}/ns/mnt`) };
          }
        }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error("Protected bootstrap payload did not bind before ACK");
    };
    const forceStop = () => {
      try { if (signalNamespace("SIGKILL")) stopObservation.forced = true; } catch (error) { launchError ??= error; }
      child.kill("SIGKILL");
    };
    const stop = (force = false) => {
      if (force) {
        if (forceTimer) clearTimeout(forceTimer);
        forceStop();
      }
      if (stopping) return;
      if (signal?.aborted) stopObservation.requestId = guard.stopPolicy?.().requestId ?? null;
      stopping = (async () => {
        await guard.markStopping?.(launchId);
        if (force || !permissionGranted || !guard.stopPolicy) { forceStop(); return; }
        const policy = guard.stopPolicy();
        if (signalPayload(policy.signal)) stopObservation.signal = policy.signal;
        const graceMs = Number.isFinite(policy.graceMs) ? Math.max(0, policy.graceMs) : 0;
        if (!graceMs) forceStop();
        else forceTimer = setTimeout(() => {
          // Revalidate the same durable generation/launch immediately before escalation.
          void (async () => { await guard.markStopping?.(launchId); forceStop(); })()
            .catch(error => { launchError ??= error; forceStop(); });
        }, graceMs);
      })().catch(error => { launchError ??= error; forceStop(); });
    };
    const abort = () => stop();
    const timeout = opts.timeoutSec > 0 ? setTimeout(() => { timedOut = true; stop(); }, opts.timeoutSec * 1000) : null;
    signal?.addEventListener("abort", abort, { once: true });
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
        try { const stat = readFileSync(`/proc/${namespacePid}/stat`, "utf8"); namespaceStart = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]; namespaceIdentity = readlinkSync(`/proc/${namespacePid}/ns/pid`); }
        catch (error) { launchError = error; stop(); continue; }
        committing = (async () => {
          identity = { ...(guard.sourceAccess === "ro" ? { sourceAccess: "ro" as const } : {}), launchId: launchId!, pid: child.pid!, processGroupId: child.pid!, startedAt,
            namespacePid: namespacePid!, namespace: await fs.readlink(`/proc/${namespacePid}/ns/pid`),
            namespaceStart: await processStart(namespacePid!), bootId: (await fs.readFile("/proc/sys/kernel/random/boot_id", "utf8")).trim(),
            observerNamespace: await fs.readlink("/proc/self/ns/pid"), observerMountNamespace: await fs.readlink("/proc/self/ns/mnt") };
          if (identity.namespace === await fs.readlink("/proc/self/ns/pid")) throw new Error("Protected process namespace was not isolated");
          // Retain this exact kernel namespace object through durable drain.
          // Otherwise nsfs may reuse its inode for a different live task while
          // the host is still scanning /proc. This FD never reaches the child.
          namespacePin = await fs.open(`/proc/${identity.namespacePid}/ns/pid`, constants.O_RDONLY);
          const pinnedNamespace = await namespacePin.stat();
          if (`pid:[${pinnedNamespace.ino}]` !== identity.namespace ||
            await fs.readlink(`/proc/self/fd/${namespacePin.fd}`) !== identity.namespace ||
            await processStart(identity.namespacePid) !== identity.namespaceStart)
            throw new Error("Protected namespace pin identity changed");
          await guard.bindLaunch(identity);
          await opts.onSpawn?.({ pid: child.pid!, processGroupId: child.pid!, startedAt });
          processBound = true;
          // Open only the outer setup gate. The fixed bootstrap still cannot
          // exec provider argv until its exact kernel identity is host-bound.
          gate.write("1");
          identity = await bindBootstrapPayload(identity);
          await guard.bindPayload?.(identity);
          const current = await fs.stat(guard.root);
          if (String(current.dev) !== guard.device || String(current.ino) !== guard.inode) throw new Error("Protected workspace root changed before launch ACK");
          for (const entry of privateAnchors) {
            const pinned = await entry.handle.stat(), selected = await fs.stat(entry.root);
            if (pinned.dev !== selected.dev || pinned.ino !== selected.ino) throw new Error("Protected runtime root changed before launch ACK");
          }
          signal?.throwIfAborted();
          permissionGranted = true;
          child.stdin?.end(`${acknowledgement}\n${opts.stdin ?? ""}`);
        })().catch(error => { launchError = error; stop(); });
      }
    });
    if (signal?.aborted) stop();
    child.on("exit", () => { stop(true); gate.destroy(); child.stdin?.destroy(); });
    const result = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve, reject) => {
      child.on("error", reject); child.on("close", (code, stoppedSignal) => resolve({ code, signal: stoppedSignal }));
    }).finally(() => { if (timeout) clearTimeout(timeout); if (terminalTimer) clearTimeout(terminalTimer); if (forceTimer) clearTimeout(forceTimer); signal?.removeEventListener("abort", abort); });
    await committing;
    await stopping;
    await logChain;
    if (launchError && !(signal?.aborted && launchError === signal.reason && identity && processBound)) throw launchError;
    if (!identity) throw new Error(`Protected process did not establish a namespace identity: ${stderr}`);
    if (!await waitForWorkspaceNamespaceDrain(identity)) throw new Error("Protected process namespace drain unverified");
    await guard.recordDrain(identity, stopObservation);
    return { exitCode: result.code, signal: result.signal, timedOut, stdout, stderr, pid: child.pid ?? null, startedAt,
      ...(terminalCleanup ? { terminalResultCleanup: { kind: "terminal_result_cleanup" as const, stopped: true as const,
        stopReason: "unmanaged_background_task_stopped" as const, reason: "unmanaged background task stopped; no durable live path" as const,
        terminalResultSeen: true, signal: "SIGKILL" as const, forceKilled: true } } : {}),
    };
  } catch (error) {
    if (launchId && !spawned && signal?.aborted && error === signal.reason && guard.cancelBeforeSpawn)
      await guard.cancelBeforeSpawn(launchId);
    else if (launchId) await guard.markUnknown(launchId);
    throw error;
  } finally {
    await anchor.close(); await Promise.all(privateAnchors.map(entry => entry.handle.close()));
    await filter?.close();
    await namespacePin?.close();
    if (filterDirectory) await fs.rm(filterDirectory, { recursive: true, force: true });
    await target?.cleanup?.();
  }
}
