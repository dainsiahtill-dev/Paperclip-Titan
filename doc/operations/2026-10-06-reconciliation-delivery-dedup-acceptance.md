# Historical reconciliation delivery repair — 2026-10-06

Status: implementation and independent review complete; full repository tests and live rollout acceptance remain pending. The overall POL execution goal is active.

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
- Full workspace typecheck and build: exit0 before final small capture/normal-runtime-path delta; final server tsc exit0. Final source remains frozen for checks.
- Independent reviewer approved after correcting runtime binding, stale employee capture and binding transaction races; latest missing-capture delta also approved.
- Full `pnpm test:run` is still running; no all-suite passing claim is made.
- Live default3100 service remains loaded650b69ff7. Employee wakes are disabled. No rollout, model/probe replay, deleted locks/history, forced live run state, sandbox bypass or source-directory changes occurred.

Private original diagnostics and check logs: `/home/dains/.paperclip/diagnostics/postboot-execution-20261006/goal-continuation/reconciliation-dedup/`. The next step is full check completion, an idle-instance backup and exact default-service restart, then verification that all five historical records point to one actual POL-6 residual validation run. A test or process exit alone is not that acceptance.

## MCP semantic error propagation

The actual JSON-RPC tools/call route always emitted outer isError:false even
when the normalized upstream MCP result reported isError:true. A real
embedded-database/named-gateway/HTTP-MCP fixture reproduced that error while its
successful-result control passed. The minimal route correction propagates only
the normalized protocol flag; it does not inspect ordinary structured business
data, alter content, change timeouts, approvals or sandboxing. Positive/negative
controls passed. Expanded gateway/connection/authorization suites remain pending;
no live rollout or complete-platform claim is made from this protocol test.
