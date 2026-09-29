# Claude custom model selection

## Intent

An operator using local Claude Code through CC-Switch must be able to enter any model ID accepted by that Claude runtime, reuse model IDs already configured on agents in the same company, or deliberately follow the runtime's current Claude settings. Existing Claude agents and their explicit MiniMax model pins must keep working unchanged.

## Current behavior

The Claude adapter already accepts a string model and passes it as a separate `--model` argument on the CLI lane or as `ANTHROPIC_MODEL` on ACP. The model picker hides its manual-entry action inside search results, while `/adapters/claude_local/models` returns Anthropic fallbacks or Anthropic API discovery. It omits the MiniMax IDs already saved on this company's agents. A blank model is resolved to Paperclip's official default and still becomes an explicit CLI model override, so it cannot mean “follow my Claude settings.”

## Contract and boundaries

Keep `adapterConfig.model` as the exact pinned model ID. The UI exposes a labeled custom model input beside the preset picker; it never validates the value against Anthropic's catalog. The company-scoped model endpoint appends distinct nonempty model IDs from that company's Claude agents, with a configured label. It reads only scalar model fields from their adapter configuration, never connection credentials. These IDs are suggestions, not evidence that a provider currently accepts them.

Add optional `adapterConfig.modelSelection: "claude_config"`. An absent value retains the current default and existing explicit model behavior. In `claude_config` mode, the adapter omits `--model` on CLI and does not inject a model into ACP. It masks `ANTHROPIC_MODEL` inherited through the agent's adapter environment so the runtime can read its own Claude configuration. The UI clears a pinned model when this mode is selected and explains that the selected execution machine/config directory must contain the intended CC-Switch settings. Switching back restores ordinary preset or custom selection; it does not rewrite CC-Switch settings or credentials.

The active local CC-Switch relay returns an empty `/v1/models` list, so relying on provider discovery would still hide valid MiniMax versions. Manual entry remains authoritative. An invalid ID fails in Claude's existing environment test or run trace; Paperclip does not silently replace it with an official model.

## Data flow

`AgentConfigForm` collects preset, custom ID, or follow mode. `buildClaudeLocalConfig` persists either a pinned `model` or `modelSelection: "claude_config"`. The existing agent configuration API stores those fields. The Claude CLI/ACP adapters resolve the selection at execution and test time. The model list route merges adapter discovery with company-configured IDs for convenience. No database migration or provider credential change is needed.

## Risks and verification

- A custom ID may be rejected by CC-Switch or the upstream provider; report the real error rather than substituting a model.
- Claude settings are machine and config-directory specific. Following settings on a remote execution target follows that target's settings, not the operator's desktop configuration.
- A historical agent with no `modelSelection` must retain the existing fallback, while an agent pinned to MiniMax must retain its exact model and permission flags.
- Test model-list company isolation, create/edit form persistence, CLI arguments and ACP environment, invalid/blank values, TypeScript, focused adapter/UI suites, build, and a local browser flow. Deploy only after running agents drain, then read back saved configuration and an actual adapter invocation.
