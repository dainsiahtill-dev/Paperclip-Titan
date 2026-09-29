#!/usr/bin/env node
import { execFileSync, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const PROFILES = {
  backend: ["backend/src", "backend/tests", "backend/migrations", "docs/changes", "scripts"],
  frontend: ["frontend", "docs/changes"],
  data: ["data_pipeline", "docs/changes"],
  qa: ["backend/src", "backend/tests", "docs/qa", "docs/evaluations"],
};

function parseArgs(argv) {
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("Expected --repo, --parent, --issue, --profile and optional --base/--max-mb pairs");
    values[key.slice(2)] = value;
  }
  const issue = values.issue;
  const profile = values.profile;
  const maxMb = Number(values["max-mb"] ?? "1536");
  if (!values.repo || !values.parent || !/^SOU-[1-9]\d*$/.test(issue ?? "")) {
    throw new Error("--repo and --parent are required; --issue must be SOU-<positive number>");
  }
  if (!Object.hasOwn(PROFILES, profile)) throw new Error(`Unknown profile: ${profile}`);
  if (!Number.isSafeInteger(maxMb) || maxMb < 1 || maxMb > 10_240) throw new Error("--max-mb must be an integer from 1 to 10240");
  return {
    repo: path.resolve(values.repo),
    parent: path.resolve(values.parent),
    branch: `paperclip-${issue}`,
    profile,
    base: values.base ?? "main",
    maxMb,
  };
}

function git(repo, args) {
  return execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", maxBuffer: 20_000_000 }).trim();
}

function includesConePath(file, selectedDirectories) {
  if (!file.includes("/")) return true;
  return selectedDirectories.some((directory) => {
    if (file.startsWith(`${directory}/`)) return true;
    const segments = directory.split("/");
    for (let depth = 1; depth < segments.length; depth += 1) {
      const ancestor = segments.slice(0, depth).join("/");
      if (file.startsWith(`${ancestor}/`) && !file.slice(ancestor.length + 1).includes("/")) return true;
    }
    return false;
  });
}

function estimateCheckoutBytes(repo, base, selectedDirectories) {
  const listing = git(repo, ["-c", "core.quotePath=false", "ls-tree", "-r", "-l", base]);
  let bytes = 0;
  for (const line of listing.split("\n")) {
    const match = line.match(/^[0-7]{6} blob [0-9a-f]+\s+(\d+)\t(.+)$/);
    if (match && includesConePath(match[2], selectedDirectories)) bytes += Number(match[1]);
  }
  return bytes;
}

function run() {
  const input = parseArgs(process.argv.slice(2));
  const selectedDirectories = PROFILES[input.profile];
  const repoRoot = git(input.repo, ["rev-parse", "--show-toplevel"]);
  if (repoRoot !== input.repo) throw new Error(`--repo must be the Git root: ${repoRoot}`);
  const baseSha = git(input.repo, ["rev-parse", "--verify", `${input.base}^{commit}`]);
  const branchExists = spawnSync("git", ["-C", input.repo, "show-ref", "--verify", "--quiet", `refs/heads/${input.branch}`]);
  if (branchExists.status === 0) throw new Error(`Branch already exists: ${input.branch}`);
  const workspace = path.join(input.parent, input.branch);
  if (fs.existsSync(workspace)) throw new Error(`Worktree path already exists: ${workspace}`);
  const limitBytes = input.maxMb * 1024 * 1024;
  const estimatedBytes = estimateCheckoutBytes(input.repo, input.base, selectedDirectories);
  if (estimatedBytes > limitBytes) {
    throw new Error(`Estimated sparse checkout ${Math.ceil(estimatedBytes / 1048576)} MB exceeds the ${input.maxMb} MB limit`);
  }

  fs.mkdirSync(input.parent, { recursive: true });
  let created = false;
  try {
    git(input.repo, ["worktree", "add", "--no-checkout", "-b", input.branch, workspace, input.base]);
    created = true;
    git(workspace, ["sparse-checkout", "set", ...selectedDirectories]);
    git(workspace, ["reset", "--hard", "HEAD"]);
    const actualBytes = Number(execFileSync("du", ["-sk", workspace], { encoding: "utf8" }).trim().split(/\s+/)[0]) * 1024;
    if (actualBytes > limitBytes) {
      throw new Error(`Actual sparse checkout ${Math.ceil(actualBytes / 1048576)} MB exceeds the ${input.maxMb} MB limit`);
    }
    process.stdout.write(`${JSON.stringify({ path: workspace, branch: input.branch, baseSha, profile: input.profile, estimatedBytes, actualBytes, selectedDirectories })}\n`);
  } catch (error) {
    if (created) {
      try { git(input.repo, ["worktree", "remove", "--force", workspace]); } catch { /* retain original error */ }
      try { git(input.repo, ["branch", "-D", input.branch]); } catch { /* retain original error */ }
    }
    throw error;
  }
}

try {
  run();
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
