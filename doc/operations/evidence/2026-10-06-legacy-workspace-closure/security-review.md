# Legacy workspace closure implementation security review

Date: 2026-10-06. Independent read-only reviewer. Base: `4e710a6047ea00d0091d5736ce0dbcced923a52e`; reviewed working-tree implementation and new files. Root owns all source changes. This reviewer ran no tests, model calls, live mutations, signals or restarts.

## Disposition

**Final source review: no remaining blocking security findings in the frozen implementation.** All first-pass P1/P2 findings and the V1 latest-event finding are resolved. The 10 reviewed source/test files match `implementation/source-freeze.json` by SHA-256. Boot-epoch simulation is explicitly identified; no real WSL restart or live migration acceptance has occurred. This is implementation security clearance, not deployment, shutdown or business-replay authorization.

## First-pass findings

1. **P1 — Tracked provenance ignores the candidate's physical source.** `server/src/services/workspace-write-ownership.ts:118` and `legacy-workspace-closure.ts:92` call `workspaceRunHasTrackedOwner` before resolving current lease/snapshot cwd. `workspace-owner-provenance.ts:19` accepts an active unprotected observation by company/run alone; protected binding also contains no source identity. If run R has an owner observed at A, and its execution workspace changes to B or it acquires a B lease, a B claim has no A-owner conflict and skips R without examining B. This can admit another writer beside an unprotected/native lifetime and hides source drift from closure capture. Resolve each candidate's current physical source first and accept tracked provenance only when an authentic owner holds that same resource; retain uncertainty/busy otherwise. Cover unprotected/native and protected metadata drift with A/B cases.

2. **P1 — Real reboot invalidates existing protected release authority.** `workspace-owner-provenance.ts:26-28` requires a new `workspaceNamespaceDrained(identity)` scan for released protected owners. The primitive in `packages/adapter-utils/src/workspace-process-guard.ts:47` returns false after the real kernel boot ID changes. Before reboot those safely released runs are skipped by `cohort`; after reboot they become untracked legacy candidates with no epoch closure record, and their old namespace identity cannot be prepared against the new boot. The maintenance operation can therefore strand previously drained protected lifetimes after the very reboot it requires. Preserve narrowly validated durable server-issued drain/release authority across boots, or explicitly include these lifetimes in a safe migration path. Do not weaken ordinary Stop's current-kernel proof. Test this separately from the host-facts-only boot mock.

3. **P2 — Existing protected rows cannot satisfy the newly required binding event.** `workspace-owner-provenance.ts:22-24` requires `run_process_bound`, but base-HEAD protected rows were released with `payload_bound`/`namespace_drained`/`released` and no new event. Genuine pre-upgrade drain receipts now block admission. A planned reboot can close those legacy runs only if the maintenance cohort includes them before reboot; that compatibility requirement needs an explicit supported path and regression fixture. An upgrade must not silently manufacture the missing event or assume old row membership proves drain.

## Reviewed strengths

- Maintenance runId is random and maintenance markers are excluded from generic tracked provenance.
- Prepare binds canonical source and whole run/lease/event digests; Dates normalize before canonical sorted-key hashing, so JSONB key order does not alter authority.
- Run `FOR SHARE` prevents the normal event allocator's run-row update/append from racing captured ledger reads. Closure and admission use the same realm advisory lock; close appends proof and releases hold in one transaction with a generation/state CAS.
- Actual connected PostgreSQL transaction supplies backend/postmaster process and boot facts; caller-visible PID/start/parent/UID/namespaces/cwd/executable witnesses are checked. Cluster ID, database and dataDir device/inode are stable binding; operation-only backend identity is excluded from inspection digest.
- Strict prepare/close schemas, exact owner/generation/source/company binding, two-event closure history and whole captured-cohort revalidation reject stale/unknown proof. No old heartbeat/lease/process mutation, automatic wake/retry or namespace receipt synthesis is implemented.
- Expected-agent payload binding preserves heartbeat attribution; standalone guarded jobs retain no fabricated heartbeat metadata.

## First-pass evidence limits (updated below)

