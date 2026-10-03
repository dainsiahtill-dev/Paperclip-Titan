# Durable steering and truthful execution status

Branch: `fix/delivery-steering-20261004`. Base: `39451d9e9`.
Scope: PC-07 and owned PC-08 leaves. No production service/config/database/provider/agent changes.

## Implementation

- Content-free `issue_comment_deliveries` records company, issue, canonical comment/version/digest, queue revision, run/turn/session generation, exact controller owner, correlation, attempts, trusted activity actor, and dispatch/ACK state. Text and authors remain in `issue_comments`; the existing wake queue owns scheduling.
- ACP and native delivery use short claim and confirmation transactions. Provider send and acknowledgement waits execute outside issue/run/wake locks. Native user instructions keep the identity broker and typed ACK callback. Native Agent/system context quotes the original author without reserving/activating a user identity, preserving the run's responsible user and credentials.
- Native automatic context delivery observes capabilities and rebuilds its exact tool/approval boundary from validated committed native events and the current provider cursor. Source sequence gaps, incomplete cursors, busy tools, unsupported or stale sessions retain the queue with an explicit boundary reason. Attach, committed events and replay only signal the existing scheduler; they never create a second run or infer safety from an empty process map.
- ACP's original send promise remains observed after its eight-second acknowledgement timeout. Late acknowledgement settles the original receipt only. Changed/deleted comments, Stop, reassignment, session generation, replaced turn owner, and expired controller leases fence confirmation.
- Unknown dispatches are preserved and never automatically resent into the same target. A manual conflict commits the unknown receipt before returning its error. Native receipts carry the attached owner's UUID and reject mismatched expected turns.
- One committed completion activity is published after receipt, run ACK, queue, and native identity commit. Duplicate HTTP responses produce no extra completion.
- Retry adoption filters live comments while preserving canonical wake order. `queuedCommentDeliveryUncertainty` carries content-free prior receipt references into legitimate retry context.
- Execution projection uses controller lease/stage, with production legacy freshness checked against `clock_timestamp()`. It never treats numeric PID existence or start time as provider progress. `preparing` and `confirming` distinguish provisioning and missing owner evidence. UI no longer defaults an unprojected running run to Working/Thinking.
- Queued messages remain visible until acknowledgement. Busy, unsupported, unknown and stale errors explain the retained queue and next action. Existing edit/discard/authorized Interrupt controls remain.

## Evidence

All shell commands used RTK and explicit Node24 PATH. Dependency install was offline/frozen/ignore-scripts in this worktree. Migration generation used only `pnpm db:generate`; its generated journal/snapshot/migration and temporary barrel/shared edits are deliberately excluded from worker commits because Root regenerates the combined migration.

RED observations:

- Seven new actual PostgreSQL/service regressions failed on base: locks held during send, lost late eight-second ACK, edited/deleted/Stop/reassigned/replaced owner acknowledgement.
- UI/backend RED: absent projection incorrectly displayed Working/Thinking, preparation counted start time as progress, optimistic disappearance before ACK, generic busy/unsupported/unknown/stale failures.
- Reordered retry RED: adoption restored comment creation order.
- Same-controller lease-expiry RED: ACK completed despite an expired DB lease.
- Manual restart-recovery RED: conflict rollback restored receipt to dispatching instead of committing uncertain.

Verification history (latest results below supersede earlier scope counts):

- `/tmp/steering-green.log`: seven new legacy cases passed, including the real eight-second timeout and late ACK.
- `/tmp/steering-focused-3.log`: six files, 150 passed.
- `/tmp/steering-native.log`: native same-turn group, seven passed; 345 unrelated cases not selected.
- `/tmp/steering-final-focused.log`: eight files, 165 passed. Command used isolated HOME, XDG_CONFIG_HOME, PAPERCLIP_HOME, PAPERCLIP_CONFIG and unset DATABASE_URL; temporary embedded PostgreSQL.
- Server `tsc --noEmit` and UI `tsc -b` passed after building isolated runner TypeScript/plugin declarations. Initial tsc lacked these generated declarations; it was not counted as success.
- UI production build passed; existing chunk-size and dynamic-import warnings remain.
- Token gates: 1021 files scanned; all four gates clean.

