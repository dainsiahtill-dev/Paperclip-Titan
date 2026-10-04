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
    recordDrain: async identity => { drains.push(identity); }, markUnknown: async () => {},
  };
  return { root, guard, controller, launches, drains };
}

it("writes only after launch commit and records physical namespace drain", async () => {
  const f = await fixture(); let committed = false;
  f.guard.bindLaunch = async identity => {
    expect(await fs.readFile(path.join(f.root, "sentinel"), "utf8").catch(() => null)).toBeNull();
    committed = true; f.launches.push(identity);
  };
  const result = await processUtils.withWorkspaceProcessGuard(f.guard, () => processUtils.runChildProcess("success", "/bin/sh", ["-c", "printf safe > sentinel"], {
    cwd: f.root, env: {}, timeoutSec: 2, graceSec: 1, onLog: async () => {},
  }));
  expect(result.exitCode, result.stderr).toBe(0); expect(committed).toBe(true);
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
