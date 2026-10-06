import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { afterEach, expect, it } from "vitest";
import * as processUtils from "./server-utils.js";
import type { WorkspaceProcessGuard, WorkspaceLaunchIdentity } from "./workspace-process-guard.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map(p => fs.rm(p, { recursive: true, force: true }))); });

it("does not allow an argv-driven write before durable launch identity commits", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-write-guard-")); directories.push(root);
  const stat = await fs.stat(root);
  const runWithGuard = (processUtils as any).withWorkspaceProcessGuard;
  expect(runWithGuard).toBeTypeOf("function");
  let unknown = 0;
  await expect(runWithGuard({
    root, device: String(stat.dev), inode: String(stat.ino), signal: new AbortController().signal,
    beforeLaunch: async () => "launch-1",
    bindLaunch: async () => { throw new Error("identity commit failed"); },
    recordDrain: async () => {},
    markUnknown: async () => { unknown++; },
  }, () => processUtils.runChildProcess("guard-test", "/bin/sh", ["-c", "printf unsafe > sentinel"], {
    cwd: root, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
  }))).rejects.toThrow("identity commit failed");
  expect(await fs.readFile(path.join(root, "sentinel"), "utf8").catch(() => null)).toBeNull();
  expect(unknown).toBe(1);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-write-guard-")); directories.push(root);
  const stat = await fs.stat(root);
  const controller = new AbortController();
  const launches: WorkspaceLaunchIdentity[] = [], drains: WorkspaceLaunchIdentity[] = [];
  const guard: WorkspaceProcessGuard = { root, device: String(stat.dev), inode: String(stat.ino), signal: controller.signal,
    beforeLaunch: async () => "launch-1", bindLaunch: async identity => { launches.push(identity); },
    bindPayload: async identity => {
      expect(identity).toMatchObject(launches[launches.length - 1]!);
      launches[launches.length - 1] = identity;
    },
    recordDrain: async identity => { drains.push(identity); }, markUnknown: async () => {},
  };
  return { root, guard, controller, launches, drains };
}

it("writes only after launch commit and records physical namespace drain", async () => {
  const f = await fixture(); let committed = false, payloadCommitted = false;
  f.guard.bindLaunch = async identity => {
    expect(await fs.readFile(path.join(f.root, "sentinel"), "utf8").catch(() => null)).toBeNull();
    committed = true; f.launches.push(identity);
  };
  const commitPayload = f.guard.bindPayload!;
  f.guard.bindPayload = async identity => {
    expect(committed).toBe(true);
    expect(await fs.readFile(path.join(f.root, "sentinel"), "utf8").catch(() => null)).toBeNull();
    expect(identity.payloadPid).toBeGreaterThan(0);
    expect(identity.payloadStart).toBeTruthy();
    await commitPayload(identity); payloadCommitted = true;
  };
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("success", "/bin/sh", ["-c", "printf safe > sentinel"], {
    cwd: f.root, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {},
  }));
  expect(result.exitCode, result.stderr).toBe(0); expect(committed).toBe(true); expect(payloadCommitted).toBe(true);
  expect(await fs.readFile(path.join(f.root, "sentinel"), "utf8")).toBe("safe");
  expect(f.drains).toEqual(f.launches); expect(f.drains).toHaveLength(1);
});

it("cancel drains a setsid descendant before returning and prevents its delayed file write", async () => {
  const f = await fixture();
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("escape", "/bin/sh", ["-c", "setsid /bin/sh -c 'printf escaped; sleep 0.25; printf unsafe > late' & wait"], {
    cwd: f.root, env: {}, timeoutSec: 2, graceSec: 1,
    onLog: async (_stream, text) => { if (text.includes("escaped")) f.controller.abort(); },
  }));
  expect(result.stdout).toContain("escaped"); expect(f.drains).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 350));
  expect(await fs.readFile(path.join(f.root, "late"), "utf8").catch(() => null)).toBeNull();
});

it("rejects a directory replaced between claim and launch", async () => {
  const f = await fixture(); const replacement = `${f.root}-replacement`; directories.push(replacement);
  await fs.rename(f.root, replacement); await fs.mkdir(f.root);
  await expect(processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("swap", "/bin/sh", ["-c", "printf unsafe > sentinel"], {
    cwd: f.root, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {},
  }))).rejects.toThrow("root changed");
  expect(f.launches).toHaveLength(0);
  expect(await fs.readdir(f.root)).toEqual([]); expect(await fs.readdir(replacement)).toEqual([]);
});

