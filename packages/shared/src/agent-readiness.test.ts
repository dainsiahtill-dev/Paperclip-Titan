import { describe, expect, it } from "vitest";
import { createAgentSchema } from "./validators/agent.js";

describe("governed readiness requirements", () => {
  const parse = (requirements: unknown) => createAgentSchema.safeParse({ name: "Auditor", adapterType: "codex_local", runtimeConfig: { readinessRequirements: requirements } });
  it("rejects executable, env, auth and arbitrary configuration injection in references", () => {
    for (const extra of [{ command: "sh" }, { env: { OPENAI_API_KEY: "secret" } }, { args: ["-c", "model_provider=x"] }]) {
      expect(parse({ mcp: [{ connectionId: "a1111111-1111-4111-8111-111111111111", requiredTools: ["explore"], ...extra }] }).success).toBe(false);
    }
  });
  it("accepts only fixed interpreter probes and bounded SKILL.md references", () => {
    expect(parse({ interpreters: ["python3", "python", "node"], skills: [{ workspacePath: ".agents/skills/review/SKILL.md" }] }).success).toBe(true);
    for (const requirements of [{ interpreters: ["sh -c anything"] }, { skills: [{ workspacePath: "../../secret" }] }, { skills: [{ workspacePath: "/home/host/SKILL.md" }] }, { skills: [{ workspacePath: "src/main.ts" }] }, { expected: { model: "x", auth: "secret" } }]) expect(parse(requirements).success).toBe(false);
  });
});
