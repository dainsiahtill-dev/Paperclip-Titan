# Stale comment wake repair

## Confirmed incident

POL-16's board acceptance comment reopened its then-blocked task at
2026-10-06T15:53:56Z. The board marked the task done immediately afterward.
An asynchronous `issue_reopened_via_comment` wake created run
`0fb0cd82-b1ca-4bf9-93c0-390c82f899af` at 16:17:30Z. It started after the
same employee completed POL-21, at 16:34:30Z, then failed with
`continuation_task_ownership_changed`. The assignee had not changed.
PID, process group, process start and log reference were null; the persisted
result explicitly records `bootstrap/providerWorkStarted:false`.

The queue allowed comments to bypass terminal status, while the owner-scoped
continuation builder rejected completed tasks. Ordinary work also lacked the
final atomic dispatch check already used by resolved interactions.

## Resulting behavior

- Admission under the company-scoped task lock records a skipped wake for
  completed/cancelled work, without creating a run.
- Queued comments no longer bypass terminal status. The existing dispatch
  transaction cancels stale runs, skips their wake and releases only the
  execution lock that still names that run.
- Fresh ordinary work is revalidated at startup and under task/run locks at
  provider handoff. An owner-scoped continuation must still have its assignee;
  a comment notification exemption cannot authorize the previous owner's work.
- Bootstrap continuation races use the same cancellation path. Missing tasks,
  terminal tasks and changed owners have distinct continuation errors.
- Cancelled preparation completes its existing resource cleanup and restores
  employee status through normal finalization. It does not report an adapter
  failure or invent a provider/namespace exit.
- Explicit resume/session controls and legitimate non-assignee notifications
  retain their existing semantics. Existing native runner adoption/recovery
  paths retain their physical ownership protocol.

Historical failed runs and reports remain authoritative history. No Polaris
source, task outcome, resource policy, employee model, connection or scheduler
setting is changed by this repair. POL-21's source findings and resource limit
are separate from this incident.

## Verification boundaries

Regression tests exercise real isolated PostgreSQL and heartbeat orchestration;
the external model adapter is replaced at its boundary. They cover terminal
admission, terminal queued comments, final handoff races, reassignment with and
without comments, preserved non-assignee notification authority, idempotent
cancellation and a successful second task after skipping obsolete work.
Continuation tests distinguish missing/terminal/changed-owner errors.

These checks prove control-plane dispatch behavior. They do not claim Polaris
source correctness or fresh Bench qualification. Final command results and
deployment identity are recorded below after verification.

### Accepted checks

- Real RED: terminal comment queue cancellation (2 failures); admission and
  final handoff (4 failures); precise continuation errors (3 failures);
  owner-scoped comment reassignment (1 failure).
- Final complete heartbeat process-recovery file: 327 passed.
- Complete run-dispatch module and continuation file: 144 passed.
- Complete issue-recovery-actions file: 84 passed.
- Complete heartbeat issue-liveness escalation file: 26 passed.
- The 581 cases above are distinct. The additional targeted 11-case run and
  independent two-case native recovery check overlap and are not added.
- Server `tsc --noEmit`, emitting `tsc`, server build and `git diff --check`
  exited 0. Runner build retains existing Rust warnings.
- Independent review accepted the final native recovery exclusions and
  owner-scoped assignment check, with no blocking findings.

An intermediate full recovery run had three failures: the new second-work
fixture initially inserted an issue before its referenced run, and two existing
native recovery tests detected unwanted fresh-dispatch locking. The fixture
ordering and native recovery exclusions were fixed; the full file then passed.
The issue-recovery suite initially detected an extra skipped reconciliation
receipt; its original assertion was preserved and all 84 cases then passed.
Fault-injection suites emit expected failure logs. The unchanged adapter module
fixtures also emit duplicate event-sequence warnings; no assertion is weakened.

This is bounded server verification. The entire monorepo typecheck/test/build
and a fresh paid provider/Polaris Bench run were not repeated for this repair.
Production deployment acceptance is a separate record.

## Production deployment acceptance

Implementation commit `1a5c53eca9832c3709fc01c1ef404c0fe9a65ef9` was merged
and pushed to main after fetching origin. No remote changes required conflict
resolution. The main checkout's server build also exited 0.

The exact default3100 service had no active/pending work before maintenance.
Formal hot-restart intent was recorded, the existing supervisor stopped, and
the verified default54329 PostgreSQL process stopped cleanly. The cold instance
copy had 22,945 regular files with no missing/size-mismatched files; config,
environment and database control hashes matched before restart. Full backup
hashing finished against the immutable copy after restart: 22,947 files,
26,418,600,658 bytes, manifest SHA-256
`53b00d3ef031112147e7688821cc4bb941deed9325e84662561e1e2c2e6768b0`.
Backup original: `/home/dains/.paperclip/backups/stale-wake-20261006T172910Z`.
Polaris source/workspaces were excluded from the backup.

The same supervisor, default instance, config and static UI restarted with
`--no-repair`. Health reports `2026.916.1+175.git.1a5c53eca`, startup recovery
ready; hot-restart report has no lost/adopted/finalized/skipped runs. A database
idle check issued during startup initially returned connection refused; after
ready, the same check confirmed no active/pending runs or wakes. It did not
trigger a duplicate service launch.

The exact employee's latest failure was still the incident run. The official
board `clear-error` API restored its status from error to idle, recorded normal
activity and started no provider. The historical failed run remains unchanged.
Post-deployment comparison confirms all 26 Polaris employee configurations,
all 21 tasks and the instance config hash are preserved; no live run exists.

An owned Edge 154 browser opened both POL-16 and POL-21 successfully with no
page errors. Its read-only guard blocked two POST read-marker requests; it sent
no task/employee mutations. Browser teardown confirmed no remaining owned
processes. Original private logs, screenshots, before/after state and backup
proofs are registered at
`/home/dains/.paperclip/diagnostics/stale-comment-wake-20261007/`.

This closes the obsolete-comment dispatch incident. It does not close POL-21's
reported source defects, its resource-policy block, or other project work.
