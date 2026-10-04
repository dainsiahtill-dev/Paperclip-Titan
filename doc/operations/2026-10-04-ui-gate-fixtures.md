# UI gate fixture verification — 2026-10-04

Scope: eight UI test files on `3ba9e742de3b775cebbd60e3f24e667fb2699609`, in the isolated `delivery-ui-gates-20261004` worktree. Production UI/server behavior, admission rules, navigation, locale, timeouts, token allowlist, and provider configuration were unchanged.

## Baseline and causes

The parent broad UI/CLI run reported 612 files, 6,400 tests, 16 failed tests, and one unhandled `NotFoundError`. The isolated owned eight-file baseline reproduced 14 failures out of 405 tests in 40.70 seconds. Unmodified AgentTools passed that baseline and a separate cold seven-test run in 4.94 seconds.

| Fixture | Proven discrepancy | Correction |
| --- | --- | --- |
| liveIssueIds, SidebarAgents, live pill, continuation thread | Positive physical activity used database `running` without the required execution projection | Seed `working` only in the intended physically active cases. The live-ID negative case additionally includes unknown, preparing, and confirming. |
| Sidebar | Expected Org navigation omitted the already shipped Pixel office item | Assert the current exact navigation order. |
| IssueProperties | Monitor-clear expectation omitted explicit `monitor: null` | Assert clear with resources, delivery policy, and authorization policy preserved. |
| IssueDetail planning | Stubbed `getDocument`; current shared hook selects a plan from `listDocuments` | Stub the actual list endpoint; empty list remains the default. |
| IssueDetail pause | New delivery-assessment request fell through to an unrelated preview fetch stub | Stub the ordinary assessment: empty criteria, completion allowed, null contract IDs/hash. |
| IssueDetail steering | Submitted comment lacked the current content digest, so the strict local receipt check correctly refused promotion | Generate the DTO digest using the pure server canonical helper over current raw body, authorship, and exact updated version. Durable activity binds the same delivery ID, version, and hash. |
| AgentTools | Broad first tests awaited cold module import inside the five-second test body; late continuation could reuse shared roots/containers after teardown | Import the same module during collection with the same hoisted mocks. Reset the root and QueryClient per test, then unmount/clear them on teardown. No timeout increase. |

The AgentTools broad timeout was not reproducible in the narrow baseline. The broad log points to cold transform/import contention and contains the late teardown exception; the fixture removes that asynchronous import/root ownership boundary. Confirmation under the combined broad run remains the parent's integration gate.

## Current verification

All commands ran through RTK with Node 24.13.0 and the explicit installed pnpm path. Test commands unset external database URLs and Anthropic/OpenAI API keys, and used `/tmp/paperclip-ui-gates-20261004` for Paperclip home/config. No real provider, default instance, or browser profile was used.

- Full owned eight-file suite: **405/405 passed**, **8/8 files**, **38.95 seconds**, exit 0, no unhandled errors. `/tmp/paperclip-ui-gates-green-20261004.log`.
- UI typecheck: `pnpm --filter @paperclipai/ui typecheck`, exit 0. `/tmp/paperclip-ui-gates-types-20261004.log`.
- Token gates: all four gates clean, 1,031 files scanned, existing 33-entry allowlist unchanged. `/tmp/paperclip-ui-gates-tokens-20261004.log`.
- `git diff --check`: exit 0.

The eight suites are `AgentToolsTab`, `SidebarAgents`, `Sidebar`, `liveIssueIds`, `IssueProperties`, `IssueDetail`, `TaskChatLiveRunPill`, and `TaskChatThread`. The full test command is `pnpm exec vitest run --maxWorkers=1 --no-file-parallelism` followed by those eight existing test paths. There are no skipped tests, added retries, or increased validation timeouts.

## Remaining integration evidence

At the first checkpoint, the parent still needed to rerun the full UI/CLI suite after merging the eight-file patch. This worker had not run the broad suite, a production build, or desktop/mobile browser acceptance at that checkpoint. The subsequent broad evidence below replaces that pending test result; it does not establish whole-application delivery.

## CompanySettings follow-up

After integrating the first checkpoint, the parent reran all 612 UI/CLI files: the original owned failures closed, while CompanySettings exposed three form-navigation assertion failures and six unhandled scheduler/query callbacks accessing `window` after environment teardown. Its module import was already static. Its custom `act` merely ran `flushSync`; it did not use React's `act` to flush concurrent navigation. Each root was a test-local variable unmounted only after all assertions succeeded, so failed assertions skipped unmount while `afterEach` removed the DOM. Query clients were never cleared.

The unmodified four-test cold baseline passed in 4.74 seconds; the broad failure remains the RED evidence. The approved fixture fix uses React `act`, owns the root and QueryClient in `beforeEach`, and unconditionally unmounts and clears them in `afterEach` before removing the DOM. All four test names, API mocks, exact Sandbox/SSH ordering, Local edit selection, provider-config preservation assertions, polling count, and default timeouts remain unchanged. Production code was not edited.

Fixed narrow gate: 4/4 passed in 5.05 seconds, no unhandled errors. `/tmp/paperclip-ui-companysettings-green-20261004.log`. The follow-up branch is `fix/delivery-ui-companysettings-20261004`, based on the exact combined Root commit `5626fc93e20d2f75528fad0c59bd4c664121abab`; UI/CLI tracked sources matched the first worker checkpoint. The full UI/CLI source-only verification runs `pnpm exec vitest run --exclude '**/dist/**' --maxWorkers=4 ui/src cli/src` with isolated home/config/instance ID and external database/provider variables unset. Its log is `/tmp/paperclip-ui-cli-companysettings-full-20261004.log`.

Full result on Node 24.13.0: **673 files / 6,879 tests** in **425.32 seconds**, **zero unhandled errors**. All **611 UI files / 6,394 UI tests passed**. Three assertions failed in two CLI files (`doctor`, `install-store`); consequently this run does not establish a green full CLI suite. Exact project metadata discovery with `--project @paperclipai/ui --project paperclipai --json` confirms UI 611/6,394 and CLI 62/485. The parent's earlier 612/6,400 selection was incomplete CLI coverage.

Read-only boundary probes preserve all CLI source and assertions: the intended Node 24.21.0 passes all 13 install-store tests without edits; doctor remains failing because the ambient user-home managed shim is found while the isolated Paperclip home lacks its manifest. The unchanged doctor test passes 1/1 with a fresh HOME applied only to that child process (6.24 seconds). Logs: `/tmp/paperclip-cli-boundary-2421-20261004.log` and `/tmp/paperclip-cli-doctor-isolated-home-20261004.log`. The fixture's explicit install-store home/path seam and the full 485-test CLI gate are a separate approved follow-up.

CompanySettings follow-up UI typecheck, token gates, and `git diff --check` all exit 0. No production build/browser check was repeated by this worker.
