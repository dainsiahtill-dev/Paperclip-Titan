# Paperclip review/recovery closure — 2026-10-07

Status: source, live workflow, and complete default repository test inventory accepted after documented repairs/rechecks. The first broad invocation was not green; all initial failures and conditional skips remain recorded.

## Cause and repair

The Mine inbox contained successful file-only implementation runs without a declared report handoff. Legacy Board review transitions could retain the original executor without a reviewer, and recovery checked that executor's budget before recognizing human/pathless review waiting. The latest cancelled queue entry could therefore appear as failure evidence even though it never started; it was not counted as an automatic started run.

The recovery budget now applies to a real typed agent reviewer. Human waiting does not replay the executor. Board status-only creation/reassertion binds a real human owner; explicit stages, monitors, interactions, and operator stops remain governed by existing paths.

The creation form and API validate report paths, local project workspace, working initial status, and an independent eligible reviewer. Shared Codex report tasks receive only a scoped CLI engine override; existing models and sandbox remain. Reassignment validates reviewer and effective workspace before stopping a valid executor, then repeats validation under the update lock. First review uses the candidate state's original producer.

## Delivery

- Source commit: `dfa46bc963a08a6c1c61416556842d2a75f3de55`, directly on main; no new maintenance branch/worktree/source copy. CLI integration tests use their own temporary fixture repositories and instances.
- Remote pull reported up to date; core commit pushed and remote SHA verified.
- Final source follow-up: `9c989ec94` preserves fixed conversation assignment; both authenticated conversation creation and false-positive recovery now pass complete file checks.
- Default loopback service: `2026.916.1+183.git.9c989ec94`; startup recovery ready.
- Thirty-eight employee adapter/runtime configurations unchanged across restart.
- Configuration SHA256: `fcd0598200bd973a4a5fb86e2fb148e809a760d6976db10cd4ef8bdbc32a9eef`.
- Cold backup: `~/.paperclip/backups/recovery-closure-20261007T0148`, manifest SHA256 `aed04d0b3d6e8917bc1f820c83a50811ff0c6b7dbe92e0e38cee3ea3378a824f`; 4,807,083,662 fresh bytes plus 22,479,458,808 bytes of individually verified base archive references. Historical archive bytes were not copied again.
- Scoped hot restarts preserved idle task state and recorded no adopted/lost runs. Before the final one-line source update, a consistent SQL snapshot of the latest governance state was also saved: `~/.paperclip/backups/recovery-closure-20261007-before-chat-fix/paperclip-recovery-closure-20261007-101258.sql.gz`, SHA256 `6ec97eab9e0e118dd0670b55f6d7e142d1e56fcabc9c660695bee5ac3c19f946`; gzip integrity verified.

## Actual task governance

POL-17 and POL-26 retain their task IDs, histories, resource limits and implementation evidence. Original successful runs were checked against exact report run IDs/current hashes/workspace bindings and actual drained namespaces, released owners and leases. Four original reports were manually registered as unapproved workspace-file work products. No historical baseline/seal was invented and no source work was rerun.

POL-17 now belongs to named human review. POL-26's exact active recovery action `82ddfc58-b728-4c93-b28b-d069d22d421b` was officially resolved into named human review. Both have no active recovery and no new runs. POL-6 remains legitimate human review; backlog follow-ups and disabled onboarding wakes remain unchanged. None of these actions approves Polaris source or project delivery.

## Actual qualification

The real creation form created POL-28 with explicit report paths, project, employee and local-board reviewer. Exactly one manual qualification run `09a143da-3f0e-440a-a88d-b6992ac3388f` ran with gpt-6.1-sol/high, sandbox enabled and bounded policy 300 seconds/one automatic run/one no-progress run. The employee wrote two new synthetic reports in the original Polaris report directory and naturally exited.

Independent inspection of the recorded completed command found only instruction reads and exclusive creation/readback of the two declared report files (command exit 0; SHA256 `65e491a73655370faa3fa017407a7d864483a9ca1750c613c2844dcff9c3fde3`). The host observed/sealed output and automatically registered two products into human review. Independent proof found namespace drained, owner released and lease released. Browser click opened the pinned report via content API 200, rendered the report and bounded dialog without page errors. Reports declare source_modified=false and source_accepted=false. The Board recorded a typed approval for this synthetic Paperclip qualification only; POL-28 is done. Employee on-demand wake was restored immediately after admission; timers/models/sandbox stayed unchanged.

Report hashes: MD `526d83458f4fa8cf69e812025b0163b72e9e560ec6224ae04481d2aaf8342411`; JSON `feedb5c975e11ada3f0c1cbc7171792bc8661cf13f10f29487ffe434eed0bdc5`.

## Complete verification

- Full workspace typecheck and build passed; final server recompile/typecheck passed after review fixes.
- UI token gates clean.
- 108 targeted tests passed: budget 4, routes 23, real database report delivery 33, UI/policy/locale 48.
- Independent read-only review: no blocking findings after fixing its concrete reassignment and first-review findings.
- Official stable Vitest inventory split into eleven groups/shards with isolated test configuration. Complete planned coverage: 681 general server files plus 148 serialized files, both UI/CLI halves, and every declared workspace package. Combined final coverage: 1,784 passed files plus 7 conditionally skipped files; 26,095 passed tests plus 77 conditionally skipped tests. The conditional skips were not treated as passes. Initial broad+resumed inventory recorded 26,009 passed tests, 7 failed tests, and 156 skips (79 were skipped because three setup hooks failed). Passing exact-case/complete-file rechecks restored those 79 tests and all 7 failed tests without weakening assertions or timeouts. This is combined coverage, not a claim that one initial command exited green. Initial shard 2 exposed a real conversation/ordinary-review boundary and one missing-member fixture. The conversation boundary was fixed; the fixture now uses a real eligible user and asserts human assignment. Full rechecks: 33 conversation tests and 84 recovery-action tests passed, plus final server compile/typecheck; no assertions or permission rules were weakened. The last serialized shard exposed another fixture that declared Board membership only on its request actor. Its database membership was added, reviewer ownership asserted, all 11 low-trust tests passed, and four unrun route files passed independently. This final change is test-only.
- Initial chat shard: 994/995 passed, one authority test timed out at the original 15s limit; the three-role authority group passed fresh without changing assertions/timeouts.
- Initial server shard 1: 213 files passed, one native workspace finalizer fixture timed out during setup; its complete three-test file passed fresh without changing assertions/timeouts. Initial server shard 3 had two database setup timeouts: the full workspace-service file (66 tests) and Photon channel file (18 tests) passed fresh. UI shard 0 had one 5s retry-card timeout; its test passed fresh at the original limit, and the skipped downstream CLI half was resumed with its original shard filter.
- Browser/task/protected-command proof is separate from repository tests and from Polaris source acceptance.

Private original evidence: `~/.paperclip/diagnostics/recovery-closure-complete-20261007/`; earlier audit, source reports, database histories and source acceptance findings remain retained. Repo report is the requested maintenance deliverable. Governance workflow: `skills/paperclip/SKILL.md` and its API reference. Full initial results, precise remaining-file/package resumes, and nine passing rechecks are indexed in VERIFICATION_AGGREGATE.json. Actual browser acceptance used owned Edge profiles; one asynchronous teardown needed a second exact-profile cleanup, and final proof records no remaining owned processes. Standard browser release/CI suites were not run: this repair did not modify those suites; its actual user-flow acceptance is recorded separately. No Polaris source, full-project, Bench, or settlement acceptance is implied.
