import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { expect, it, vi } from "vitest";
import { WorkspaceGitOperationScheduler } from "./workspace-git-operation-scheduler.js";
import { logger } from "../middleware/logger.js";

it("measures tracked archives, untracked work and ignored runtime files through one Git owner", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "paperclip-runtime-git-measurement-"));
  const metrics: Array<{ operation: string; queueWaitMs: number; executionMs: number }> = [];
  const info = vi.spyOn(logger, "info").mockImplementation((data: any) => { if (data.event === "workspace_git_scan") metrics.push({ operation: data.operation, queueWaitMs: data.queueWaitMs, executionMs: data.executionMs }); });
  const git = async (...args: string[]) => promisify(execFile)("git", ["-C", root, ...args]);
  try {
    const seedingStart = performance.now();
    for (const folder of ["tracked", "archive", "untracked", ".paperclip-runtime"]) await fs.mkdir(path.join(root, folder));
    await fs.writeFile(path.join(root, ".gitignore"), ".paperclip-runtime/\n");
    await Promise.all(Array.from({ length: 1_000 }, async (_, i) => {
      await Promise.all([fs.writeFile(path.join(root, "archive", `${i}.txt`), "synthetic archive"), fs.writeFile(path.join(root, "untracked", `${i}.txt`), "synthetic work"), fs.writeFile(path.join(root, ".paperclip-runtime", `${i}.txt`), "synthetic ignored runtime")]);
    }));
    await fs.writeFile(path.join(root, "tracked", "active.txt"), "active source");
    await git("init", "-q"); await git("add", ".gitignore", "tracked", "archive");
    await git("-c", "user.name=Synthetic", "-c", "user.email=synthetic@example.invalid", "commit", "-qm", "Synthetic measurement");
    const seedingMs = performance.now() - seedingStart;
    const scheduler = new WorkspaceGitOperationScheduler({ concurrency: 1, timeoutMs: 8_000 });
    const scan = (args: string[], operation: string, cacheTtlMs = 0) => scheduler.run({ workspacePath: root, args, operation, cacheTtlMs, fairnessKeys: ["synthetic-company"] });
    const requests = Array.from({ length: 8 }, () => scan(["status", "--porcelain=v1", "-z", "--untracked-files=all"], "measurement_status", 1_000));
    requests.push(scan(["ls-files", "-z"], "measurement_tracked"));
    const results = await Promise.all(requests);
    expect(results[0]!.stdout.split("\0").filter(Boolean)).toHaveLength(1_000);
    expect(results[0]!.stdout).not.toContain(".paperclip-runtime");
    expect(results.at(-1)!.stdout.split("\0").filter(Boolean)).toHaveLength(1_002);
    expect(results.at(-1)!.stdout).toContain("archive/");
    expect(scheduler.snapshot().totals.singleFlightJoins).toBeGreaterThanOrEqual(1);
    expect(scheduler.snapshot().totals.started).toBe(2);
    const report = { synthetic: true, tracked: 1_002, trackedArchive: 1_000, untracked: 1_000, ignored: 1_000, seedingMs, scans: metrics, totals: scheduler.snapshot().totals };
    if (process.env.PAPERCLIP_RUNTIME_GIT_MEASUREMENT_OUTPUT) await fs.writeFile(process.env.PAPERCLIP_RUNTIME_GIT_MEASUREMENT_OUTPUT, JSON.stringify(report, null, 2) + "\n");
  } finally { info.mockRestore(); await fs.rm(root, { recursive: true, force: true }); }
}, 30_000);
