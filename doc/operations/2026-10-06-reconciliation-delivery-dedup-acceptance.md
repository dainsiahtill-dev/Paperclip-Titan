# Historical reconciliation delivery repair — 2026-10-06

Status: reconciliation, semantic-error, preparation retry and formal hand-back repairs are deployed on default3100 at fd35ea339 and pushed to main. Actual POL-6 public validation completed and was independently reviewed; its product defects remain open in review. Whole-suite results and current failed-file rechecks are recorded below. The overall goal is active.

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
- Full `pnpm test:run` finished after 5,991.9 seconds: 12,899 passed, 2 failed, 64 skipped; 675 files passed, 2 failed, 5 skipped. Its long-running worker captured a pre-final recovery implementation and a local guidance scan included ignored nested maintenance worktrees. Current complete recovery-action suite passed 84 tests; current complete CLI-safety suite passed 40 after a root-worktree boundary correction. This is a broad run plus explicit final failed-file rechecks, not a new single frozen-source all-green run.
- Live default3100 service loaded e76c78610 with health/auth/startup recovery ready. All five historical records were delivered to the same successor 3e28aaff-05f5-4d8e-8e98-80c024a13a30. That successor failed during preparation because its preserved inherited deadline had already expired; no model, launcher, command or workspace operation executed. Delivery deduplication passed; successful remaining-work execution is still pending.
- Employee automatic/on-demand wakes were restored to disabled after bounded dispatch attempts. No locks/history were deleted, no live run state was forced, and no sandbox or source-directory bypass was used.
- A database-stopped control-plane backup verified 11,832 files and 1,304,448,088 bytes, archive SHA256 `2200b2f885ee65626871f7cc567e7df3124335305b39053031f7bfccb5f17a46`. This backup followed the supervisor's first automatic restart; it is not represented as a backup taken before that first rollout. Polaris source/workspaces are outside its selection.

Private original diagnostics and check logs: `/home/dains/.paperclip/diagnostics/postboot-execution-20261006/goal-continuation/reconciliation-dedup/`. The old source deadline and failure remain unchanged. Actual employee execution, bounded public validation and exact namespace/owner/lease closure are accepted; product corrections remain with the POL-6 owner.

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
Live admission with the new code passed: exact-source `retrySupersession`
returned HTTP202 and created run `f0f0c63c-a760-4e1c-b71b-a43774168207`.
It entered `dispatching` with a real process and a new deadline of
2026-10-06T10:44:32.661Z, 600 seconds. Source `3e28aaff` remains failed with its
original 2026-10-05T19:25:51.348Z deadline and no process. Timer/on-demand wakes
were restored to disabled. The run executed six actual protected commands and
two governed CodeGraph queries, then returned a blocked audit report: A/B/C
were not invoked because Root's instruction named a nonexistent
`.venv3.13.12` directory. Root verified the existing `.venv/bin/python` is
CPython 3.13.12 with project dependencies and corrected the instruction. One
source read also failed on an investigator's guessed contract path; this is
not evidence of a product or sandbox defect. The report and all source hashes
are preserved. Exact owner/lease release and actual namespace drainage passed.
Process success does not turn this blocked report into dynamic acceptance.

The remaining-work task ceiling was extended from two to three automatic runs
for exactly one corrected continuation; actual usage remains two,
`maxNoProgressRuns=1`, 600-second deadline, model and sandbox are unchanged.

## Restored owner wake classification

The corrected interpreter continuation exposed a separate framework defect.
Public recovery resolution recorded `handed_back`, but the provider wake still
contained the resolved action's old recovery instructions. The adapter classified
the restored source owner as recovery-only; run `14d242c6` inspected governance
instead of A/B/C and handed the task to Board review. Exact namespace/owner/lease
closure was verified; no product implementation or dynamic acceptance occurred.

A real PostgreSQL regression resolves an action through the public route and
then constructs its provider wake. RED reproduced the stale recovery object.
The bounded correction suppresses those instructions only for a formal
`issue_recovery_action_restored` wake matching the action's source issue and
recorded return owner, with a settled action. Existing reconciled-execution
behavior remains. Active/escalated actions, queued recovery-owner wakes,
different source issues and missing/wrong owners retain their recovery boundary.
The complete recovery-action suite passed 84 tests, server typecheck/build
passed, and independent review approved the strict source/owner boundary.
Read-only projection of the actual `14d242c6` ledger changed recovery-only from
true to false while preserving the issue. The correction is deployed and pushed
at `fd35ea339`. Health/auth/startup recovery are ready. Current normal owner run
`161b94e3-c0bb-4ff0-b4b7-efc668a1a56a` has `recovery:null` and a new 600-second
deadline; the employee explicitly accepted only A/B/C public validation. One
additional allowance preserves the prior three automatic runs and permits this
bounded continuation. Actual dynamic delivery and independent review are recorded
below; no all-terminal-wake claim is made.

## Actual residual delivery and remaining product work

Run `161b94e3` finished successfully with an explicit audit verdict and evidence
gaps. Root independently inspected its retained public returns, engineering audit
programs and source preservation. A used default/named import is incorrectly
redirected to a candidate without a default export; a comment-only export is
accepted by direct public Plan. Named-only and missing/ambiguous controls behave
as recorded. B's string case and full comment probe output remain unverified
after truncation; completed cases were not replayed.

Ten remaining C cases preserved input and source, with no product disk/network/
subprocess effects. Absolute/traversal/empty/nonstring/null cases propose no patch;
terminal-parent paths raise a public path-contract ValueError. Drive Plan/probe
also reject at the public effect contract, so no outside effect is demonstrated.
Lexical dot/backslash controls patch the canonical current importer and do not
revive the stale raw owner. All 156 preservation hashes and old reports match.
These are bounded proposal and error-contract findings, not project delivery,
TS5110, effects/settlement or fresh Bench qualification.

The writer namespace was actually empty, owner released with a stop receipt and
environment lease released. Public recovery resolution moved POL-6 to `in_review`
after Root's acceptance; it did not mark the product repair done. Automatic wakes
remain disabled. See sanitized [public validation evidence](evidence/2026-10-06-postboot-execution-repair/actual-qualification/pol6-public-validation-acceptance.json).

## CLI safety scan checkout boundary

The full-suite guidance failure came from ignored `.claude/worktrees` historical
logs of another revision. A real filesystem RED reproduced root-worktree leakage.
The scanner now skips only root `.claude/worktrees/` and `.worktrees/`. Main
`.claude/commands`, normal documentation and nested source guidance remain scanned;
unsafe command forms are still rejected. No allowlist, command parsing, source
assertion or security rule was relaxed. The complete CLI suite passed 40 tests.
