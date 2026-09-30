// @vitest-environment node

import { describe, expect, it } from "vitest";
import type { Agent } from "@paperclipai/shared";
import { buildAgentUpdatePatch, type AgentConfigOverlay } from "./agent-config-patch";

function makeAgent(): Agent {
  return {
    id: "agent-1",
    companyId: "company-1",
    name: "Agent",
    role: "engineer",
    title: "Engineer",
    icon: null,
    status: "active",
    reportsTo: null,
    capabilities: null,
    adapterType: "claude_local",
    adapterConfig: {
      model: "claude-sonnet-4-6",
      env: {
        OPENAI_API_KEY: {
          type: "plain",
          value: "secret",
        },
      },
      promptTemplate: "Work the issue.",
    },
    runtimeConfig: {
      heartbeat: {
        enabled: true,
        intervalSec: 300,
      },
    },
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    lastHeartbeatAt: null,
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    urlKey: "agent",
    permissions: {
      canCreateAgents: false,
    },
    metadata: null,
  };
}

function makeOverlay(patch?: Partial<AgentConfigOverlay>): AgentConfigOverlay {
  return {
    identity: {},
    adapterConfig: {},
    heartbeat: {},
    debug: {},
    runtime: {},
    ...patch,
  };
}

describe("buildAgentUpdatePatch", () => {
  it("merges the agent-scoped provider trace debug setting into runtime config", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({ debug: { providerTrace: "raw" } }),
    );

    expect(patch).toMatchObject({
      runtimeConfig: {
        heartbeat: { enabled: true, intervalSec: 300 },
        debug: { providerTrace: "raw" },
      },
    });
  });

  it("replaces adapter config and drops env when the last env binding is cleared", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterConfig: {
          env: undefined,
        },
      }),
    );

    expect(patch).toEqual({
      adapterConfig: {
        model: "claude-sonnet-4-6",
        promptTemplate: "Work the issue.",
      },
      replaceAdapterConfig: true,
    });
  });

  it("writes max-turn continuation policy under runtimeConfig.heartbeat", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        heartbeat: {
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      }),
    );

    expect(patch).toEqual({
      runtimeConfig: {
        heartbeat: {
          enabled: true,
          intervalSec: 300,
          maxTurnContinuation: {
            enabled: true,
            maxAttempts: 3,
            delayMs: 1000,
          },
        },
      },
    });
  });

  it("preserves adapter-agnostic keys when changing adapter types", () => {
    const patch = buildAgentUpdatePatch(
      makeAgent(),
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: {
          model: "gpt-5.4",
          dangerouslyBypassApprovalsAndSandbox: true,
        },
      }),
    );

    expect(patch).toEqual({
      adapterType: "codex_local",
      adapterConfig: {
        env: {
          OPENAI_API_KEY: {
            type: "plain",
            value: "secret",
          },
        },
        promptTemplate: "Work the issue.",
        model: "gpt-5.4",
        dangerouslyBypassApprovalsAndSandbox: true,
      },
      replaceAdapterConfig: true,
    });
  });

  it("preserves paperclip skill-sync selections when changing adapter types", () => {
    // Desired skills are adapter-agnostic (company-level selections) but are
    // persisted inside the per-adapter config under `paperclipSkillSync`. A
    // patch that switches adapters must carry them over instead of wiping the
    // agent's skills.
    const agent = makeAgent();
    agent.adapterConfig = {
      ...agent.adapterConfig,
      paperclipSkillSync: { desiredSkills: ["research", "code-review"] },
    };

    const patch = buildAgentUpdatePatch(
      agent,
      makeOverlay({
        adapterType: "codex_local",
        adapterConfig: { model: "gpt-5.4" },
      }),
    );

    expect((patch.adapterConfig as Record<string, unknown>).paperclipSkillSync).toEqual({
      desiredSkills: ["research", "code-review"],
    });
  });
});

describe("buildAgentUpdatePatch runtime settings", () => {
  it("merges quota fallback with simultaneous heartbeat and debug edits", () => {
    const agent: Pick<Agent, "adapterConfig" | "runtimeConfig"> = {
      adapterConfig: {},
      runtimeConfig: {
        heartbeat: { enabled: false, maxConcurrentRuns: 1 },
        debug: { providerTrace: "raw", unrelated: true },
        aiConnection: { mode: "responsible_user", method: "subscription", provider: "openai" },
      },
    };
    const overlay: AgentConfigOverlay = {
      identity: {}, adapterConfig: {},
      heartbeat: { enabled: true },
      debug: { providerTrace: undefined },
      runtime: { runtimeConfig: { quotaFallback: {
        enabled: true,
        backup: { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" },
        recoveryEnabled: true,
        primaryCheckIntervalSec: 900,
      } } },
    };
    expect(buildAgentUpdatePatch(agent, overlay)).toEqual({
      runtimeConfig: {
        heartbeat: { enabled: true, maxConcurrentRuns: 1 },
        debug: { unrelated: true },
        aiConnection: { mode: "responsible_user", method: "subscription", provider: "openai" },
        quotaFallback: {
          enabled: true,
          backup: { adapterType: "codex_local", model: "gpt-6.1-sol", thinkingEffort: "high" },
          recoveryEnabled: true,
          primaryCheckIntervalSec: 900,
        },
      },
    });
  });

  it("retains saved runtime settings when only a connection draft changes", () => {
    const agent: Pick<Agent, "adapterConfig" | "runtimeConfig"> = { adapterConfig: {}, runtimeConfig: { heartbeat: { enabled: true }, quotaFallback: { enabled: false, recoveryEnabled: true, primaryCheckIntervalSec: 900 } } };
    expect(buildAgentUpdatePatch(agent, {
      identity: {}, adapterConfig: {}, heartbeat: {}, debug: {},
      runtime: { runtimeConfig: { aiConnection: { mode: "responsible_user" } } },
    })).toEqual({ runtimeConfig: {
      heartbeat: { enabled: true }, quotaFallback: { enabled: false, recoveryEnabled: true, primaryCheckIntervalSec: 900 },
      aiConnection: { mode: "responsible_user" },
    } });
  });
});
