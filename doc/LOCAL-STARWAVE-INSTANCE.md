# Local maintained Paperclip instance

This checkout runs the existing local instance at `127.0.0.1:3100`. It is based on upstream `v2026.916.1` and local branch `local/starwave-maintained-2026.916.1`. The instance data stays in `/home/dains/.paperclip/instances/default`; the old managed npm payload stays installed for rollback. Do not run both against the same embedded database.

## Build and start

Use Node 24.21.0 and the lockfile's pnpm 9.15.4. The source CLI entrypoint uses `tsx`; `cli/dist/index.js` is an npm publication artifact whose external dependencies are assembled during packaging.

```sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.cargo/bin:/home/dains/.local/bin:/usr/local/bin:/usr/bin:/bin pnpm install --frozen-lockfile
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/home/dains/.cargo/bin:/home/dains/.local/bin:/usr/local/bin:/usr/bin:/bin pnpm build
rtk proxy bash scripts/run-starwave-local.sh
```

The start script runs in the foreground. A supervisor may launch it in a detached session with its own log file. Check `/api/health` and confirm `startupRecovery.phase=ready` before restoring normal scheduling. The existing config chooses loopback port 3100 and embedded PostgreSQL; the script passes `--no-repair` to avoid automatic config edits.

## Local model configuration

- Codex agents use the machine's already signed-in Codex account. Leave `runtimeConfig.aiConnection` unset and do not place `OPENAI_API_KEY`, `CODEX_API_KEY`, or a custom `CODEX_HOME` in agent environment. Choose `gpt-6-sol` or `gpt-6-luna` from the built-in model picker. Luna executes with at least `xhigh` even if an older agent or issue record has a lower/empty effort.
- Claude agents accept a manually entered provider model. For the local cc-switch route, use `adapterType=claude_local`, `engine=cli`, `model=MiniMax-M3.1-Flash-Preview`, `dangerouslySkipPermissions=true`, and the instance's existing `ANTHROPIC_BASE_URL`/credential binding. Keep provider URLs and tokens in Paperclip agent config or cc-switch, never in this Git repository. `model` takes precedence over `ANTHROPIC_MODEL` when both are present.
- The Codex adapter writes managed MCP HTTP Authorization using `http_headers`, and the managed Codex home exposes only an approved set of run identity variables to its tool shell. A manually supplied external `CODEX_HOME` is not rewritten by the shell-policy step.

## Change and rollback

Before every cutover, record live/queued run IDs, back up the embedded database with `paperclipai db:backup`, and copy `/home/dains/.paperclip/adapter-plugins.json`. The previous local Codex override imports the npm-installed server, so remove its entry from that manifest while this source build runs. Keep its package directory and manifest backup intact.

If the source process fails, stop it, restore the saved adapter-plugin manifest, and start the retained npm payload with Node 24 using the same config. Verify health, original company/project IDs, schedules, and agent model settings before declaring rollback complete. Never start the old and new processes concurrently.

For future upstream updates, fetch an explicit tag or commit, review the diff on this branch, run relevant tests plus typecheck/build, back up the database, and cut over only after the source build passes. This branch is local; no GitHub fork or push has been configured.
