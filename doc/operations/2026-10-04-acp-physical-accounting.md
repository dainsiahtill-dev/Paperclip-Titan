# ACP physical usage accounting repair — 2026-10-04

Base: `b0cfcf418b4dcab618d1393bb0968017ef6c7c2c`. Isolated branch/worktree: `fix/delivery-acp-accounting-20261004`, `delivery-acp-accounting-20261004`. This repair follows a failed actual qualification; local fixtures do not replace a new real qualification.

## Reproduced cause

Codex ACP 1.6.2 retains `params.tokenUsage.total` but emits `lastTokenUsage.totalTokens` as usage_update.used and supplies lastTokenUsage in standard PromptResponse.usage. The Paperclip ACP engine treated these latest-window/physical-request breakdowns as complete per-run usage. Its thrown-turn failure path discarded already observed usage.

Root's private exact-session evidence reports Engineer cumulative 395,146 tokens versus last-window 79,301, CEO cumulative 482,458 versus 62,077, and CTO cumulative 361,643 versus 55,468. These are Root-provided evidence, not new paid invocations or new live DB settlement by this worker. Existing succeeded statuses and interrupted uncertainty are preserved; an audited historical reconciliation remains Root-owned.

A real ACP stdio regression reproduced two physical 80-token requests under one logical prompt: existing code returned total80 rather than160. RED: `/tmp/paperclip-acp-physical-red-20261004.log`, one assertion failure,4.23s. Input/cache arithmetic was also incorrect for this window interpretation.

## Resulting contract and live call path

The Codex ACP patch preserves standard used/size and PromptResponse.usage semantics. It additionally emits versioned paperclipUsage metadata from the raw provider session cumulative counters, actual provider session/turn IDs, and the effective company/agent/task/run/cwd/model scope. Raw input already includes cache. The engine subtracts the actual baseline and counts cached input exactly once.

The engine observes correlated ACP JSON-RPC frames. A fresh zero baseline requires an actual correlated session/new response. A resumed session captures an exact, owned session baseline before session/prompt from an explicit managed CODEX_HOME; default homes, ambiguous session files, symlinks, changed file generation/owner, mismatched session/cwd/model/writer markers, malformed counters, and regressions fail closed. The reader returns session/scope/file hashes and identity for read-only evidence extraction. It does not create acceptance or billing receipts.

Completion requires both the matching counter-bearing typed prompt reply and the runtime's validated completed terminal. Repeated/out-of-order/wrong-session/wrong-writer/stale window data cannot establish complete usage. Abort/thrown paths retain known observed counts in forensic metadata with usageUnknown=true; they do not mint a settled total or clear an unknown admission hold.

Claude ACP 0.73 has a different capability: primary source resets its user-turn accumulator and returns its complete prompt aggregate via typed PromptResponse.usage. The engine retains that capability only with a correlated reply, known producer identity/version, and coherent cache/input/output arithmetic. Claude usage_update windows remain unqualified. Existing native driver per-turn accounting is unchanged.

AdapterExecutionContext.onUsage is an optional typed callback carrying observedTotalTokens separately from settled UsageSummary, observedUsage, usageUnknown, and usageAccounting v1 provenance. Qualified lower bounds are deduplicated and persisted before any control stop; completed evidence can update the same high-water count's completeness. The callback never waits for its own cancel/ACK/drain. Root's heartbeat worker owns persistence and cap enforcement; partial settled total remains absent/unknown.

Only acpx0.12 needs additional raw-message callback forwarding; acpx0.13 already has it and remains unchanged. Both changed package patches retain all previous scope/privacy/steering fixes. Patch generation initially used a Git subdirectory that skipped reverse hunks; the suspicious shrinking diff was detected before handoff. Regeneration from HEAD originals outside Git corrected it, and both patches pass git apply --check against genuinely unpatched cached originals. Own dependency test changes use copied files and atomic rename, avoiding shared pnpm-store hardlink mutation.

## Current verification and remaining integration

- Owned complete engine suite:27 files,422/422 PASS,96.09s, existing timeouts, no skips/unhandled. `/tmp/paperclip-acp-accounting-engine-full-20261004.log`.
- Real stdio6/6 PASS:80+80 cumulative totals, duplicate windows, cap150 lower-bound checkpoint before cancellation with the scoped process still alive, incomplete cancellation unknown, thrown failure retaining observed counts, wrong-session/window-only negatives, and an actual resumed prompt excluding its file baseline. `/tmp/paperclip-acp-accounting-stdio-current-20261004.log`.
- Adapter-utils typecheck PASS. `/tmp/paperclip-acp-accounting-types-current-20261004.log`.
- Patch application/whitespace checks PASS; no lockfile edits, new skipped tests, timeout/cap/model changes, live provider calls, application/default DB or service mutations.

Root must serially regenerate pnpm patch hashes/lockfile and export AdapterUsageObservation from the adapter-utils barrel, then verify a fresh frozen install and combined heartbeat/native/packaging gates. This worker has not performed new real provider qualification, historical usage settlement, whole-repository builds/tests, or application acceptance. Existing actual qualification remains failed and its evidence stays intact.

Post-checkpoint self-review reproduced a typed-reply boundary edge: reply160 followed by a later scoped240 update incorrectly certified240 as complete. RED is `/tmp/paperclip-acp-accounting-late-boundary-red-20261004.log`. The follow-up preserves240 as an authoritative observed lower bound but clears the older completion boundary, retaining partial/unknown status. The focused accounting/realstdio group passes21/21; patch hashes and public callback contracts are unchanged. Integration lock/barrel commit is Root-owned `ba5e507341c91e35a09d288f9f119206b1d2d055`; fresh frozen installation verification follows separately.
