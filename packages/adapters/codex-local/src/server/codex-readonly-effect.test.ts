import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import { applyAgentSafetyPreset, enforceAgentSafetyPreset } from "@paperclipai/shared";
import { buildCodexExecArgs } from "./codex-args.js";
const version = spawnSync("codex", ["--version"], { encoding: "utf8" });
const suite = version.status === 0 ? describe : describe.skip;
suite("actual Codex read-only filesystem effect (no inference)", () => {
  it("denies writing a writable source file using the effective audit profile", () => {
    const root = mkdtempSync(path.join(tmpdir(), "codex-audit-effect-"));
    const cwd = path.join(root, "workspace"); mkdirSync(cwd);
    const home = path.join(root, "codex"); mkdirSync(home);
    const target = path.join(cwd, "source.txt"); writeFileSync(target, "original");
    const created = applyAgentSafetyPreset("codex_local", {}, { safetyPreset: "audit" });
    const effective = enforceAgentSafetyPreset("codex_local", created.runtimeConfig, { ...created.adapterConfig, cwd });
    const args = buildCodexExecArgs(effective).args;
    const profile = args[args.indexOf("--permission-profile") + 1];
    expect(profile).toBe(":read-only");
    const result = spawnSync("codex", ["sandbox", "--permission-profile", profile, "-C", cwd, "--", "/usr/bin/python3", "-c", "from pathlib import Path; import sys\ntry: Path('source.txt').write_text('changed')\nexcept OSError as error:\n print('write_denied', error.errno); sys.exit(0)\nprint('write_allowed'); sys.exit(42)"], { cwd, env: { ...process.env, CODEX_HOME: home }, encoding: "utf8", timeout: 30000 });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toMatch(/write_denied (1|13|30)/);
    expect(readFileSync(target, "utf8")).toBe("original");
  });
});
