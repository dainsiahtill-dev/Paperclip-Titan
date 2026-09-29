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

The final claim transaction holds the issue row, then checks the current wait sources and the dependency wake's cycle-aware idempotency key before changing the run from queued to running. Issue-thread interaction creation and approval linking serialize on the same issue row. A child-completion wake uses the same wait gate; when that child is also a formal blocker, the dependency wake and its cycle key take precedence. If all children finished while another wait was active, clearing the final descriptor re-evaluates child readiness and wakes the parent once. Guarded wakes coalesce only when the original queued receipt has the same reason and key; different queued identities remain separate, while a running owner defers the new wake. Rejected wakes record a concrete reason and leave the issue blocked. A valid transition to ready still wakes once; a later blocked cycle has a new key and cannot consume an old queued wake.

### Task and review flow

One delivery issue owns implementation, candidate commit/tree, scope, and acceptance result. Supervisors coordinate in that issue; a child issue is reserved for a separately executable deliverable with its own assignee or a genuinely parallel task. Configure an independent reviewer on the source issue when the existing review stage suffices. A separate QA issue is used only when the reviewer must run independent work. The manager accepts the QA verdict in the parent without another chain of coordination issues. CEO intervenes on changed product scope, resources, an unresolved dispute, or final business acceptance.

At most one active implementation candidate per shared integration branch and one independent QA run per frozen candidate. A rejected candidate opens a repair on the source issue; the next QA run names the changed candidate. External resource waits remain visible and event driven.

### Workspace and evidence

Keep the Starwave primary project workspace for integration and running services. New independent implementation jobs use issue-specific sparse Git worktrees, with explicit sync into a single integration candidate. A normal worktree copies approximately 67 GB of tracked `backend/runtime` data, so the worktree must be created with `--no-checkout`, a bounded sparse profile, then checkout. The helper estimates size before creation and verifies the materialized size before reporting success. Paperclip attaches an existing branch with `requireExistingWorktree: true`; it fails closed instead of creating a full checkout if the sparse worktree is missing. QA reads the frozen commit/tree and does not write into the candidate. The existing dirty shared tree is inventoried before any branch migration; no uncommitted work is moved or discarded automatically.

The dashboard reports run activity separately from registered delivery signals. It may count issue work products and their author-writable approval labels, but must identify those labels as self-reported. It must never derive independent review or product acceptance from `done` counts, work-product labels, or liveness `advanced`; if no trusted acceptance record exists, show that acceptance is unrecorded. Starwave's actual release gate remains in its domain evidence and personal review.

## Rollout

1. Add regressions and fix dependency/self wake admission in the fork. Validate pending interaction, approval, descriptor, true dependency completion, stale queued wake, and cycle changes.
2. Show activity and evidence as distinct dashboard measures without altering liveness recovery semantics.
3. Reconfigure CEO/managers to skip empty generic timer turns; keep event wakes and a bounded periodic governance check. Remove redundant self-owned descriptors from tasks already covered by live dependencies, using current API readback and without modifying unrelated tasks.
4. Introduce the size-bounded sparse worktree/frozen-candidate procedure for new work; keep current active Starwave runs intact until their write boundary.
5. Build and deploy the tested fork through the existing WSL supervisor. Observe live API health, blocked task wake behavior, and actual candidate/QA handoff.

## Risks and verification

Suppressing a dependency wake can strand an issue if another wait is silently cleared. Every suppressed wake therefore carries a diagnostic reason, and both a board comment/resume and the next real ready transition remain valid paths. Test the positive path as strongly as the false-wake path. A timer optimization cannot replace explicit watchdog and event delivery. Worktree adoption must not overwrite the shared dirty tree or expose sealed evaluation material. Verify local QA separately from real channel or business acceptance.
