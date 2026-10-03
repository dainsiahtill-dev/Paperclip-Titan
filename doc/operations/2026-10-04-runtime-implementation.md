# Runtime reliability implementation — 2026-10-04

Base: `39451d9e9`; branch `fix/delivery-runtime-20261004`.
Worktree: `.claude/worktrees/delivery-runtime-20261004`.
Scope: PC-04, PC-05/06, reproduced runtime portions of PC-12.

## PC-04 recovery maintenance

Implemented `recovery-scheduler.ts`: retained physical cycle owner, same promise across overlapping ticks, sequential typed completed/failed/skipped outcomes and duration, stop barrier checked after asynchronous suppression, per-phase exponential backoff capped at five minutes, fixed-code errors. Failed/skipped reap suppresses promote/queues/stranded; independent dependency/watchdog/silence/stale-lock methods retain their existing guards. Shutdown stops admission and drains cycle before hot-restart snapshot. Startup native owner classification remains first; failed startup reap now suppresses startup dispatch phases.

RED: four coordinator regressions failed (reap exception stopped independent lanes, overlapping tick owners, shutdown race, backoff). GREEN: coordinator 4/4; adjacent hot-restart/native-restart/coordinator files passed in the seven-file run (52 tests total, one admission-release failure described below).

Ruling: retain physical promise without a logical cycle timeout — a deadline cannot prove lease/child settlement and must not permit another cycle.
Ruling: global failed reap conservatively skips dependent dispatch — no per-company stop authority exists in the current periodic coordinator; broader dispatch would guess ownership.

## Work in progress

PC-05/06 scope/probe/predecessor changes, PC-12 locked fairness, subprocess cancellation, synthetic workspace measurement remain uncommitted at this checkpoint. Focused quota plus predecessor helper: 28 tests passed. Physical cancellation plus adapter probe regressions: 26 tests passed. Server `tsc --noEmit` passed after this worktree's SDK and runner TypeScript prerequisites were built.

Adjacent failure under diagnosis: `heartbeat-task-drain-admission-release.test.ts` / `leaves the run row running for the orphan reaper when the atomic release fails` expected running but observed queued. The test injects transaction-index-specific faults; regression must be resolved before handoff.

## Isolation and unrun checks

All shell invocations use RTK; no `.codegraph` index exists. Node v24.21.0 first PATH, isolated `PAPERCLIP_HOME=/tmp/paperclip-runtime-tests-20261004`, `DATABASE_URL` unset; offline frozen install with scripts disabled. No dependencies or compiled package links to main. No port3100/service/default DB/config, real Agent or provider touched.

Full runner build reached binary phase but explicit initial PATH omitted cargo (`cargo: not found`); runner TypeScript/contract checks passed. Full repo typecheck/test/build and real configured provider/ACP hello acceptance remain Root integration work. ACP environment test currently checks CLI login/scaffold only: exact ACP quota path is explicitly unsupported, never certified from CLI or classified as quota exhaustion.
