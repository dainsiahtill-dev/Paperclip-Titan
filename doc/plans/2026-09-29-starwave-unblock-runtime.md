# Starwave Task Wake and Own-Task Write Recovery Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Preserve existing issue evidence and review gates.

**Goal:** Restore progress for runnable Starwave tasks while leaving genuine Board, QA, source, and training gates intact.

**Architecture:** The Paperclip run-attribution guard will recognize a validated timer heartbeat writing its own assigned task as an own-task write. Cross-task writes remain capped and unbound writes to other tasks remain denied. Live issue recovery will use existing Board APIs and task-bound wakes; no old run replay or automatic approval substitution.

**Tech Stack:** TypeScript, Drizzle, Vitest, Paperclip REST API, local PostgreSQL.

**Spec:** `doc/SPEC-implementation.md` V1 non-terminal liveness and recovery ownership rules.

## Global Constraints

- Keep all writes company-scoped and activity-attributed.
- Preserve single-assignee checkout and cross-task influence cap.
- Preserve QA/Board approval gates; never mark blocked business work done without evidence.
- Preserve unrelated Starwave workspace changes and existing run artifacts.

## Review Focus

- A timer run may update its own assigned task after its persisted run identity is validated.
- An unbound run may not update another agent's task or an unassigned task.
- A wrong-company or wrong-agent run stays denied.
- A task-bound run still uses existing same-task and cross-task counting rules.
- Reassignment of a deleted Agent's task must not replay the deleted Agent's execution.

## Tasks

### Task 1: Own-task timer write attribution

**Files:** `server/src/services/cross-issue-influence-limit.ts`, `server/src/__tests__/cross-issue-influence-limit.test.ts`.

- [ ] Add regression cases for a valid unbound timer run writing its own assigned issue, and for other or unassigned targets.
- [ ] Run the focused test and verify the own-task case fails before implementation.
- [ ] Query the target issue within the run-validation transaction and exempt only a company-matched, agent-assigned own-task write when the run has no source issue.
- [ ] Run the focused tests, server typecheck, and build. Commit the scoped patch.

### Task 2: Restore Starwave task routing

**Files:** Paperclip issue records and existing run/workspace records.

- [ ] Recheck SOU-84 recovery action and old workspace ownership, then Board-reassign frontend work to current 星界 without replaying the old run.
- [ ] Diagnose SOU-16's failed Claude run from actual run events and config; repair the provider path or switch the role to an already proven local Codex model if needed.
- [ ] Resolve Board cards only where the user's existing authorization and evidence support a specific choice. Keep missing external executor, restricted holdout access, and training gates explicit.
- [ ] Wake actionable assignees once with task-bound context and verify queue/run result and issue status.

### Task 3: Deploy and verify

- [ ] Drain and restart the local Paperclip source server using the established script after tests pass.
- [ ] Verify `/api/health` reports the new commit and startup recovery ready.
- [ ] Verify an actual own-task timer write or equivalent live task-bound continuation, plus no stranded runnable issues.
- [ ] Report remaining genuine blockers with their owner and next action.
