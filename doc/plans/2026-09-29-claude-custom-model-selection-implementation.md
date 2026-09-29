# Claude Custom Model Selection Implementation Plan

> **For agentic workers:** Implement inline with test-driven development in the isolated Paperclip worktree. Preserve the live instance and unrelated changes.

## Task 1: Runtime model source

Files: `packages/adapters/claude-local/src/index.ts`, `src/server/{execute,acp,test,config-schema}.ts`, corresponding tests, and `packages/adapter-utils/src/types.ts`.

1. Add failing tests for legacy fallback, exact custom MiniMax ID, and `modelSelection: "claude_config"` omitting CLI `--model` and ACP's injected model, including an existing `ANTHROPIC_MODEL` adapter env value.
2. Test a saved CLI session from an old or different model, a codec serialization/deserialization roundtrip, a second local heartbeat after persistence, and an ACP Test probe with a stale model env. Reject stale CLI resumes; preserve matching pinned-session identity; use a fresh session for follow mode and ACP one-shot mode.
3. Implement the optional mode with the old model fallback as the default. Mask the adapter model env in follow mode without changing CC-Switch credentials or base URL.
4. Run focused adapter tests and typecheck.

## Task 2: Company model suggestions

Files: `server/src/services/claude-model-suggestions.ts`, its test, and `server/src/routes/agents.ts`.

1. Test that a company's saved Claude model IDs appear once beside discovered models, while another company's IDs, empty values, and follow-mode stale pins do not.
2. Add a company-scoped query that reads only the model and selection scalar fields. Merge and label suggestions at the existing models route.
3. Run focused server tests and typecheck.

## Task 3: Visible operator controls

Files: `ui/src/components/AgentConfigForm.tsx`, `ui/src/components/AgentConfigForm.render.test.tsx`, `ui/src/components/agent-config-defaults.ts`, `packages/adapters/claude-local/src/ui/build-config.ts` and test.

1. Add failing create/edit tests for direct custom input and follow-setting toggle. Verify the saved payload carries the exact ID or follow mode, and the existing default stays unpinned.
2. Add the labeled custom input and follow control with clear current-selection feedback. Keep the existing preset search and keyboard behavior.
3. Run focused UI tests, TypeScript, and build.

## Task 4: Integration and rollout

1. Review the branch, run the focused regression matrix and full typecheck/build, then fast-forward the local maintained Paperclip branch.
2. Drain active runs before restarting the WSL service. Verify `/api/health`, company model suggestions, the browser form, saved configuration readback, and a real local Claude model probe if a supported ID is available.
3. Preserve existing agent model pins and report provider-acceptance limits separately from UI/configuration success.

## Review focus

- An exact MiniMax ID must not be replaced by Paperclip's fallback.
- Follow mode must not accidentally leave a `--model` argument or agent-level `ANTHROPIC_MODEL` override.
- A saved CLI session must not retain the old model after switching; follow mode must read external CC-Switch changes on each new run.
- One company's configured model names must not leak to another company.
- Existing agents without the new field must continue using the current default.
- Typing a custom ID must remain visible and save through create and edit flows.