it("strips loader hooks before the outer sandbox or ACK shell can execute them", async () => {
  const f = await fixture(); const source = path.join(f.root, "loader.c"), library = path.join(f.root, "loader.so");
  await fs.writeFile(source, `#include <stdio.h>\n__attribute__((constructor)) static void effect(void) { FILE *f=fopen(${JSON.stringify(path.join(f.root, "pre-ack-loader"))},"w"); if(f){fputs("unsafe",f);fclose(f);} }\n`);
  execFileSync("/usr/bin/cc", ["-shared", "-fPIC", source, "-o", library]);
  f.guard.bindLaunch = async () => { throw new Error("reject identity"); };
  await expect(processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("loader", "/bin/true", [], {
    cwd: f.root, env: { LD_PRELOAD: library }, timeoutSec: 2, graceSec: 1, onLog: async () => {},
  }))).rejects.toThrow("reject identity");
  expect(await fs.readFile(path.join(f.root, "pre-ack-loader"), "utf8").catch(() => null)).toBeNull();
});


it("host read-only source interval refuses write-and-restore while allowing temporary test output", async () => {
  const f = await fixture();
  await fs.writeFile(path.join(f.root, "source"), "original");
  (f.guard as WorkspaceProcessGuard & { sourceAccess: string }).sourceAccess = "ro";
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("readonly", "/bin/sh", ["-c", "if printf altered > source; then printf original > source; exit 42; fi; printf output > /tmp/test-output; cat source; cat /tmp/test-output"], {
    cwd: f.root, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {},
  }));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("originaloutput");
  expect(result.stderr).toMatch(/Read-only file system/);
  expect(f.drains).toHaveLength(1);
  expect(await fs.readFile(path.join(f.root, "source"), "utf8")).toBe("original");
});

it("executes the real Codex sandbox tool under workspace protection without inference", async () => {
  const f = await fixture();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pc-tool-home-")); directories.push(home);
  f.guard.privateRoots = [home];
  await fs.writeFile(path.join(f.root, "source"), "original");
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("codex-tool", "codex", [
    "sandbox", "--permission-profile", ":workspace", "-C", f.root, "--", "/usr/bin/python3", "-c",
    "from pathlib import Path; assert Path('source').read_text() == 'original'; assert 2 + 2 == 4; Path('report').write_text('tiny_test_passed', encoding='utf8'); print('tiny_test_passed')",
  ], { cwd: f.root, env: { CODEX_HOME: home }, timeoutSec: 15, graceSec: 1, onLog: async () => {} }));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("tiny_test_passed");
  expect(await fs.readFile(path.join(f.root, "report"), "utf8")).toBe("tiny_test_passed");
  expect(f.drains).toHaveLength(1);
});

it("keeps actual Codex audit tools read-only inside the protected namespace", async () => {
  const f = await fixture(); f.guard.sourceAccess = "ro";
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pc-tool-home-")); directories.push(home);
  f.guard.privateRoots = [home];
  await fs.writeFile(path.join(f.root, "source"), "original");
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("codex-audit-tool", "codex", [
    "sandbox", "--permission-profile", ":read-only", "-C", f.root, "--", "/usr/bin/python3", "-c",
    "from pathlib import Path; import sys; assert Path('source').read_text() == 'original'\ntry: Path('source').write_text('changed', encoding='utf8')\nexcept OSError as error: print('write_denied', error.errno); sys.exit(0)\nsys.exit(42)",
  ], { cwd: f.root, env: { CODEX_HOME: home, CODEX_API_KEY: "" }, timeoutSec: 15, graceSec: 1, onLog: async () => {} }));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toMatch(/write_denied (1|13|30)/);
  expect(await fs.readFile(path.join(f.root, "source"), "utf8")).toBe("original");
  expect(f.drains).toHaveLength(1);
});

it("prevents a descendant user namespace from killing the outer custodian or reassociating namespaces", async () => {
  const f = await fixture();
  const script = [
    "import ctypes, errno, os, signal",
    "libc = ctypes.CDLL(None, use_errno=True)",
    "assert libc.unshare(0x10000000) == 0", // Real nested user namespace
    "checks = [lambda: libc.kill(1, 9), lambda: libc.kill(-1, 0),",
    "lambda: libc.syscall(424, -1, 9, 0, 0), lambda: libc.syscall(438, -1, 1, 0),",
    "lambda: libc.setns(-1, 0), lambda: libc.ptrace(0, 0, 0, 0),",
    "lambda: libc.process_vm_writev(1, 0, 0, 0, 0, 0)]",
    "for check in checks:",
    " ctypes.set_errno(0); assert check() == -1; assert ctypes.get_errno() == errno.EPERM",
    "assert libc.setpgid(0, 1) == -1", // Cannot join the custodian session
    "os.kill(0, 0)",
    "for target in ['/proc/1/mem', '/proc/1/task/1/mem', '/proc/self/root/proc/1/mem', '/proc/thread-self/root/proc/1/mem']:",
    " try: fd = os.open(target, os.O_RDWR)",
    " except FileNotFoundError: pass",
    " else: os.close(fd); raise AssertionError('custodian memory exposed')",
    "pid = os.fork()",
    "if pid == 0: signal.pause(); os._exit(0)",
    "os.kill(pid, signal.SIGTERM); os.waitpid(pid, 0)",
    "print('custodian_protected_and_child_signals_work')",
  ].join("\n");
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("custodian", "/usr/bin/python3", ["-c", script], {
    cwd: f.root, env: {}, timeoutSec: 5, graceSec: 1, onLog: async () => {},
  }));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toContain("custodian_protected_and_child_signals_work");
  expect(f.drains).toHaveLength(1);
});