- `legacy-workspace-closure.test.ts:41-43` mocks only the host-facts function to model an older boot. Three scenarios exercise real guarded subprocesses and namespace drain; they do not prove a real host boot transition.
- Those migration scenarios use `AbortController` and `ownership.confirmStopped` (`:144`, `:148`), not the public HTTP Stop route. Public-route cancellation after migrated admission remains separate acceptance work.
- Reviewed test source covers concurrent prepare, stale inspection, run/ledger drift, generation/company/source mismatch, maintenance-marker bypass and cohort drift. It does not yet demonstrate the A/B tracked-source drift or protected-release boot/upgrade regressions above. No new foreign DB/sandbox witness negative test appears in the reviewed files.
- Final typecheck rerun was pending when the diff was sent. Broad suite/build and real restart evidence cannot be inferred from targeted passes.

No WSL restart, live prepare/close, business replay or deployment is authorized by this review. Re-review the root's fixes before final disposition.

## Re-review of provenance fixes

- P1 source drift is resolved: claim and cohort resolve candidate source before bypass; provenance requires exact canonical root, device/inode, realm and resource key. An absent original directory can bypass only with durable verified release and unchanged lexical original path. Active/native unknown lifetimes cannot use that fallback.
- P1 reboot invalidation is resolved: released protected authority uses an already committed matching namespace-drain/release journal and receipt without re-running current-boot drain. Ordinary Stop still performs the real current-kernel observation. A regression verifies that unavailable current drain does not invalidate the prior release.
- P2 pre-upgrade compatibility now has a read-only fallback: genuine old physical drain/release plus a trusted system process-identity event matching PID/group/start and old observer namespace fingerprint within the launch-bound to payload-bound/drain interval. No new binding event is invented and group-stop is not accepted as physical drain.

### Previously remaining important finding (resolved)

**P2 — V1 fallback must reject a newer conflicting process-identity event.** `workspace-owner-provenance.ts:priorGuardBinding` queries all trusted identity events and uses `events.some(...)`; it also omits `controllerBootId` from the current-run comparison. An old matching event therefore remains authoritative after a newer event changes local/remote namespace or controller provenance while the PID/group/start tuple remains unchanged. Select the latest trusted system `legacy.process_identity_recorded` event by sequence, require its controllerBootId to equal the current run, and apply all existing source/namespace/process/window constraints to that event only. Add a newer conflicting identity-event negative fixture. This enforces ledger drift and reopening refusal without editing history or synthesizing a receipt.

### Updated evidence scope

The public HTTP cancellation test now contains three migrated success/timeout/escaped-child variants using modeled boot transition, real same-directory subprocesses, real SIGINT and namespace drain. At review time that suite was running; second-dispatch extension was pending. Its completion is not claimed here. The direct host-layer controls remain useful but do not establish a real kernel restart. No new blocking issue was found in JSON canonicalization or the locked PostgreSQL host witness during this re-review.

## Final review disposition and verified evidence

The V1/latest-event finding is resolved. `priorGuardBinding` now selects the latest trusted system process-identity event by descending sequence, matches current controllerBootId/PID/group/start and captured observer namespace fingerprint, and applies the launch-bound to payload-bound/drain timestamp window to V1 rows. New stamped rows also reject a newer conflicting identity event. The negative fixture verifies both V1 and stamped provenance fail when the latest event changes localProcess to false; durable exact namespace proof still does not call the current-boot drain primitive.

Reviewed the public HTTP second-dispatch extension: every migrated historical variant creates an explicit issue comment, calls the real heartbeat wakeup/resume path, obtains a new run ID, verifies the same canonical source root and active owner, calls public `/api/heartbeat-runs/:id/cancel`, and checks actual namespace drain and final released state. This is explicit fixture dispatch, not automatic migration replay. The existing six public-route cancellation controls remain included.

Read-only verification by this reviewer:

- SHA-256 verification of `source-freeze.json`: 10 files checked, zero mismatches.
- `implementation/final-core.log`: three files passed; **28/28 tests** passed, including closure, existing physical-owner behavior and CLI contracts.
- `implementation/migrated-http-second.log`: **9 public cancellation variants passed; 309 unrelated tests skipped by name filter**. Migrated success, timeout and escaped-child cases include real second same-directory execution and public Stop.
- Root reports latest direct server TypeScript check passed. That command was not rerun by this reviewer.

No remaining blocking finding was identified in the reviewed source. Approval is bounded to this frozen implementation and the isolated evidence above. Real kernel shutdown/re-entry, persistent default-instance hold/closure, real boot observation, actual original Polaris-directory migration, full repository typecheck/test/build and business restoration are not established by these tests. WSL restart, live prepare/close and POL-2/POL-6 replay remain unperformed and require their separate authorized workflow.
