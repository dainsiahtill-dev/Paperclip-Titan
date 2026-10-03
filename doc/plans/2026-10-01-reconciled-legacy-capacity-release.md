# Release retained Local capacity after verified execution reconciliation

## Observed failure

A legacy run terminalized by the stale-lock backstop can retain both its
capacity reservation and a Local environment lease. The terminal-capacity sweep
correctly refuses to infer stop authority from a foreign controller's numeric
PID. The existing Board reconciliation endpoint also rejects the abandoned
Local lease, and recording reconciliation does not release capacity.

## Narrow change

Keep automatic reaping and foreign-controller fences unchanged. Extend the
existing execution reconciliation service only. A Board decision still requires
`providerStopped: true` and concrete action-outcome evidence. Confirm the source
run is terminal, its controller lease expired, and its recorded process and group
are gone. Unreleased leases may be retired only for a legacy run with explicitly
recorded Local driver metadata, a matching Local environment, and no provider
resource identity. Remote, unknown, native, or live-owned leases remain blocked.

The existing issue-recovery resolution transaction records the decision and
retires those Local leases plus the legacy capacity reservation together. Keep
the original terminal status, process identifiers, and failure evidence. Existing
durable continuation delivery and predecessor references remain authoritative.

## Verification

Use the real recovery route against an isolated database: reproduce the stale
Local lease rejection, then verify that an accepted decision releases capacity
and permits an existing queued run's admission. Verify live processes, live
controller leases, and remote leases remain blocked without partial writes.
Run the focused recovery and capacity suites and server TypeScript check.

Verified: the real-route regression first failed with HTTP 409 instead of 200.
After the fix, issue recovery actions, Agent capacity, and legacy reconciliation
suites passed (83 tests); server `tsc --noEmit` and `git diff --check` passed.
The tests use an isolated PostgreSQL database and no model requests.

## Operational recovery

After deployment, inspect the stopped run's action outcomes and resolve its
existing recovery action through the Board endpoint. Do not change concurrency
limits, delete run evidence, or directly clear capacity in SQL.

## Terminal Local lease maintenance (2026-10-04)

A terminal legacy conversation can have a verified `legacy.local_process_stopped`
receipt and an already-released capacity reservation while its Local environment
lease remains active. The orphan reaper only selects running rows; the terminal
capacity sweep only selects unreleased capacity; the sandbox cleanup sweep only
selects `pending_cleanup`. These selections do not revisit this bookkeeping gap.
No active recovery action may exist, so the recovery-action resolution API cannot
legitimately be used to release it.

Add a host-operator maintenance entry, dry-run by default. Its selector includes
exact company, issue, Agent, run and lease UUIDs plus the observed stop event
sequence and complete controller/PID/group/process-start/namespace identity. The
operation locks the issue, run, lease and environment, requires a terminal legacy
run, requires that the latest immutable process event is the matching existing
Local stop receipt, and verifies this host's OS/PID namespace. Unknown or foreign
namespace, a live controller, a live/unknown process owner, mismatched identity,
native execution, remote/unknown driver, or a provider resource ID refuses the
operation without writes. It does not create a stop receipt or recovery action.

Apply reuses `environmentService.releaseLease` inside that transaction, records
one local maintenance activity, and returns the exact lease state. Already
successfully released leases return an idempotent result without another write.
It does not change issue/run status, clear unrelated locks, dispatch a run, stop
processes, or operate workspace/GPU services. Database access uses the configured
existing database only; the command never starts PostgreSQL or runs migrations.
Test with a disposable real PostgreSQL fixture and real stopped child identity;
cover default dry-run, repeat apply, cross-owner selectors, stale receipt, wrong
namespace, live process/controller, native/remote leases and rollback on a failed
activity write. Root reviews/integrates the patch before a single-lease apply.

From a source checkout with Node24/pnpm and the server dependencies installed:

```sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/usr/local/bin:/usr/bin:/bin CUDA_VISIBLE_DEVICES= pnpm --filter @paperclipai/server exec tsx scripts/reconcile-stopped-local-lease.ts --config /absolute/path/to/config.json --selector /absolute/path/to/observed-selector.json
```

The selector is the strict `stoppedLegacyLocalLeaseSelectorSchema` exported by
`legacy-process-capacity.ts`: exact company/issue/Agent/run/lease IDs,
`stopReceiptSeq`, and `expectedStopIdentity` with controller boot UUID, nullable
PID/group IDs, process start timestamp, and namespace hash. Populate it from
current run/lease records and the existing immutable stop event. `eligible`
means the default dry-run made no persistent change. Append `--apply` for the
authorized single-lease operation. Require `released`/`already_released`, lease
`releasedAt` and `cleanupStatus=success`, then read the source task's
`executionBlocker` again. Other gates may still prevent a new run. This command
does not wake the task; its existing owner retains execution responsibility.

Current maintenance verification: the isolated real-database regression was
RED before the entry existed; all 21 maintenance cases pass after the fix.
The service, CLI and test import graph pass a narrow TypeScript check extending
the repository's strict base config. A bare server-wide check in the newly
installed worktree was blocked by missing built runner/plugin declarations;
this is not a claim that the entire server/repository typecheck passed.
