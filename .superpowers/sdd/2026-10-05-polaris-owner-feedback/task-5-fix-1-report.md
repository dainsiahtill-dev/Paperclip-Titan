# Task 5 Fix 1

Base: `9974fcfd9e111ee7ff5b30eee71b42564ddfefa2`.
Worktree: `/home/dains/Documents/paperclip/.claude/worktrees/polaris-feedback-20261005`.
Scope: the three findings in `task-5-review.md` and the eight runtime regressions reported by root. Original report, review, root ledger/plan and RED logs are retained.

## Fixes

1. Protected admission reconciles durable `workspace_runtime_services` under its existing realm lock. Board/no-run and logically stopped records are included. Canonical actual cwd and known declared workspace roots become durable service observations before admission; an unresolved root produces a retained realm-wide hazard. An existing protected owner is not overwritten: a separate historical hazard survives deletion of the old service row.
2. Added the host-only `observeService({ cwd, workspaceCwd, companyId, serviceId, serviceKey })` API. New service cwd must resolve inside its selected workspace; absolute/`../`/symlink escapes fail before spawn with an actionable `workspace_write_service_cwd_outside_workspace` error. Both actual cwd and the selected source root are retained. Spawn, healthy registry adoption, in-memory reuse and startup reconciliation all observe before their successful return/effect boundary.
3. Service-only `UNPROTECTED_SERVICE` cohorts permit already-authorized retries, adoption and multiple services to append exact members without releasing/replacing earlier observations. A protected/reserved/launching/active/unknown writer or ordinary native/stdio observation cannot be joined through this API. Cohort membership is not writer protection and never establishes drain. Source-writer/native/stdio admission semantics remain separate.
4. Protected heartbeat onSpawn now requires a matching returned running run/company/agent/PID/process-group binding. Null/zero-row persistence throws before ACK, stops the contained process and retains unknown ownership. The shared persistence helper and unprotected/native caller behavior remain unchanged.

The eight regressions were self-conflicts: Board service retries used new runtime UUIDs with no issue/run identity; the earlier generic observer treated its own prior uncertain service row as a different writer. The service-only cohort restores the existing authorized lifecycle while retaining exclusion against protected writers. No TTL, parent-only release, assertion removal, skip, timeout inflation or 409 expectation substitution was used for those existing cases.

## RED and intermediate evidence

- `/tmp/paperclip-task5-fix1-old-service-red.log`: a real delayed Board service with a persisted pre-PC06 row and no heartbeat/environment lease was incorrectly followed by `outcome: claimed` for its alias. Final regression verifies the old service's actual sentinel and rejects the protected successor even after logical stop/parent exit; a disjoint root is admitted.
- `/tmp/paperclip-task5-fix1-zero-row-red2.log`: a private PostgreSQL `BEFORE UPDATE` trigger returns NULL only for initial process metadata, causing a genuine zero-row `UPDATE RETURNING` without throwing. Before the fix, contained provider argv wrote `unsafe`; after the fix it cannot write and owner remains unknown. The earlier deletion attempt hit a foreign-key error, so `/tmp/paperclip-task5-fix1-zero-row-red.log` is explicitly **not** counted as valid zero-row coverage.
- Root baseline `.superpowers/sdd/2026-10-05-polaris-owner-feedback/root-task-5-accept.log`: 251 passed / 8 failed at base 9974. Preserved unchanged.
- First runtime rerun `/tmp/paperclip-task5-fix1-runtime-whole.log`: original eight all GREEN, 165/166 overall. Only the newly added Board adoption fixture failed its same-PID assertion: inline `node -e` quoting did not satisfy the established process matcher. The fixture now uses an actual script file and the existing supervisor-exit → startup-reconcile → reuse flow. No production matching rule was weakened. `/tmp/paperclip-task5-fix1-adoption2.log` verifies same PID, same port and exactly one startup sentinel.
- A new unknown-root deletion regression caught loss of a historical observation when another protected root already existed. Separate historical hazard tombstones fixed that without admitting a service into the protected lane. `/tmp/paperclip-task5-fix1-physical-final.log`: 13/13 passed.
- An intermediate missing object-method delimiter caused import/typecheck failures and was corrected before behavioral verification. Those syntax failures are not counted as behavioral RED.

## Final verification

Commands run from the worktree. Every check uses the private wrapper:

`rtk proxy python3 .superpowers/sdd/2026-10-05-polaris-owner-feedback/run-isolated-check.py`

| Suffix | Result |
| --- | --- |
| `--bwrap exec vitest run server/src/__tests__/workspace-runtime.test.ts server/src/__tests__/workspace-write-ownership.test.ts server/src/__tests__/heartbeat-workspace-busy.test.ts server/src/__tests__/tool-gateway.test.ts packages/adapter-utils/src/workspace-process-guard.test.ts packages/adapters/codex-local/src/server/workspace-guard.integration.test.ts` | Exit 0: 6 files, 265/265 passed, no skips; 334.99 seconds; `/tmp/paperclip-task5-fix1-final-six.log` |
| `exec tsc -p server/tsconfig.json --noEmit` | Exit 0; `/tmp/paperclip-task5-fix1-final-types.log` |
| `--filter @paperclipai/db check:migrations` | Exit 0; `/tmp/paperclip-task5-fix1-migrations.log`; no schema/migration changed in Fix 1 |
| `git diff --check` | Exit 0 |

Original eight assertions retained: foreign HTTPS companion listener rejection; distinct sibling ports; long readiness transaction release; stopped workspace port reuse; bounded bind-race retry; occupied port with unknown listener ownership; same-company conflict reporting; and same-port request-logging service adoption.

Final file counts: workspace-runtime 166, physical ownership 13, heartbeat workspace-busy 17, gateway 63, process guard 5, actual Codex CLI fixture 1. All passed at final source. No new necessary blocker remains within Fix 1.

All fixture processes/directories/databases are private. Runtime fixtures stop through their owned runtime cleanup; standalone delayed children are awaited. SQL triggers and private fixture rows are cleaned up. No live/default3100 API/DB/service, provider/model, production auth/config, install/upgrade, or Polaris operation occurred. No full monorepo/browser/provider qualification is claimed.

## Interfaces and remaining limits

- Task 6's existing claim/guard/drain and `runWorkspaceJobForControl` interfaces are unchanged. Its authenticated job/run binding and read-only/immutable source interval remain separate required work; the current guard still forces writable workspace access.
- Service cohorts are internal observation records, not a new permission or acceptance protocol. Existing service authorization/port/readiness controls still govern operations. Root histories retain each member and uncertainty across logical stop, controller expiry and parent disappearance.
- Unknown historical roots can conservatively block the whole supported single-instance Linux realm; no automatic force-clear/reclaim path was added. Native/stdio uncertain lifetime semantics are unchanged.
- New services configured outside their selected canonical workspace are unsupported and fail before effect. Choose the actual workspace or an in-workspace cwd; config is preserved rather than rewritten.
- The bounded guarantee remains managed declared-root exclusion within one instance/DB/host realm. General arbitrary-path behavior of uncontained services, remote hosts, filesystem rollback and per-file fencing are not claimed.
- Root owns independent review and final project delivery acceptance.