After host relief, latest native context/short transaction/error-preservation source passed eight files, **171/171** (`/tmp/steering-commit-focused-2.log`, 104.29s). The native same-turn group passed **8/8**, with 345 unrelated tests unselected (`/tmp/steering-commit-native.log`). Server typecheck and token gates passed. The initial 171-case run exposed lost original error text during repeated unknown reconciliation; the final run includes its correction. The native busy fixture initially contained an invalid channel and a non-wire undefined itemId; these were corrected to actual protocol shape without weakening schema/digest validation. The next fixture attempt exposed a test cleanup racing its own background completion; the test now waits for committed queue cancellation.

Commands use `rtk proxy env -u DATABASE_URL`, explicit Node24 PATH, and `.tmp/qualification-home` / `.tmp/qualification-config` for HOME/XDG/PAPERCLIP configuration. Run Vitest with `/home/dains/.paperclip/runtime/node-v24.21.0/bin/node node_modules/vitest/vitest.mjs run ... --maxWorkers=1 --no-file-parallelism`. Selected files: issue-queued-comments-routes, execution-projection, heartbeat-run-runtime-status, issue-queued-comment-queue, acpx live-steering, TaskChatRunnerTurn, TaskChatQueuedMessages and UI issue-queued-comment-queue. Native selection: `native-session-executor.test.ts -t 'native session same-turn steering'`. Typechecks: `pnpm --filter @paperclipai/server exec tsc --noEmit`, `pnpm --filter @paperclipai/ui exec tsc -b`. UI build: `pnpm --filter @paperclipai/ui build`. Tokens: `pnpm check:token-gates`.

## Browser evidence and limits

Scratch harness mounts the actual production TaskChatRunnerTurn/TaskChatQueuedMessages and token stylesheet on an isolated random localhost Vite port. DOM checks confirmed confirming, queued, preparing, working/tool busy, original message and queue controls. Desktop measured 1280x800, document width 1280, expected queue button rectangle.

Linux Chromium1228, matching headless-shell, and cached Chromium1200 failed a plain `<h1>` screenshot control. Protocol trace proved fonts/layout returned and `Page.captureScreenshot` never replied. The existing deadlines were not raised. Host memory pressure was recorded; after relief Linux capture still failed. Windows Edge **154.0.4258.53** with a unique empty profile and ephemeral loopback debug port passed the control and actual production-component desktop1280x800/mobile390x844 flows. Queue/preparing/confirming/tool busy, pending ACK row retention, delayed ACK removal, unknown/unsupported natural boundary, manual Stop and run end all passed; no page errors or horizontal overflow. Screenshots were personally reviewed. These are component flows with controlled acknowledgements, supplemented by real DB/routes; full integrated app/provider acceptance remains Root's gate.

All three owned Windows profiles were scoped by exact unique path, fresh process metadata/CIM ownership, then closed. Initial failed fixed-port profile `MJ6Fcr` has teardown Before8/After0; successful control `0Rganl` and flow `pU6XLP` have remaining=[] proofs. No user's existing profile/browser tabs or Windows settings were used or changed.

## Rulings and integration

1. ACP lacks durable protocol idempotency: unknown external effect stays uncertain, not exactly-once. Preserving an unknown requirement at a legitimate successor requires an explicit uncertainty note and no blind tool replay.
2. A changed version after a previous dispatch does not gain permission for another injection in that same run. The changed comment remains canonical for a natural successor. Cost: a newly edited handoff may wait for that boundary.
3. Confirming ownership is diagnostic only; it neither terminates a quiet long task nor grants execution authority.
4. Root owns shared phases/barrel exports and migration integration; worker commits contain schema leaf only. Root also owns ordinary successor prompt notes, version-aware activity placement/deduplication, and overall browser acceptance.
5. Root subsequently transferred H-08 ordinary comment commit-to-wake reproduction and conditional narrow outbox work. It is the next extension after this verified source checkpoint; it is not claimed fixed by the initial steering commit.

Export for Root: `commentDeliveryUncertaintyForComments(db, { companyId: string, issueId: string, commentIds: readonly string[] })` returns live canonical comment-scoped content-free `{commentId, deliveryId, targetRunId, targetTurnId, correlationId, payloadSha256, status}` references. Retry context already uses this helper. Root should call it for ordinary adoption/prompt construction, preserve author and queue order, and explain prior target uncertainty.

Full repository suite/build/typecheck and real-provider qualification were not run in this worker. Root owns final integration, source freeze and acceptance. Self-review follows the code-reviewer checklist; no reviewer subagent was spawned as explicitly instructed.
