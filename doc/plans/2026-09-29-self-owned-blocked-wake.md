# Preserve a successor wake for self-owned blockers

## Observed failure

On SOU-103, an agent-created issue, 星枢 tried to create another child assigned to itself. The issue-create route correctly rejects that shape with `delegation_cycle` HTTP 409: an open ancestor was created by the proposed assignee. The agent's raw `urllib` call printed only `HTTP Error 409`, so it misattributed the rejection to a shared-workspace conflict. It then changed SOU-103 to `blocked` with an unblock descriptor owned by itself. At that moment the same agent still held the issue execution run. Paperclip set `blockedOwnerNotifiedAt`, but no successor run remained after the current run finished. SOU-103 had zero unresolved formal dependencies; its descendants remained blocked, while the queue was empty. A separate QA task, SOU-101, was left in `backlog` despite a frozen frontend tree and no blockers.

## Module boundary and change

`server/src/services/routable-blocked.ts` owns the one-shot owner notification for a new blocked transition. It calls `heartbeat.wakeup` from the issue-update route. The wake queue normally coalesces a same-agent/same-issue wake into the still-running execution. A blocked-owner notification is future work: the current run just blocked the issue and cannot satisfy its own notification. Send this wake with `allowRunCoalescing: false`, so the existing wake-queue admission path persists it as `deferred_issue_execution` and promotes it after the current run releases the lock. Keep the existing one-transition idempotency key and `blockedOwnerNotifiedAt` stamp. Do not add periodic retry loops or lower task governance gates.

The `delegation_cycle` rejection itself is correct. Managed agent instructions should require reading an HTTP error response body and using the server's `details.code` before naming a cause. On `delegation_cycle`, continue the remaining work in the current issue or leave a child unassigned; do not invent a workspace blocker. Managers and CEO should verify blocked descendants with zero formal dependencies have a real next run or a tracked external decision. QA follow-ups that are ready for independent work belong in `todo`, not `backlog`.

## Verification and limits

- Red/green unit test: an owner notification explicitly disables coalescing and is stamped once per blocked transition.
- Run wake-queue policy/use-case tests proving `allowRunCoalescing: false` defers behind the active issue execution and the successor is promoted after release.
- On the live instance, correct SOU-103's false blocker only after confirming the 409's creator/assignee chain, zero unresolved dependencies, and no active execution. Preserve its dirty source tree and wake the existing assignee. Move SOU-101 to `todo` only after verifying the frozen frontend tree and no blockers; confirm a QA run starts.
- Two pending review interactions still require their named decision makers. A task being blocked by those reviews is not an excuse to bypass them. Completion of SOU-103 still requires its own isolated end-to-end checks and independent QA.

## Addressee interaction dispatch found during the audit

SOU-36 has a pending `ask_user_questions` card addressed to CEO (`effectiveResolverPolicy=anyone`), while the issue assignee is 星衡. Paperclip queued a CEO run for the card, then cancelled it with `issue_assignee_changed` before startup. The dispatch adapter's interaction exception only recognized comment wakes, not `interaction_pending` issue-thread cards. Thus the valid named addressee never got a turn. Two older mention wakes stayed `deferred_issue_execution` with no execution lock, so the review-attention projection incorrectly showed a covered path.

In `server/src/modules/run-dispatch/adapters/postgres.ts`, recognize a pending card wake for a non-assignee only after reading the current card by interaction ID, company, issue, pending status, and exact addressee agent from the database, then applying the existing resolver-audience policy. Do not trust caller-supplied context alone. Tests must retain the queued run for the valid CEO addressee and cancel resolved, human-only, and wrong-addressee variants. The preexisting deferred mention receipts are historical data and need separate read-only reconciliation before any cleanup; do not blindly replay them or treat them as proof of an active reviewer.