it("Stop drains real nested Codex tool descendants and a second protected task writes successfully", async () => {
  const f = await fixture();
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pc-tool-home-")); directories.push(home);
  f.guard.privateRoots = [home];
  const tool = "import os, subprocess, sys, time\nfrom pathlib import Path\np = subprocess.Popen(['/bin/sh', '-c', 'sleep 0.5; printf unsafe > late'], start_new_session=True)\nprint('nested-tool-ready', flush=True)\np.wait()";
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("nested-stop", "codex", [
    "sandbox", "--permission-profile", ":workspace", "-C", f.root, "--", "/usr/bin/python3", "-c", tool,
  ], { cwd: f.root, env: { CODEX_HOME: home }, timeoutSec: 5, graceSec: 1,
    onLog: async (_stream, text) => { if (text.includes("nested-tool-ready")) f.controller.abort(); },
  }));
  expect(result.stdout).toContain("nested-tool-ready");
  expect(f.drains).toHaveLength(1);
  await new Promise(resolve => setTimeout(resolve, 650));
  expect(await fs.readFile(path.join(f.root, "late"), "utf8").catch(() => null)).toBeNull();
  const next = { ...f.guard, signal: new AbortController().signal, beforeLaunch: async () => "launch-2" };
  const second = await processUtils.withWorkspaceProcessGuard(next, () => processUtils.runChildProcess("second", "/bin/sh", ["-c", "printf safe > second"], {
    cwd: f.root, env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {},
  }));
  expect(second.exitCode, second.stderr).toBe(0);
  expect(await fs.readFile(path.join(f.root, "second"), "utf8")).toBe("safe");
  expect(f.drains).toHaveLength(2);
});

it("GNU timeout cancels a tool's whole process group while the employee stays alive", async () => {
  const f = await fixture();
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("tool-timeout", "/bin/sh", ["-c",
    "timeout 0.15 sh -c '(sleep 0.45; printf unsafe > late) & wait'; code=$?; sleep 0.65; test ! -e late || exit 42; printf timeout_exit=%s $code",
  ], { cwd: f.root, env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {} }));
  expect(result.exitCode, result.stderr).toBe(0);
  expect(result.stdout).toBe("timeout_exit=124");
  expect(await fs.readFile(path.join(f.root, "late"), "utf8").catch(() => null)).toBeNull();
  expect(f.drains).toHaveLength(1);
});

it.each(["/proc", "/proc/sys", "/"])("rejects a raw host proc mount before claiming a protected process: %s", async procPath => {
  const f = await fixture();
  await expect(processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("proc-alias", "/bin/true", [], {
    cwd: f.root, env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {},
    localProcessSandbox: { workspaceDir: f.root, extraPaths: [{ path: procPath, access: "ro" }] },
  }))).rejects.toThrow("raw host proc");
  expect(f.launches).toHaveLength(0);
});

it("pins the exact namespace object until the host durably records its drain", async () => {
  const f = await fixture(); let pinned: string | undefined;
  f.guard.recordDrain = async identity => {
    for (const fd of await fs.readdir("/proc/self/fd")) {
      if (await fs.readlink(`/proc/self/fd/${fd}`).catch(() => null) === identity.namespace) { pinned = fd; break; }
    }
    expect(pinned).toBeTruthy();
    const ns = await fs.stat(`/proc/self/fd/${pinned}`);
    expect(identity.namespace).toBe(`pid:[${ns.ino}]`);
    f.drains.push(identity);
  };
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("pinned-drain", "/bin/true", [], {
    cwd: f.root, env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {},
  }));
  expect(result.exitCode).toBe(0);
  expect(await fs.readlink(`/proc/self/fd/${pinned}`).catch(() => null)).not.toBe(f.drains[0]!.namespace);
});

it("waits for actual kernel exit instead of treating the first live observation as a failed drain", async () => {
  const f = await fixture(); let ready!: () => void; const started = new Promise<void>(resolve => { ready = resolve; });
  const pending = processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("kernel-exit", "/bin/sh", ["-c", "printf ready; sleep 10"], {
    cwd: f.root, env: {}, timeoutSec: 3, graceSec: 1, onLog: async (_stream, text) => { if (text.includes("ready")) ready(); },
  }));
  await started;
  const proof = await import("./workspace-process-guard.js");
  const wait = (proof as any).waitForWorkspaceNamespaceDrain ?? proof.workspaceNamespaceDrained;
  const stopping = wait(f.launches[0]!, 500);
  setTimeout(() => f.controller.abort(), 30);
  try { expect(await stopping).toBe(true); } finally { f.controller.abort(); await pending; }
  expect(f.drains).toHaveLength(1);
});
