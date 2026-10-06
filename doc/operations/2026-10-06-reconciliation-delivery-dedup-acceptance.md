# Historical reconciliation delivery repair — 2026-10-06

Status: reconciliation deduplication and MCP semantic-error propagation are deployed on default3100 at e76c78610. The captured pre-dispatch retry repair is committed at 58a5fb740 and awaits rollout. Full repository tests and actual POL-6 residual execution acceptance remain pending. The overall POL execution goal is active.

## Actual defect

POL-6 had five preserved recovery actions for the same cancelled, never-started scheduled retry791d9437. Public reconciliation recorded not_performed with actual zero adapter/tool/owner/lease evidence. Each action still carried a distinct pending delivery. Per-action idempotency admitted a second source successor after the first completed. Real embedded-PostgreSQL regression reproduced two successors where one was required.

## Final implementation

Admission holds the task row lock and re-reads the company-scoped employee under FOR SHARE. It captures separate intent and effective-scope fingerprints from current task/material/user direction and normalized environment/profile/workspace policy. Equivalent historical actions reuse the same authenticated reconciliation successor, including succeeded/failed/timed_out/interrupted terminals. Each action retains its delivery receipt and the original producer identity; old source runs and history are untouched.

Profile or explicit workspace drift without new user direction keeps the decision pending. Changed objectives/materials/user messages or action outcomes can establish new work. Missing pre-upgrade capture does not become current authority: a separate RED showed it was incorrectly delivered; the final GREEN retains pending with one source successor.

Runtime-generated workspace binding is handled separately: the existing bind step locks the actual task before-view, validates original scope before writing, updates the binding and records the exact before/after effective scope in the same transaction. Concurrent explicit binding edits are rejected before overwrite. Pure lifecycle status does not create new execution permission. Normal unrelated runtime binding retains its original path.

## Verification

- Real RED: duplicate historical actions created two source successors.
- Real RED: historical successor lacking capture was incorrectly delivered again.
- Final four changed/related suites:106 PASS, exit0.
- Runtime binding, concurrent binding edit refusal and employee profile update during actual PostgreSQL lock wait:3 PASS, exit0.
- Full workspace typecheck and build: exit0 before the final small capture/normal-runtime-path delta; final server tsc exit0. The later pre-dispatch retry change also passed server typecheck.
- Independent reviewer approved after correcting runtime binding, stale employee capture and binding transaction races; latest missing-capture delta also approved.
- Full `pnpm test:run` is still running; no all-suite passing claim is made.
- Live default3100 service loaded e76c78610 with health/auth/startup recovery ready. All five historical records were delivered to the same successor 3e28aaff-05f5-4d8e-8e98-80c024a13a30. That successor failed during preparation because its preserved inherited deadline had already expired; no model, launcher, command or workspace operation executed. Delivery deduplication passed; successful remaining-work execution is still pending.
- Employee automatic/on-demand wakes were restored to disabled after bounded dispatch attempts. No locks/history were deleted, no live run state was forced, and no sandbox or source-directory bypass was used.
- A database-stopped control-plane backup verified 11,832 files and 1,304,448,088 bytes, archive SHA256 `2200b2f885ee65626871f7cc567e7df3124335305b39053031f7bfccb5f17a46`. This backup followed the supervisor's first automatic restart; it is not represented as a backup taken before that first rollout. Polaris source/workspaces are outside its selection.

Private original diagnostics and check logs: `/home/dains/.paperclip/diagnostics/postboot-execution-20261006/goal-continuation/reconciliation-dedup/`. The next step is an idle-instance restart with the captured pre-dispatch retry repair, formal authorization of a new bounded residual objective, and independent acceptance of actual employee execution. The old source deadline and failure remain unchanged.

## MCP semantic error propagation

The actual JSON-RPC tools/call route always emitted outer isError:false even
when the normalized upstream MCP result reported isError:true. A real
embedded-database/named-gateway/HTTP-MCP fixture reproduced that error while its
successful-result control passed. The minimal route correction propagates only
the normalized protocol flag; it does not inspect ordinary structured business
data, alter content, change timeouts, approvals or sandboxing. Positive/negative
controls passed. The complete three gateway/connection/authorization suites passed
167 tests. This correction is deployed at e76c78610. A protocol test alone does
not establish complete-platform acceptance.

## Captured preparation failure and remaining-work authorization

The unique live successor failed before reserving an owner or invoking an adapter.
The formal `retrySupersession` request was nevertheless rejected with
`retry_resume_stop_unverified`: the old guard required a released reservation for
every started legacy run. The new path recognizes a captured local controller
claim still in `preparing`, with an expired controller lease, a valid captured
profile, and a known Codex/Claude adapter. It additionally requires zero process
identity, adapter-invoke events, owner reservations, environment leases, tool
invocations and workspace operations. The controller commits `dispatching` before
adapter entry. Unknown, live or dispatched executions remain held.

This is positive evidence that the adapter was never entered; it is not a
namespace exit receipt. Existing ownership, scope, cleanup and new-budget
authorization checks remain. Historical usage, deadline and errors are preserved.
The complete retry-scheduling suite passed 113 tests, including ten admission
boundaries; server typecheck passed and independent security review approved.
Live admission with the new code and actual remaining-work delivery are pending.
