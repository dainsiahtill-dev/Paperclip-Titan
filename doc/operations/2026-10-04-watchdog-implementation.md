# Task watchdog restoration implementation — 2026-10-04

Scope: PC-02, DG-01/DG-02 and SPEC §9.9. Branch `fix/delivery-watchdog-20261004`, base `39451d9e9`. Work happens only in the assigned isolated worktree. Production port 3100, default Paperclip config/database, business agents, credentials, and model providers are untouched. No CodeGraph index exists; source discovery used RTK.

## Behavior and integration

- A completed watchdog task is a claim awaiting verification when the source still has unfinished work without a durable waiting path. It never earns permanent reviewed-fingerprint suppression by status alone.
- `issue_watchdogs` holds the typed current lineage, disposition, claimed/source fingerprints, bounded attempt count, action IDs and verification time. `issue_watchdog_attempts` retains attempt evidence across service recreation.
- A restoration claim arms a 30-second verification. Observed live work verifies the attempt. Durable pause, human owner/blocker, pending interaction/approval, typed execution-policy waiting state, and a bounded monitor can verify a waiting path. Ordinary activity and intermediate comments do not establish restoration.
- Fingerprints include intermediate material status, ownership, blockers and waiting state. A batch stores the post-action fingerprint in the same original lineage, so its own intermediate changes do not reset failed-attempt counting.
- Attempts are capped at 2 or 3, default 3. Exhaustion records one visible owner/board escalation with attempt history; repeated scans do not generate further wakes for that lineage.
- `POST /api/issues/:id/watchdog/recovery-batches` accepts one authenticated watchdog run, one request ID, its observed fingerprint and 1–3 strict mutations: status, comment, blockers. It validates all targets and source freshness before effects, and commits issue mutations, activity, lineage, batch receipt and outbox together. A later mutation failure rolls back earlier effects and audit/outbox writes.
- A stale request commits only its stale receipt and explanation on the reusable watchdog task. Identical request retries return the original receipt; a second request from the same run or conflicting payload is rejected.
- `POST /api/issues/:id/watchdog/disposition` records a structured legitimate-stop or restoration-claimed outcome and evidence. Claims are distinct from verified execution. A legitimate stop requires an observed durable terminal or waiting path.
- Delivery outbox rows distinguish pending, enqueued, published and suppressed. An enqueued wake is not physical execution proof. Escalated, superseded, disabled and already-live/reviewed watchdog attempts suppress obsolete pending wakes.
- UI watchdog properties expose reviewing, verifying restoration, legitimate stop and owner/board escalation with attempt counts. No manual approval is added for each recovery action.
- Monotonic configuration versions distinguish human re-enable/edits from prior exhausted lineages. Source formal approvals remain gates even if a task is currently `todo`. A third attempt cannot exhaust while its actual review run still owns execution.
- Retained provider capacity on terminal native/legacy runs produces `ownership_held`, not verified restoration or a safely stopped source. Watchdogs preserve execution/checkout locks and never write stop receipts or release reservations.
- Versioned, root-bound batch/disposition endpoints and bounded attempt metadata reach the actual provider prompt through `server-utils.ts` normalization and rendering. Malformed, unversioned and foreign endpoint metadata is dropped.

## Rulings

1. Ruling: legacy `done` without a verified source path means restoration claimed — status is insufficient proof — old integrations must record structured evidence or leave a real waiting path.
2. Ruling: explanatory comments and timestamp ticks remain outside the stop hash; intermediate material state and explicit attempt/action lineage cover failed intermediate recovery — prose must not reset retries — a novel substantive comment alone still requires explicit next-path evidence.
3. Ruling: first batch supports status, comments and blockers; existing assignment, explicit restore, monitor and interaction endpoints retain their normal authority — preserve existing guards instead of inventing broad batch payload permissions — compound restores using unsupported operations must use those existing flows.
4. Ruling: blocker references may be outside the watched subtree if same-company, because SPEC permits accurate same-company dependencies; mutation targets remain strictly in the subtree — a dependency is not a grant to mutate the blocker — no cross-company references are admitted.
5. Ruling: atomic batch uses fail-fast shared locks on liveness/gate tables plus NOWAIT config/run/subtree row locks and a try-advisory batch guard. JSON-only run/wake issue references have no issue FK/advisory fence shared by every admission path — the short transaction needs a physical concurrency fence — unrelated company scheduling can contend briefly. Locks have 2-second acquisition/5-second statement bounds and invoke no model/tool/provider. Root must review this contention cost; replacing it requires a guard shared by all relevant admission paths, not removing the stale fence.
6. Ruling: generated SQL must place `ALTER TABLE "issue_watchdogs" ADD CONSTRAINT "issue_watchdogs_company_id_uq" UNIQUE("company_id","id")` before new ledger FKs. Drizzle initially generated that statement after them; the fresh test database rejected the first FK. Only generated SQL order was corrected. Snapshots and journal remain generated and unmodified by hand.
7. Ruling: a human re-enable or real configuration change creates a new monotonic configuration version — otherwise unchanged settings can reuse an exhausted historical fingerprint — no-op config updates still preserve the current lineage.
8. Ruling: the legacy PATCH path preserves editable title/description on the reusable review container, while forbidding source completion/cancellation, interrupt and governance/resource edits in watchdog capacity — container prose is not completion authority — unsupported source edits must use a normally authorized principal outside watchdog capacity.
9. Ruling: a terminal status with unreleased canonical provider capacity means retained ownership, not a live productive path — the native/legacy verified-stop release paths own `capacityReleasedAt` — automatic recovery stays suppressed until those paths establish stop or a human reconciles ownership.

