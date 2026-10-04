# Task 5 report — physical workspace ownership

Worktree: `/home/dains/Documents/paperclip/.claude/worktrees/polaris-feedback-20261005`.
Base: `16e5675b74a177186d08e63a391d9b992bf9ed63`.
Scope: PC-06 initial local legacy boundary; root integration/review remains separate.

## Changes

- Generated `0287_aromatic_union_jack.sql` with normal `pnpm db:generate` plus the generated snapshot/journal. Added `workspace_write_owners` and schema export. No live database was accessed or migrated.
- Added canonical device/inode + machine-realm ownership, parent/subdirectory exclusion, opaque cross-company busy, durable generation/lifecycle history, no TTL unlock, and no cascading entity FKs.
- Added host-only ALS + explicit adapter/process context guard. Actual Bubblewrap launch pins source/private-directory FDs, records namespace identity, commits owner/run process metadata, then opens a two-stage ACK gate. Startup loader/shell hook env cannot execute before the gate.
- Supported local legacy writers, including isolated ones, claim before adapter dispatch. Shared `auto` serializes. Stored shared `allow`, unknown/shared remote/native lifetimes fail clearly. Exact physical busy uses the existing workspace retry mechanism; it is not mislabeled `adapter_failed`.
- Actual drain checks kernel boot, controller PID/mount namespace, namespace-init PID/start identity, and remaining namespace processes. Cancel/timeout kill the matching namespace init before closing the gate or wrapper. Release occurs after adapter/host cleanup and only for the matching stopped generation. Persistence failures retain unknown holds.
- Codex/Claude require explicit CLI; Hermes forwards cancellation/guard and signals cancellation readiness. Managed Codex/per-run homes are pinned and reserved against later source-root admission. Extra arbitrary writable roots remain unsupported.
- Separate HTTP writable stdio and long-lived runtime services register unprotected observations before spawn; they cannot join a protected source owner. Read-only governed stdio retains its existing boundary.
- Both workspace-job HTTP callers pass DB to `runWorkspaceJobForControl`; jobs claim separately and their `executeProcess` uses the contained process path. No engineering verdict/receipt protocol was added.
- Added actual effect fixtures and updated workspace-busy/gateway tests for the intentional safer policy. Existing Task 1–4 changes and root plan/helper files were preserved.

## RED evidence and discovered failures

1. Initial guard test failed because `withWorkspaceProcessGuard` was absent (isolated root `/tmp/pc-feedback-check-zba_51um`, transcript output). Initial DB contention test failed because service was absent (`/tmp/pc-feedback-check-plczng2w`). Both became real process/database GREEN tests.
2. Parent supplied baseline escaped-child failure remains historical evidence: `/tmp/pc-feedback-check-99alf0q_/t/pc-escaped-writer-uHIh9M/result.json`; this task did not replace it with argv-only evidence.
3. Killing only outer Bubblewrap before ACK left its namespace init blocked and stdio alive. Fix kills exact namespace init first, then outer wrapper; all signals target fixture-owned identities.
4. The actual pre-ACK controller-death test intermittently produced file content `unsafe` with only `--block-fd` (`/tmp/pc-feedback-check-nqbwki0b`, transcript failure at workspace-write-ownership test line 142). Bubblewrap treats EOF as unblock. Added inner `/bin/sh` gate requiring an exact host-generated nonce on stdin; EOF cannot execute provider argv. Provider stdin follows its ACK line unchanged.
5. A compiled private `LD_PRELOAD` constructor wrote `pre-ack-loader=unsafe` before the outer sandbox started. RED log: `/tmp/paperclip-task5-loader-red.log`. Stripping loader and shell startup hooks before spawn makes the same actual-effect test pass. The RED invocation selected one test (four others not selected); final whole-file runs have no skips.
6. Whole heartbeat physical test initially classified its true owner conflict as `adapter_failed`; fixed both intervening catch paths so the existing `WorkspaceBusyDeferral` reaches its normal retry owner. Whole-file GREEN followed.

## Verification

All commands below use the isolated wrapper. Prefix is:

`rtk proxy python3 .superpowers/sdd/2026-10-05-polaris-owner-feedback/run-isolated-check.py`

The wrapper uses Node 24.21.0, isolated Paperclip HOME/config/instance/TMPDIR, and strips inherited provider credentials. New physical tests have no conditional skips. No provider/model call, credential copy, installation, production configuration change, default3100 API/service operation, or Polaris change was made.

