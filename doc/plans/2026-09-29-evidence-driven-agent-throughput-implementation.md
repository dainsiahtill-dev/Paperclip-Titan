# Evidence driven agent throughput implementation plan

> **For agentic workers:** Use the existing tests and read the design first. Work task by task with a failing regression before source changes.

**Goal:** Stop no-change wake loops, make task handoffs shorter, and display delivery evidence distinctly from run activity.

**Architecture:** Derive wake eligibility from existing persisted wait primitives at enqueue and claim. Keep liveness recovery separate from delivery reporting. Apply local Starwave operating changes only after the fork passes verification.

**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Vitest, React, local Paperclip API.

**Spec:** `doc/plans/2026-09-29-evidence-driven-agent-throughput-design.md`

## Global constraints

- Preserve company scope, atomic issue checkout, approval gates, and activity logging.
- Preserve valid blocker-completion wakes and explicit human interaction wakes.
- Preserve Starwave's holdout, independent QA, real-channel and `trainingReady=false` gates.
- Do not alter or discard unrelated shared-tree changes.

## Review focus

- A blocked issue with a done child and a pending human question must remain asleep until the question is answered.
- A self-owned unblock descriptor must not immediately wake its own assignee; a different named owner still receives one notification.
- A queued dependency wake that becomes stale before claim must skip the provider.
- A dependency wake must still occur exactly once when all independent waits clear and the blocker finalizes.
- A dashboard must not label comments, documents, or `done` alone as product acceptance.

## Task 1: Blocked wake admission

**Files:** `server/src/services/routable-blocked.ts`, `server/src/services/issue-dependency-wakeups.ts`, `server/src/routes/issues.ts`, `server/src/services/recovery/service.ts`, and their nearest Vitest suites.

**Interfaces:** Add a shared eligibility helper taking the current issue wait snapshot and returning `eligible` plus a stable reason. Keep the existing wake key for eligible dependency transitions.

- [ ] Add failing tests for self-owned notification, independent descriptor/pending interaction/approval suppression, and a valid final blocker transition.
- [ ] Verify the tests fail for the expected wake behavior.
- [ ] Implement the smallest shared eligibility check at all enqueue paths.
- [ ] Verify targeted suites pass.

## Task 2: Pre-dispatch stale wake guard

**Files:** `server/src/services/heartbeat.ts` and its issue-wake integration tests.

**Interfaces:** The Task 1 eligibility helper is re-read for a queued `issue_blockers_resolved` turn before adapter invocation. Existing skipped-request and issue status semantics remain.

- [ ] Add a failing integration test for a wake queued when ready and invalidated by a new pending wait.
- [ ] Verify it fails before source changes.
- [ ] Cancel the stale queued run with an explicit reason; retain the valid ready path.
- [ ] Verify targeted issue liveness and dependency wake suites.

## Task 3: Honest dashboard evidence

**Files:** `server/src/services/dashboard.ts`, shared dashboard type, `ui/src/pages/Dashboard.tsx`, and corresponding tests.

**Interfaces:** Add a bounded recent evidence summary that distinguishes run outcomes, durable work products, and issue status. Report acceptance as unrecorded unless there is a trusted explicit result.

- [ ] Write failing API and UI tests for separate activity and delivery labels.
- [ ] Verify the red tests.
- [ ] Add the service projection and UI card without using liveness `advanced` as acceptance.
- [ ] Verify API, UI, typecheck, and build.

## Task 4: Starwave operating migration

**Files:** managed CEO/manager instructions under the local Paperclip instance, agent heartbeat config via authenticated Board API, and project operating documentation.

**Interfaces:** Keep event wakes; skip empty generic timer turns. Remove only redundant descriptors when a live dependency already owns the wait. Record before/after task and config snapshots.

- [ ] Inventory active runs and preserve current writes.
- [ ] Tighten child-task creation, WIP, QA, and escalation instructions while preserving domain gates.
- [ ] Apply bounded timer settings and redundant wait cleanup; read back every mutation.
- [ ] Verify no runnable issue was stranded and blocked issues no longer self-wake.

## Task 5: Workspace and deployment

**Files:** `scripts/create-starwave-sparse-worktree.mjs`, its Node test, `doc/OPERATING-STARWAVE-WSL.md`, project workspace configuration, service supervisor and release verification records.

**Interfaces:** New independent implementation tasks use size-bounded sparse Git worktrees attached through `existingBranch`; integration and QA use one frozen candidate. Existing dirty work remains in place.

- [ ] Document and configure the worktree workflow for new tasks.
- [ ] Run targeted suites, repository typecheck/build, and relevant full test gate.
- [ ] Integrate the fork, restart through the existing supervisor after active runs drain, and verify `/api/health` plus real issue wake behavior.
- [ ] Report actual code, tests, deployment, and remaining external dependencies separately.
