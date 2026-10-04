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

The parent must rerun the full UI/CLI suite after merging these test-only changes. This worker did not rerun all 612 files, a production build, or desktop/mobile browser acceptance. This checkpoint establishes fixture correctness and the owned focused gate; it does not establish whole-application delivery.
