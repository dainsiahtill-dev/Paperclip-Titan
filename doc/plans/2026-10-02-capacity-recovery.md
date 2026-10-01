# Terminal capacity recovery after controller restart

## Observed failure

Run `734522dd-bd9e-42b3-9fbc-2719141eb246` was interrupted by graceful shutdown.
Its adapter PID/process group 64516 no longer exists, but its capacity reservation
is still unreleased. Both subsequent runs for the same idle Agent wait at 1/1.
The terminal sweep skips any former controller that recorded a process ID.
Shutdown terminalization does not itself release capacity; executor cleanup can
be lost when the server exits.

## Design

- Keep reservation accounting and native recovery unchanged.
- Persist server-authored legacy process identity events atomically with process
  metadata, including controller boot ID and Linux boot/PID-namespace fingerprint.
- Persist a stop receipt only after observing both PID and process group absent.
  Bind receipts to the exact run/company/controller/process generation.
- On subsequent scheduler ticks, accept a matching stop receipt, or observe an
  expired controller's absent process only in the same recorded host namespace.
- Unknown hosts, permission errors, live children/groups and active local adapter
  executions retain capacity. Terminal status alone never proves termination.
- Spawn provenance explicitly marks remote SSH as nonlocal, even without an
  environment lease; sandbox lease provenance provides an independent fence.
- Graceful shutdown records stop evidence after termination; normal completion,
  cancellation and sweeper recovery share the same release path. No new user gate.
- Shutdown also aborts opted-in ACP adapter controls after recording interruption;
  these adapters do not register in the older runningProcesses map. Finalizer
  drain must await their physical cleanup instead of waiting for lease expiry.
- Historical runs without host evidence require a narrowly audited operator stop
  receipt; never infer another controller's host from numerical PID alone.

## Boundaries and verification

The event store carries identity/stop evidence; no schema migration or UI changes.
Tests use disposable Postgres and real subprocesses. Reproduce a missed release
across controller restart, verify queued dispatch exactly once, verify alive/group
protection, foreign namespace refusal, stale receipt invalidation and bootstrap
recovery. Retain MiniMax six-slot and native retry capacity regressions. Run server
typecheck/build and scoped suites, deploy main, then verify the original idle
Agent's queued tasks really start and the old reservation is released.

## Verification record

- Clean baseline: 11 capacity tests passed.
- Before fix: both real-process restart cases failed at unreleased capacity.
- Before ACP shutdown fix: opted-in adapter shutdown failed to release capacity.
- Before remote fences: sandbox and lease-less SSH stop-proof cases failed.
- Recovery/capacity/lease suite: 328 passed before the final remote guard;
  subsequent targeted shutdown tests: 3 passed (295 unrelated cases skipped).
- Final capacity/lease suite including both remote fences: 33 passed.
- Server TypeScript check and full server build passed after worktree dependency
  setup (Node 24; Cargo path and nested plugin SDK dependencies restored).
- Full `pnpm test` was started, then intentionally stopped during unrelated chat
  integration work. No repo-wide passing claim; scoped recovery evidence above
  is the gate for this fix. No UI/schema changes or Starwave GPU work.
- Independent source review accepted the final remote provenance guard and found
  no remaining critical/important issue. Current-controller numerical PID fallback
  predates this fix; it does not grant the new durable cross-controller authority.
