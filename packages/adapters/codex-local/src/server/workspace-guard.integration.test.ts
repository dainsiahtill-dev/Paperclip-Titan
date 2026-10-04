import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { withWorkspaceProcessGuard } from "@paperclipai/adapter-utils/server-utils";
import type { WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { execute } from "./execute.js";

let temp: string | undefined;
afterEach(async () => { vi.unstubAllEnvs(); if (temp) await fs.rm(temp, { recursive: true, force: true }); });
it("runs the actual Codex CLI adapter with pinned source and server-owned managed HOME", async () => {
  temp = await fs.mkdtemp(path.join(os.tmpdir(), "pc-codex-guard-"));
  const workspace = path.join(temp, "workspace"), home = path.join(temp, "instance", "companies", "fixture-company", "codex-home");
  await fs.mkdir(workspace); await fs.mkdir(home, { recursive: true });
  vi.stubEnv("PAPERCLIP_HOME", path.join(temp, "instance")); vi.stubEnv("CODEX_HOME", home);
  const command = path.join(workspace, "fake-codex");
  await fs.writeFile(command, `#!/bin/sh\ncase "$1" in --version) printf 'codex-cli 0.1.0\\n'; exit 0;; esac\nprintf source > source-effect\nprintf runtime > "$CODEX_HOME/runtime-effect"\nprintf '%s\\n' '{"type":"thread.started","thread_id":"fixture-thread"}' '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}'\n`, { mode: 0o700 });
  const stat = await fs.stat(workspace); const launches: WorkspaceLaunchIdentity[] = [], drains: WorkspaceLaunchIdentity[] = [];
  const guard = { root: workspace, device: String(stat.dev), inode: String(stat.ino), privateRoots: [home],
    beforeLaunch: async () => `launch-${launches.length}`, bindLaunch: async (identity: WorkspaceLaunchIdentity) => { launches.push(identity); },
    recordDrain: async (identity: WorkspaceLaunchIdentity) => { drains.push(identity); }, markUnknown: async () => {},
  };
  const result = await withWorkspaceProcessGuard(guard, () => execute({
    runId: "fixture-run", workspaceProcessGuard: guard,
    agent: { id: "fixture-agent", companyId: "fixture-company", name: "Fixture", adapterType: "codex_local", adapterConfig: {} },
    runtime: { sessionId: null, sessionParams: null, sessionDisplayId: null, taskKey: null },
    config: { engine: "cli", command, cwd: workspace, filesystemScope: "workspace", networkScope: "deny", timeoutSec: 2,
      env: { CODEX_HOME: home, OPENAI_API_KEY: "private-fixture-no-provider" } },
    context: {}, onLog: async () => {},
  }));
  expect(result.exitCode, JSON.stringify(result)).toBe(0);
  expect(await fs.readFile(path.join(workspace, "source-effect"), "utf8")).toBe("source");
  expect(await fs.readFile(path.join(home, "runtime-effect"), "utf8")).toBe("runtime");
  expect(drains).toEqual(launches); expect(drains.length).toBeGreaterThan(0);
});
