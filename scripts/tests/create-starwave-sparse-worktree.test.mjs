import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const script = fileURLToPath(new URL("../create-starwave-sparse-worktree.mjs", import.meta.url));

function git(repo, ...args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8" }).trim();
}

function fixture(rootBytes = 0) {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), "paperclip-sparse-worktree-"));
  const repo = path.join(temp, "repo");
  const parent = path.join(temp, "worktrees");
  fs.mkdirSync(path.join(repo, "backend", "src"), { recursive: true });
  fs.mkdirSync(path.join(repo, "backend", "runtime"), { recursive: true });
  fs.mkdirSync(path.join(repo, "docs", "changes"), { recursive: true });
  fs.writeFileSync(path.join(repo, "AGENTS.md"), "engineering instructions\n");
  fs.writeFileSync(path.join(repo, "backend", "src", "app.py"), "print('hello')\n");
  fs.writeFileSync(path.join(repo, "backend", "runtime", "large.bin"), Buffer.alloc(2_000_000));
  fs.writeFileSync(path.join(repo, "docs", "changes", "plan.md"), "plan\n");
  if (rootBytes > 0) fs.writeFileSync(path.join(repo, "large-root.bin"), Buffer.alloc(rootBytes));
  execFileSync("git", ["init", "-b", "main", repo], { stdio: "ignore" });
  git(repo, "config", "user.email", "test@example.com");
  git(repo, "config", "user.name", "Test");
  git(repo, "add", ".");
  git(repo, "commit", "-m", "fixture");
  return { temp, repo, parent };
}

test("creates a clean sparse backend worktree without tracked runtime data", (t) => {
  const { temp, repo, parent } = fixture();
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script,
    "--repo", repo, "--parent", parent, "--issue", "SOU-999", "--profile", "backend", "--max-mb", "1",
  ], { encoding: "utf8" });

  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.branch, "paperclip-SOU-999");
  assert.equal(fs.existsSync(path.join(output.path, "backend", "src", "app.py")), true);
  assert.equal(fs.existsSync(path.join(output.path, "backend", "runtime", "large.bin")), false);
  assert.equal(fs.existsSync(path.join(output.path, "AGENTS.md")), true);
  assert.equal(git(output.path, "status", "--porcelain"), "");
});

test("rejects an over-budget checkout before creating a branch or directory", (t) => {
  const { temp, repo, parent } = fixture(2_000_000);
  t.after(() => fs.rmSync(temp, { recursive: true, force: true }));

  const result = spawnSync(process.execPath, [script,
    "--repo", repo, "--parent", parent, "--issue", "SOU-1000", "--profile", "backend", "--max-mb", "1",
  ], { encoding: "utf8" });

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /exceeds the 1 MB limit/);
  assert.equal(fs.existsSync(path.join(parent, "paperclip-SOU-1000")), false);
  assert.equal(git(repo, "branch", "--list", "paperclip-SOU-1000"), "");
});
