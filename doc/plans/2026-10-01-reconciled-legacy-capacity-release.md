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
