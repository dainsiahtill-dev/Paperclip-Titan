import { expect, it } from "vitest";
import { buildQuotaBackupConfig } from "../services/agent-quota-fallback-policy.js";

it("preserves explicitly selected ACP and the local Codex binary in quota fallback", () => {
  const primary = {
    id: "agent", companyId: "company", adapterType: "claude_local",
    adapterConfig: { engine: "acp", env: { CODEX_PATH: "/local/codex", ANTHROPIC_AUTH_TOKEN: "private" } },
    runtimeConfig: {}, metadata: null,
  };
  expect(buildQuotaBackupConfig(primary, { adapterType: "codex_local", model: "gpt-6.1-sol" })).toMatchObject({
    engine: "acp", env: { CODEX_PATH: "/local/codex" },
  });
  expect(buildQuotaBackupConfig(primary, { adapterType: "codex_local", model: "gpt-6.1-sol" }).env).not.toHaveProperty("ANTHROPIC_AUTH_TOKEN");
  expect(buildQuotaBackupConfig({ ...primary, adapterConfig: { engine: "cli" } }, { adapterType: "codex_local", model: "gpt-6.1-sol" }).engine).toBe("cli");
});