## Verification record

- RED: classifier falsely returned `already_reviewed` after a claimed restoration; intermediate status changes had identical fingerprints. Both cases failed before their implementation and then passed with the original 19 classifier tests.
- RED: batch API paths returned 404 before route implementation. Status-plus-comment, stale refusal, later status-guard rollback, and size/scope tests passed after API integration.
- Verified intermediate milestone: 49 classifier, scheduler and restoration tests passed on an isolated fresh embedded PostgreSQL database. Existing route suite also passed at its preceding integration milestone.
- RED: a normal source-row holder returned 500 instead of a concurrent-mutation 409; an obsolete outbox invoked one wake after escalation. Narrow concurrency/suppression fixes were added. Final serialized acceptance is pending at this checkpoint.
- Direct server `tsc --noEmit`, UI typecheck, UI build and all four token gates passed. UI build reported existing large-chunk/dynamic-import warnings.
- Standard server package typecheck initially stopped before TypeScript because the deliberately explicit Node PATH lacked `cargo`; direct TypeScript ran successfully after SDK build. This is not a full repository typecheck/build claim.
- A concurrency rerun under host load timed out during fresh DB setup after 165-second import time. The 30-second fixture timeout was retained. RAM was 93,460/96,535 MB used and swap 30,011/32,768 MB used. Final acceptance runs serialized, one worker, no file parallelism.
- No repo-wide suite, real browser flow, physical process-restart acceptance, production migration, real model invocation, deployment or PR has been claimed.

## Root integration requirements

Export `issueWatchdogAttempts`, `issueWatchdogRecoveryBatches`, and `issueWatchdogRecoveryOutbox` beside `issueWatchdogs` in `packages/db/src/schema/index.ts`. The local temporary export and generated migrations are excluded from the scoped commit. Root generates the combined migration serially, applies the composite-unique ordering ruling, checks fresh migration and schema drift, then performs combined full validation and isolated browser/runtime acceptance. Shared watchdog type/validator leaves use existing supported package wildcard subpaths; optional public root re-exports are additive.

## Final focused checkpoint

- Fresh isolated PostgreSQL/Express acceptance: 76 watchdog tests passed (23 restoration/atomic API including both configured two- and three-attempt bounds, 18 scheduler, 21 classifier, 11 route authority, 3 preserved incident tests). The provider-context file adds all 119 `server-utils.test.ts` tests.
- Four additional loader/registry/native provider-capacity files passed: **41/41**, 23.91 seconds. The final source-freeze command reran all ten files together: **236/236 passed**, 95.43 seconds, unchanged fixture timeouts, `--maxWorkers=1 --no-file-parallelism`. This is focused verification, not repository-wide acceptance.
- The re-enable, linked-approval activation, live-third-review exhaustion and legacy cancellation failures were observed as four real RED assertions after host resource recovery; the fixed owned suite passed. Terminal retained native/legacy capacity independently reproduced HTTP 200 instead of 409 before the ownership guard, then passed. One earlier RED attempt hit a temporary schema/fixture mismatch and is not counted as behavioral reproduction.
- Final direct server TypeScript check passed after the route helper import fix. Token gates and refreshed UI typecheck passed with the current Chinese status copy and typed configured attempt bound. The earlier UI build was green and remains a scoped build checkpoint, not a browser acceptance claim.
- Historical timeout-only runs remain recorded above and were not hidden by increasing timeouts. Current final suites ran after memory pressure cleared.
- Review: author self-review plus root integration review. No extra subagent was spawned. Root owns the fresh combined review, generated migration, full repository checks, browser flow and physical service-restart/sample qualification. No production or external business side effect occurred.

Scoped commit excludes the temporary db barrel export, SQL migrations, generated snapshots and journal. The root handoff records its hash and final UI check result separately in the shared watchdog report.
