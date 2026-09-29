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

- [ ] Add a regression for archiving a non-runtime-owned shared project directory. Treat preserved directory as successful record cleanup, without deleting it.
- [ ] Stop route-time dependency restoration wakes while a pending answer already owns the continuation; keep the periodic backstop's existing wait guard.
- [ ] Let Board explicitly reconcile a stopped old Agent run to a new assigned Agent without replay, recording observed outcomes and routing the successor to the new owner. Keep mismatched and unverified transfers denied.
- [ ] Recheck SOU-84 recovery action and old workspace ownership, then Board-reassign frontend work to current 星界 without replaying the old run.
- [ ] Diagnose SOU-16's failed Claude run from actual run events and config; repair the provider path or switch the role to an already proven local Codex model if needed.
- [ ] Resolve Board cards only where the user's existing authorization and evidence support a specific choice. Keep missing external executor, restricted holdout access, and training gates explicit.
- [ ] Wake actionable assignees once with task-bound context and verify queue/run result and issue status.

### Task 3: Deploy and verify

- [ ] Drain and restart the local Paperclip source server using the established script after tests pass.
- [ ] Verify `/api/health` reports the new commit and startup recovery ready.
- [ ] Verify an actual own-task timer write or equivalent live task-bound continuation, plus no stranded runnable issues.
- [ ] Report remaining genuine blockers with their owner and next action.

### Task 4: Quiet optional Plan document loading

**Files:** `ui/src/hooks/useIssuePlanDocument.ts`, `ui/src/hooks/useIssuePlanDocument.test.tsx`.

- [ ] Prove a task with no Plan uses the shared document-list query without a 404 request, and a newly added Plan appears after document invalidation.
- [ ] Use the existing full-document list cache to select the optional Plan; preserve null and refetch behavior.
- [ ] Run the focused UI test, UI typecheck, and build.

### Task 5: Classify MiniMax overload without false login prompts

**Files:** `packages/adapters/claude-local/src/server/parse.ts`, `packages/adapters/claude-local/src/server/parse.test.ts`.

- [ ] Reproduce a parsed HTTP 529 terminal result with earlier assistant text mentioning login; it must remain transient, not auth-required.
- [ ] Prefer the terminal error status over untrusted prior stdout for login classification, preserving real 401/403 and unparsed CLI login prompts.
- [ ] Run adapter tests and typecheck; verify an actual failed run is no longer classified as login-required on 529 after deployment.

### Task 6: Reveal task history while a retry is scheduled

**Files:** `ui/src/components/TaskChatThread.tsx`, `ui/src/components/TaskChatThread.test.tsx`.

- [ ] Reproduce a task with a `scheduled_retry` run whose log cannot be hydrated; its history must still appear.
- [ ] Wait for persisted log hydration only for running or terminal runs, matching the log reader's readable statuses.
- [ ] Verify task thread tests and a real SOU-16 browser view no longer retain the skeleton.

### Task 7: Ignore archived children in active blocker attention

**Files:** `server/src/services/issues.ts`, `server/src/__tests__/issue-blocker-attention.test.ts`.

- [ ] Reproduce a blocked parent with one live blocker and an archived old child whose cancelled dependency must not override the live path.
- [ ] Exclude hidden child rows from implicit attention traversal while preserving explicit dependency edges.
- [ ] Verify blocker-attention tests and the live SOU-6 projection after deployment.
- [ ] Count an admitted queued run bound to the current assignee as a live path even before checkout fills `executionRunId`.
