import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";

const root = fileURLToPath(new URL("../../../", import.meta.url));
const launcher = fileURLToPath(new URL("../../../cli/node_modules/tsx/dist/cli.mjs", import.meta.url));
const script = fileURLToPath(new URL("../../../scripts/workspace-legacy-closure.ts", import.meta.url));
const run = (...args: string[]) => spawnSync(process.execPath, [launcher, script, ...args], { cwd: root, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 15_000 });

it("prints the maintenance contract without opening a database or runtime", () => {
  const result = run("--help");
  expect(result.status).toBe(0);
  expect(result.stdout).toContain("inspect|prepare|close");
  expect(result.stdout).toContain("--expected-digest");
  expect(result.stdout).toContain("--generation");
});

it("refuses caller supplied boot proof and incomplete mutation selectors before configuration loading", () => {
  const suppliedProof = run("close", "--boot-id", "11111111-1111-4111-8111-111111111111");
  expect(suppliedProof.status).toBe(2);
  expect(suppliedProof.stderr).toContain("Unknown option: --boot-id");
  const incomplete = run("prepare");
  expect(incomplete.status).toBe(2);
  expect(incomplete.stderr).toContain("Missing --config");
});
