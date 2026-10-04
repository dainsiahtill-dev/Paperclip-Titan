import { describe, expect, it } from "vitest";
import { applyAgentSafetyPreset, enforceAgentSafetyPreset, assertAgentSafetyPresetTransition, resolveAgentPresetWorkspaceConcurrency } from "./agent-safety-presets.js";

describe("agent safety presets", () => {
  it("builds serialized sandboxed audit creation without changing model", () => {
    expect(applyAgentSafetyPreset("codex_local", { model: "chosen" }, { safetyPreset: "audit" })).toEqual({
      adapterConfig: { engine: "cli", sandboxMode: "read-only", dangerouslyBypassApprovalsAndSandbox: false, model: "chosen" },
      runtimeConfig: { safetyPreset: "audit", heartbeat: { maxConcurrentRuns: 1 } },
    });
  });
  it.each(["implementation", "testing"])("serializes shared writers for %s", (safetyPreset) => {
    expect(resolveAgentPresetWorkspaceConcurrency({ safetyPreset }, "allow")).toBe("serialize");
  });
  it("preserves explicit existing/imported non-audit settings", () => {
    const adapterConfig = { dangerouslyBypassSandbox: true, engine: "auto" };
    const runtimeConfig = { heartbeat: { maxConcurrentRuns: 20 } };
    expect(applyAgentSafetyPreset("codex_local", adapterConfig, runtimeConfig)).toEqual({ adapterConfig, runtimeConfig });
  });
  it.each([
    { dangerouslyBypassApprovalsAndSandbox: true }, { dangerouslyBypassSandbox: true },
    { sandboxMode: "workspace-write" }, { extraArgs: ["--permission-profile", ":workspace"] },
    { extraArgs: ["--full-auto"] }, { args: ["-sworkspace-write"] },
    { args: ["-c", 'permissions.foo.filesystem.write=["/"]'] },
    { command: "/tmp/codex" }, { engine: "acp" }, { engine: "auto" },
    { env: { PATH: "/tmp" } },
  ])("rejects escalation in final overridden config %j", (overrides) => {
    expect(() => enforceAgentSafetyPreset("codex_local", { safetyPreset: "audit" }, { engine: "cli", ...overrides })).toThrow(/Audit/);
  });
  it("checks both args fields even when extraArgs shadows args", () => {
    expect(() => enforceAgentSafetyPreset("codex_local", { safetyPreset: "audit" }, { engine: "cli", extraArgs: ["--skip-git-repo-check"], args: ["--yolo"] })).toThrow(/Audit/);
  });
  it.each(["paperclip_runner", "claude_local", "opencode_local"])("fails closed for unsupported audit adapter %s", (type) => {
    expect(() => enforceAgentSafetyPreset(type, { safetyPreset: "audit" }, {})).toThrow(/Audit/);
  });
  it("operator must explicitly leave audit before write configuration", () => {
    expect(() => assertAgentSafetyPresetTransition({ safetyPreset: "audit" }, {}, false)).toThrow(/Board/);
    expect(() => assertAgentSafetyPresetTransition({ safetyPreset: "audit" }, {}, true)).not.toThrow();
    expect(() => enforceAgentSafetyPreset("codex_local", { safetyPreset: "audit" }, { engine: "cli", dangerouslyBypassApprovalsAndSandbox: true })).toThrow(/Audit/);
  });
  it("does not add control-plane permissions", () => {
    expect(applyAgentSafetyPreset("process", {}, { safetyPreset: "manager" }).runtimeConfig).toEqual({ safetyPreset: "manager", heartbeat: { maxConcurrentRuns: 1 } });
  });
});
