# Starwave maintained Paperclip runtime

## Intent and baseline

Operate the existing local Paperclip instance from a source checkout that we can review, test, and update. Preserve its company, issues, agent identities, subscriptions, and embedded PostgreSQL data. Start from upstream tag `v2026.916.1`, the version currently running at `127.0.0.1:3100`, on local branch `local/starwave-maintained-2026.916.1`. Keep upstream as a fetchable remote; do not publish a fork or push without a separate destination decision.

The current instance already stores the user-selected Claude CLI/MiniMax model and cc-switch environment in agent configuration, and the Claude adapter supports manual model IDs, environment bindings, and `dangerouslySkipPermissions`. Preserve those settings and prove them in the source deployment. The source change is for missing Codex model choices and for verified Paperclip runtime defects, not a replacement credential system.

## Architecture and data flow

1. `packages/adapters/codex-local/src/index.ts` owns the visible Codex model catalog and model-specific reasoning choices. Add `gpt-6-sol` and `gpt-6-luna`; make the local Luna picker offer `xhigh` and `max` only, following the operator's minimum. Existing agent and issue records remain unchanged.
2. `packages/adapters/codex-local/src/server/codex-home.ts` owns the managed Codex home. Generate Codex's documented `http_headers` key for managed MCP HTTP gateways. In the managed copy of `config.toml`, preserve unrelated user settings while setting a narrow shell-environment allowlist that carries the current `PAPERCLIP_API_*`, agent, company, run, and task identity into Codex tool shells. Never modify the shared host Codex home or copy subscription tokens into source.
3. `packages/adapter-utils/src/server-utils.ts` owns serialization of the wake context that adapters place in `PAPERCLIP_WAKE_PAYLOAD_JSON`. Keep ordinary payloads byte-identical. Bound oversized UTF-8 values below 64 KiB by removing duplicate continuation message history first, retaining action receipts and issue identity, and setting `truncated` plus `fallbackFetchNeeded`. Keep the full context in the durable run record. Fail explicitly if the reduced value still cannot fit.
4. The existing Claude adapter remains the implementation boundary for `claude_local`. Local `MiniMax-M3.1-Flash-Preview` is a manually entered model ID, with cc-switch supplied by the existing agent environment and `engine=cli` / `dangerouslySkipPermissions=true`. Do not bake one user's provider URL or credentials into the global model catalog or Git history. Add an operator runbook with redacted configuration examples and a live probe.
5. Deploy via the built source CLI against `/home/dains/.paperclip/instances/default/config.json`, using the same Node 24 runtime, same database and port. Never run two Paperclip servers against that database. Retain the current managed npm payload and pre-cutover database backup as rollback material.

## Choices and risks

- Pinning the running tag avoids unrelated upstream migrations during the first source cutover. Future updates are explicit upstream merges, build/test, backup, and a second cutover.
- The managed Codex copy gets the policy change; the host's own `~/.codex/config.toml` stays untouched. An environment allowlist must include run identity but exclude other credentials.
- The wake cap changes a shared serializer used by several adapters. Tests must show small-payload compatibility, large-payload safety, retained receipts, and correct fetch flags; an actual Codex and Claude run are separate integration evidence.
- The local branch is maintainable even before a GitHub fork exists. The operator should add a private fork remote only when a destination is specified.
- Running agents may finish while the source build is prepared. At cutover, snapshot all heartbeat policies and live runs; allow a short drain or perform documented Board cancellation, then restore policies exactly. Check startup recovery and issue handoffs after restart.

## Implementation and verification plan

1. Install the lockfile's pnpm version with Node 24, then install dependencies from the pinned tag.
2. Write focused failing tests for Codex catalog/effort, managed MCP and shell policy, and wake payload size; observe each failure before source changes.
3. Implement the narrow source fixes; run targeted Vitest and package typechecks, then the repository's full `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` gates if feasible.
4. Verify the Claude manual-model path with current redacted agent config and an isolated local adapter probe. Verify Codex Sol and Luna picker output and effective CLI arguments without replacing the host account.
5. Back up the database and current runtime metadata. Stop the old server once no active run needs preservation; start the built source CLI with the existing config on port 3100. Verify health, company and project IDs, agent model settings, schedules, MCP identity, and a long-context wake. Restore the managed npm service if any check fails.

