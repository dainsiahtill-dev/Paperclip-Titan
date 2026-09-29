# Evidence driven agent throughput

## Intent

For the local Starwave company, agents should run when an owned next step is executable and hand off a verifiable result. A task card, a comment, or a successful heartbeat alone must not imply product acceptance. Keep independent QA, holdout isolation, real channel evidence, and `trainingReady=false` gates intact.

## Observed failures

- SOU-16 ran 27 `issue_blockers_resolved` turns while its human input was pending. The route and backstop contain pending interaction checks, but the observed sequence passed through `issue.blockers_restored`. The exact timing must be pinned by a regression test before attribution to one branch.
- SOU-139 repeatedly re-entered `blocked` with its own assignee as `unblockDescriptor.owner`. `deliverAgentUnblockNotification` wakes that owner on each new blocked transition, and the transition timestamp gives each cycle a new idempotency key. SOU-141 has subsequently used the same self-owned wait shape.
- Run liveness counts comments and activity events as concrete action evidence. That is correct for liveness recovery, but it is not evidence of accepted implementation.
- Today's Starwave task tree reached nine levels and the project workspace is a shared local path. A freeze prepared while engineers are still writing loses its candidate identity.

## Architecture and boundaries

### Wake eligibility

Keep the existing persisted sources of truth: `issue_relations`, pending issue-thread interactions, pending approvals, `unblockDescriptor`, monitor schedules, and the issue status. Derive one wake eligibility decision at enqueue time and again at claim time. For `issue_blockers_resolved`, require at least one blocker edge, every blocker done and finalized, no pending interaction or approval that owns continuation, and no independent `unblockDescriptor`. An explicit board or agent comment/resume can still wake a blocked issue under its existing interaction rules.

An agent-owned descriptor whose owner is also the issue assignee records a wait but does not send an immediate `issue_unblock_requested` turn. A different named agent may be notified once for the blocked transition. The notification is an attention signal, not proof that the blocked condition changed. Reblocking with the same unresolved condition must not create another executable turn.

The pre-dispatch check cancels stale dependency-ready wakes before provider invocation. It records the condition that prevented execution and leaves the issue blocked. A valid transition to ready still wakes once; the existing cycle-aware idempotency key remains for legitimate later blocked cycles.

### Task and review flow

One delivery issue owns implementation, candidate commit/tree, scope, and acceptance result. Supervisors coordinate in that issue; a child issue is reserved for a separately executable deliverable with its own assignee or a genuinely parallel task. Configure an independent reviewer on the source issue when the existing review stage suffices. A separate QA issue is used only when the reviewer must run independent work. The manager accepts the QA verdict in the parent without another chain of coordination issues. CEO intervenes on changed product scope, resources, an unresolved dispute, or final business acceptance.

At most one active implementation candidate per shared integration branch and one independent QA run per frozen candidate. A rejected candidate opens a repair on the source issue; the next QA run names the changed candidate. External resource waits remain visible and event driven.

### Workspace and evidence

Keep the Starwave primary project workspace for integration and running services. New independent implementation jobs use issue-specific Git worktrees or branches, with explicit sync into a single integration candidate. QA reads the frozen commit/tree and does not write into the candidate. The existing dirty shared tree is inventoried before any branch migration; no uncommitted work is moved or discarded automatically.

The dashboard reports run activity separately from durable delivery signals. It may count issue work products, document revisions, and status transitions, but labels them by evidence type. It must never derive product acceptance from `done` counts or liveness `advanced`; if no trusted acceptance record exists, show that acceptance is unrecorded. Starwave's actual release gate remains in its domain evidence and personal review.

## Rollout

1. Add regressions and fix dependency/self wake admission in the fork. Validate pending interaction, approval, descriptor, true dependency completion, stale queued wake, and cycle changes.
2. Show activity and evidence as distinct dashboard measures without altering liveness recovery semantics.
3. Reconfigure CEO/managers to skip empty generic timer turns; keep event wakes and a bounded periodic governance check. Remove redundant self-owned descriptors from tasks already covered by live dependencies, using current API readback and without modifying unrelated tasks.
4. Introduce the worktree/frozen-candidate operating procedure for new work; keep current active Starwave runs intact until their write boundary.
5. Build and deploy the tested fork through the existing WSL supervisor. Observe live API health, blocked task wake behavior, and actual candidate/QA handoff.

## Risks and verification

Suppressing a dependency wake can strand an issue if another wait is silently cleared. Every suppressed wake therefore carries a diagnostic reason, and both a board comment/resume and the next real ready transition remain valid paths. Test the positive path as strongly as the false-wake path. A timer optimization cannot replace explicit watchdog and event delivery. Worktree adoption must not overwrite the shared dirty tree or expose sealed evaluation material. Verify local QA separately from real channel or business acceptance.