| Command suffix | Result / log |
| --- | --- |
| `db:generate` | exit 0; generated migration 0287; isolated root `/tmp/pc-feedback-check-x5ta9jy9` |
| `--filter @paperclipai/adapter-utils --filter @paperclipai/db typecheck` | exit 0; `/tmp/paperclip-task5-package-types.log`; migration numbering/safety pass, existing 20 baseline findings unchanged |
| `exec tsc -p server/tsconfig.json --noEmit` | exit 0; `/tmp/paperclip-task5-final-types.log` |
| `--bwrap exec vitest run packages/adapter-utils/src/workspace-process-guard.test.ts packages/adapters/codex-local/src/server/workspace-guard.integration.test.ts server/src/__tests__/workspace-write-ownership.test.ts` | 17/17 passed, including private-root/source contention; `/tmp/paperclip-task5-final-acceptance.log` |
| `--bwrap exec vitest run server/src/__tests__/heartbeat-workspace-busy.test.ts` | 16/16 passed, `/tmp/paperclip-task5-heartbeat-final.log` |
| `exec vitest run server/src/__tests__/tool-gateway.test.ts` | 63/63 passed, `/tmp/paperclip-task5-gateway-final2.log` |
| `exec vitest run server/src/__tests__/tool-gateway.test.ts server/src/__tests__/workspace-runtime.test.ts` | workspace-runtime 163/163 passed before final long-lived-service observation hook; gateway had 3 then-fixed failures; preserved combined log `/tmp/paperclip-task5-adjacent-gates.log` |

The ordinary server typecheck lifecycle rebuilt and checked the runner successfully, then reported three own TypeScript errors (stdio tuple indexing and a realized-workspace ID). Those were fixed and direct source typechecks pass; the full lifecycle command was not repeated. No parallel Rust builds were run.

Actual effects covered: same-file two heartbeat issues/different workspace IDs; company/symlink aliases; old controller timestamps with a delayed writer; same-host controller restart; SIGKILL before ACK and while escaped child waits; cancel of a `setsid` descendant; failed DB identity transaction with no file effect; stale generation and foreign observer namespace refusal; root replacement; run/issue/company deletion retaining ownership; HTTP job and HTTP stdio conflict; actual Codex CLI adapter with source and managed-home effects.

Private children exit or are killed by exact owned PID/namespace; tests remove fixture files and stop private embedded databases. Failed pre-ACK sentinel and loader files were in per-test temporary directories and removed by fixture cleanup. Durable `/tmp` logs above are retained. No full monorepo `pnpm test`, recursive typecheck/build, browser flow, provider credential qualification, or production migration was performed; root owns final integration gates.

## Task 6 host-job seam

`workspaceWriteOwnershipService(db)` exposes `claim`, `guard`, `beforeLaunch`, `bindLaunch`, `markStopping`, `recordDrain`, `releaseIfStopped` and private-root reservation. `withWorkspaceProcessGuard` carries the host capability through actual local process helpers. The guard does not accept policy/ownership from agent JSON or environment.

`runWorkspaceJobForControl({ db, actor, issue, workspace, command, recorder, metadata })` is the actual configured-command path. Current physical owner binds `actor.companyId`, `issue?.id`, canonical `workspace.cwd`, and a generated job UUID. That UUID is **not** evidence of an authenticated heartbeat-run binding. Task 6 must bind authorization-derived run/issue/workspace/job/source identities and result semantics in its recorder. Current route metadata still supplies workspace/job IDs for that integration.

An agent's HTTP test job on its still-held root returns busy, even for the same issue. Do not bypass that check or replace primary PID with a helper PID. Use a host-created immutable snapshot with its own ownership, or launch after the original lifetime drains; otherwise return unverified. A before/after source digest alone is not an immutable interval. A recorder timeout cannot release a live namespace; an uncertain owner remains held. No acceptance/privilege protocol was introduced.

Read-only interval gap: this new physical guard currently forces `workspaceAccess: "rw"`; `runWorkspaceJobForControl` has no read-only-source option. The underlying sandbox builder supports `workspaceAccess: "ro"` from Task 4, but that option is not exposed through this ownership guard. Merely passing a snapshot directory therefore does not stop the test process from modifying it. Task 6 must add an explicit host-owned read-only interval/output-root capability or another genuinely immutable-source mechanism before qualifying engineering evidence. Exclusion of other managed writers alone is insufficient.

## Limits and review notes

- One Paperclip DB/instance and same Linux host storage realm; no cross-database/distributed lock or arbitrary external-process/file-scope guarantee.
- Native isolated reconnect semantics are preserved with conservative unprotected observations. There is no automatic release for retained native, uncontained stdio, or long-lived service observations based on parent-only/terminal/TTL evidence. This can block reuse; no force-unlock endpoint was added.
- Preexisting untracked local/native rows with unknown/overlapping roots block protected admission. Remote roots are not inferred from local PIDs.
- Managed private-root layout is bounded; broad host HOME, arbitrary additional writable roots, source aliases, external credential symlink layout, and ACP confinement remain unsupported. No auth was copied to make a test pass.
- A long-lived service on a source root blocks protected writers. The final small service admission hook has source/type verification; the 163-test runtime suite pass predates that hook. Separate source/runtime roots are required until that service lifetime has containment proof.
- Source preparation/realization precedes the provider ownership boundary. This work does not claim an immutable snapshot for those earlier host operations or general filesystem atomicity. Task 6 must require a protected/fixed verification interval, not extend the provider claim to unrelated preparation.
- No independent root review, full browser acceptance or full feedback delivery is claimed here.
