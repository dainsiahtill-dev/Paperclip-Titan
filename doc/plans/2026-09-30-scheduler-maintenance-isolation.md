# Prevent retention scans from stopping Agent scheduling

## Observed failure

The Starwave instance served HTTP normally but left SOU-190 queued from
01:54 UTC through 09:51 UTC with no running Agent. Startup waited for
`runRetentionSweep()` before installing the heartbeat interval or shutdown
handlers. The retention attention feed repeatedly ran
`execution_workspaces.close_readiness_status` Git scans that timed out after
eight seconds. This maintenance pass could therefore delay startup scheduling
for hours. Periodic retention also had no guard against overlapping passes.

## Design

Start retention in the background without awaiting attention-feed construction.
Allow only one retention pass at a time. A pass owns an AbortController; shutdown
aborts it and prevents further archive or notification operations. Track each
archive/notification mutation in the existing scheduler shutdown ledger, while
keeping the slow read-only feed construction out of that critical ledger.

Task dispatch, pause, budget, dependency, company scope, and workspace locking
remain enforced by the existing heartbeat service. Retention uses its current
archive eligibility rules and delivery outbox.

## Verification

Use the real `startServer` startup harness with a retention feed whose promise
does not resolve. Startup must return, timer ticks must recover queued work,
and subsequent ticks must not start another retention feed. Shutdown must
finish while that feed is pending, and resolving it afterward must not archive
or notify. Existing startup and shutdown suites must remain green. Deploy at a
quiescent boundary, verify the new server PID/commit, and verify the previously
stranded queue is handled by the periodic scheduler.

## Boundary

This removes the scheduler dependency on slow maintenance. It does not make a
large Git status scan faster or prove any customer-response quality improvement.

## Residual queue admission failure

After deployment SOU-190 remained queued: 64 workspace-wait successors exceeded
the chat-control ancestry limit. The source checker returned an unresolved proof,
and the claim gate silently kept that permanent condition queued. Keep the
ancestry bound and all close/ownership checks. Return a typed `ancestry_limit`
reason and settle this permanent admission failure visibly, without provider
dispatch or automatic retry. Transient proof contention still waits. A fresh
authorized Board continuation can restore work through the ordinary admission
path. Verify both ordinary and queued-comment runs, with no provider call and
with their issue execution locks released.
