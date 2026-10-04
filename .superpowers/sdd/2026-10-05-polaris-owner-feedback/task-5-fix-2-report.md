# Task 5 Fix 2 — sequential private-root reservation

Base: `d35e4e3de962be0fab087c394098716e63ae46fb`.
Worktree: `/home/dains/Documents/paperclip/.claude/worktrees/polaris-feedback-20261005`.
Scope: the single P1 in `task-5-fix-1-review.md`.

Root's exact-source freeze was honored: only report/source reads and design work
occurred before root explicitly sent `source tests finished`. Root's d35e six-file
acceptance completed 265/265 before this fix began.

## Change

`reservePrivateRoots` first validates the exact owner/generation/company/run and
reserved state. For that current owner only, an existing private resource with
both the same canonical path and physical key is idempotent. Its own source and
service roots, nonidentical overlapping private resources, and every other
owner/service/unknown resource still conflict. Only genuinely new private roots
append history; existing reservation events are retained unchanged.

The guard, launch/bind/drain API and final release checks were not changed. No
current-row blanket bypass, generation transfer, TTL release, native/service
lifetime change or Task 6 evidence feature was added.

## Actual RED → GREEN

New regression uses an isolated PostgreSQL database and the real
`workspaceWriteOwnershipService(...).guard(...)`, with a real private directory
and two sequential contained `/bin/sh` writers under one owner. The first process
writes `first`; the second must append `second`.

Before the fix, the first launch/drain succeeded and the second failed before
dispatch with `workspace_write_private_root_source_overlap`. Observed RED log:
`/tmp/paperclip-task5-fix2-red.log`. This was a real durable reservation conflict,
not the synthetic Codex fixture guard.

After the fix, the regression proves:

- Both writes occur after separate durable binds and have distinct launch IDs.
- Source and private-root exclusion remain held between the two launches.
- Own-source and other-owner/private-source reservations remain rejected.
- The old stop receipt and premature release are rejected while launch two runs.
- Both physical drains are persisted; final stop receipt identifies launch two.
- Exactly one private reservation event remains, followed by successful final
  release and new admission of the formerly private root.

## Verification

Commands ran from the worktree with the existing isolated Node 24 wrapper.

```text
rtk proxy python3 .superpowers/sdd/2026-10-05-polaris-owner-feedback/run-isolated-check.py --bwrap exec vitest run server/src/__tests__/workspace-write-ownership.test.ts -t 'one durable private-home reservation'
```

RED: exit 1, the selected actual double-launch test failed; 13 unrelated cases
were not selected. Log: `/tmp/paperclip-task5-fix2-red.log`.

```text
rtk proxy python3 .superpowers/sdd/2026-10-05-polaris-owner-feedback/run-isolated-check.py --bwrap exec vitest run server/src/__tests__/workspace-write-ownership.test.ts server/src/__tests__/heartbeat-workspace-busy.test.ts
```

GREEN: exit 0, 2 whole files / 31 tests passed / no skips, 67.35 seconds.
Ownership 14/14, heartbeat 17/17. Log: `/tmp/paperclip-task5-fix2-whole.log`.

```text
rtk proxy python3 .superpowers/sdd/2026-10-05-polaris-owner-feedback/run-isolated-check.py exec tsc -p server/tsconfig.json --noEmit
```

Exit 0. Log: `/tmp/paperclip-task5-fix2-types.log`. `git diff --check` also passed.
No migration changed. The unchanged guard/Codex files and 166-case runtime suite
were not rerun, following root's requested affected-scope verification.

All new effects, children, roots and DB state were private fixtures; both process
promises settle and cleanup removes their files/database. No live/default3100
API/DB/service, provider/model, install/upgrade, production auth/config or Polaris
operation occurred. Root's plan/ledger and independent review files were not
modified. Earlier Task 5 and Fix 1 reports/logs remain intact.

Remaining limits are unchanged: one instance/Linux realm, conservative uncertain
service/native holds, and the separate Task 6 read-only/source-evidence interface
gap. No new blocker remains within this fix; root owns independent acceptance.
