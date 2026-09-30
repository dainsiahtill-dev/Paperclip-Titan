# Agent quota fallback implementation plan

> **For agentic workers:** Use superpowers:executing-plans inline. Tasks use TDD;
> one fresh review covers the completed implementation.

**Goal:** Configurable CLI backup execution and automatic, verified primary recovery.
**Architecture:** Typed runtime policy, server-owned per-user durable state,
claim-pinned adapter selection, quota retry routing, capacity-controlled probes.
**Tech Stack:** TypeScript, Drizzle/PostgreSQL, Express, React, Vitest, Playwright.
**Spec:** `doc/plans/2026-10-01-agent-quota-fallback-design.md`.

## Global constraints

- Claude/Codex local CLI targets; retain primary configuration and task identity.
- Recovery interval 60–86400 seconds, default 900; no implicit enablement.
- Respect existing concurrency, budget, pause, ownership and reconciliation gates.
- Preserve user changes; use UTF-8 and RTK; no credentials in state or logs.

## Review focus

- A queued claim must not change provider identity after primary recovery.
- Backup credentials must not inherit an incompatible primary authentication.
- Quota checks must not create a seventh MiniMax call under a six-call limit.
- Existing scheduled retries must recover without duplicate successors.
- Metadata refresh must not discard unsaved Runtime settings.

## Tasks

1. **Policy and selection** — shared policy/types, validation, pure server route
   helper and tests; invalid profiles/intervals fail, disabled Agents keep their
   existing path, per-user state and pinned claims select the correct target.
2. **State and recovery** — durable state service and capacity-controlled primary
   probes; test lease/CAS races, user separation, config changes, positive/negative
   checks, all-unavailable behavior and budget/pause suppression.
3. **Heartbeat integration** — admission/execution effective Agent, quota failure
   successor, fresh session handoff, recovery timer and honest run adapter metadata.
   Add regressions to heartbeat retry/admission and run capacity tests before edits.
4. **Runtime settings** — controlled backup configuration, connection/model tests,
   interval and active-state view. Validate Save/Discard, custom models, reasoning
   efforts, credentials and metadata-only refresh in render tests.
5. **Verification and release** — affected suites plus required typecheck/build and
   token gates, report full-suite failures by name, desktop/mobile browser flow,
   real host probes, review, controlled deploy, verify current endpoints, commit and
   push to Paperclip-Titan/main. No forced real quota exhaustion.

Each task: write a failing regression, observe its failure, implement the narrow
owner, observe passing tests, then record its verification in this plan.

Ruling: after the shared policy and API contracts were fixed, the independent UI
implementation is delegated under dispatching-parallel-agents. Root owns server,
shared validation and integration; UI worker owns UI and CreateConfigValues only.

## Verification ledger

- Policy/schema: observed invalid configuration/default/credential regressions
  fail, then shared 11 and policy 6 pass. Capacity regression observed fail,
  then provider/instance/Agent capacity suite 11 pass.
- Durable state: restart, per-user routing, positive/negative cadence, both
  providers exhausted, check deduplication, metadata protection and config edits
  pass. Admitted backup executes its actual model with a fresh session and keeps
  immutable adapter/model evidence.
- UI worker: 131 focused tests pass; root integration 118 focused tests pass.
  The broad UI run found two existing IssueDetail sidebar failures (116/118);
  unrelated timeout failures in AgentToolsTab passed on its focused rerun (7/7).
- Full workspace typecheck and build pass; token gates clean. Final focused
  server/shared suites: 128/128; route integration extended to 37/37.
- Final review identified three Important issues. All reproduced RED, then
  fixed GREEN in the 12-test durable suite: fresh clocks for every reservation
  and completion; project authentication precedence; durable primary recovery
  receipt reconciled after continuation failure/restart.
- Final review's mutation audit finding was addressed because repository rules
  require it: manual probe requests and automatic routing transitions are logged.
- Ruling: local routines with unbound runtime-specific credentials and task
  adapter/execution-policy overrides fail closed during primary checks rather
  than verifying another model/account. Cost: those scopes retain the backup
  until a supported exact-runtime recovery mechanism is added.
- Broad full-suite run, actual browser/model probes and deployment receipts are
  recorded below when complete. Existing `.serena/` remains outside this change.
- Extra regression: changing only recovery cadence or automatic-return controls
  retains the admitted backup. Both reproductions failed, then the policy 7 and
  durable 13 suites passed. Disabled recovery stops checks; a shortened interval
  recalculates the deadline without discarding the quota state.
- Real API/UI receipt: `paperclip-quota-browser-receipt-20261001.json`; desktop
  1440x1050 and mobile 390x844 Save/Discard/persisted controls passed, zero page
  errors. Real host Codex `gpt-6.1-sol` backup hello passed; primary
  `MiniMax-M3.1-Flash-Preview` hello returned available. Temporary test company
  and Agent were deleted. Existing Agents remain disabled/unmodified.
- Deployment: tracked drain, graceful supervisor SIGTERM after identity check,
  supervisor restart and API bootstrap/backup health passed. Existing task run
  states were preserved in a private deployment receipt; queued work resumed.
- Fresh combined affected suites: 133/133; fresh UI suites 120/120. Full workspace
  typecheck/build pass. SQL-null metadata clearing regression reproduced and
  corrected while retaining protected server state.
- Baseline comparison: an archived copy of original commit `8c8dcc0a7` reproduced
  the responsible-user dependency-wake cancellation assertion and all seven
  Claude/Codex execute-suite failures (43/50 passed). These failures predate quota
  fallback. Broad regression has additional failures; it is not a green gate.
