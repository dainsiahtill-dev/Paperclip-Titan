# Maintenance correctness review

Reviewed working-tree diff against HEAD `96a6504a3b8f8b1d7515d3cd850e2a1270fcb17f`, including new namespace closure service/tests. Read-only source review; no tests, services, provider calls, process actions, or database operations performed. CodeGraph unavailable by repository context: no index.

## Assessment

No blocking correctness defect found. Initial closure binds actual local database/host, exact owner/generation/launch/source, terminal run and original event provenance; compares inspection digest, rechecks kernel drain/source, then appends owner history plus activity evidence. Historical runs/events receive no closure writes.

Never-launched retry requires one exact company/run/issue/physical-source owner, formally released without launch identity/receipt or launch journal, and rejects invocation/process events. Pending/failed lease cleanup blocks admission.

Run `FOR SHARE` protects original events against ordinary appenders, which take run `FOR UPDATE`; owner `FOR UPDATE` protects release. No new lock-order cycle found among reviewed claim/closure/legacy paths. Namespace handles close in `finally` after metadata failures; descriptor dev/inode and nsfs checks reject mismatches. Bounded drain retry preserves strict predicate; timeout returns false. Alternatives directory joins existing read-only system mounts.

## Nonblocking findings

- P3 coverage — `server/src/__tests__/workspace-namespace-closure.test.ts:101`: metadata test rejects wrong nsfs type, but does not cover descriptor dev/inode mismatch or handle closure on rejection. Add ordinary mocked mismatch cases and verify each opened handle closes.
- P3 coverage — `packages/adapter-utils/src/workspace-process-guard.test.ts:238`: new drain-wait test covers delayed successful exit only. Add ordinary still-live-at-deadline case asserting false and absence of a drain receipt.
- P3 semantics/coverage — `server/src/services/workspace-namespace-closure.ts:55`: completed-close replay compares saved input digest and provenance, not current historical run/event digest. Thus later non-binding annotations/events do not invalidate replay. This preserves durable receipt idempotence and performs no new release; document/test this behavior. If changed-evidence rejection is intended to apply after completed closure too, persist a separate immutable evidence digest and compare it on replay.

## Verification inspected

- `git diff --check`: clean.
- `host-and-closure-suites.json`: 23 passed, zero failed; namespace 11, legacy closure 12.
- `final-scoped-suites.json`: 163 passed, zero failed, two skipped; retry 103, sandbox 18, guard 16, CLI 2, ownership 17, namespace earlier 9.
- No independent test execution. Parent reports provide test evidence; this review does not claim live qualification or repo-wide completion.

## Declined to judge

- Default-instance deployment, live employee/provider qualification, and actual maintenance execution: reserved to root; explicitly outside this read-only review.
- Adversarial filesystem/environment experiments: explicitly excluded by review assignment; ordinary code paths and existing tests inspected instead.

## Reviewed source SHA256

```json
{
  "packages/adapter-utils/src/local-process-sandbox.ts": "4fc37407511a6e24abb21ca22e036db2374c33a18097c5b077e9d030cd67e2b8",
  "packages/adapter-utils/src/workspace-process-guard.ts": "016f19a8e7353faddb862237575e835a870696c3fddccfef39611ff3725d2995",
  "server/src/__tests__/workspace-namespace-closure.test.ts": "444b7b6a7500f26877a223c45387c18b6339ff5b150823935ed03d457762ff36",
  "server/src/services/execution-retry-disposition.ts": "48a95c8e98400d1f1a44f5b54aae6efa64ab5721116ef7222acc8ce2e4ca4ecd",
  "server/src/services/legacy-workspace-host.ts": "652a7e84504aa87fef65ee25eb8630218a849c501c8f749ae7d8b7e1b429ec98",
  "server/src/services/workspace-namespace-closure.ts": "1f423e01569a67ce7b6b2cc20651f866f21d36c6923fb1e8a7ccd0f4243f6547"
}
```
