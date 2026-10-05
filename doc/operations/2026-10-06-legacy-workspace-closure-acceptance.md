# Legacy workspace closure delivery — 2026-10-06

Paperclip owns the upgrade/physical-write closure; Polaris owns POL-6 planner repair after real maintenance acceptance. Source stays in each original checkout, with no branch, worktree or source copies created. [Governance and exact commands](2026-10-06-legacy-workspace-upgrade-governance.md), [POL-6 continuation scope](2026-10-06-pol6-after-workspace-closure-handoff.md).

## Implemented

The local `workspace-legacy-closure.ts` entry supports read-only inspect, exact-digest preparation of an audited hold, and separately audited `host_boot_epoch_closed` closure. Caller boot/namespace inputs, agent contexts, external database overrides, wrong selected instance, same boot, wrong generation and source/run/lease/ledger drift are rejected. Closure and release commit under the same physical realm transaction lock; old runs, leases and events are not rewritten or deleted. It creates no namespace receipt and dispatches no business work.

The host witness compares kernel facts read by the actual connected PostgreSQL backend with caller-visible backend/postmaster PID, parent/start ticks, UID, PID/mount namespaces, cwd/executable and boot. Stable cluster/database/dataDir identity and original physical source are bound across the maintenance operation. No client-provided actor claim supplies this authority.

Ordinary tracking is no longer run-ID membership: live observations require matching physical source; protected heartbeat payloads bind the expected agent and real stored process metadata. Genuine committed namespace drain remains durable across boots. Old guarded rows lacking the new stamp use exact latest trusted process-identity/controller/namespace linkage in the original guard interval; group-stop-only records do not qualify. New conflicting identity events invalidate both old and new linkage.

## Verified scope

- Three modeled historical-epoch scenarios: old success, timeout, and an actually writing escaped child. Same-boot closure refuses. After modeled historical boot closure, actual guarded writes, public HTTP Stop, kernel namespace drain, explicit second heartbeat wakeup/execution on the same source path, and second public Stop all pass.
- Core/CLI/existing physical-owner suite: 28/28. Public HTTP cancellation suite: 9/9 (309 unrelated name-filtered tests in that directed run).
- Independent security review: no remaining blocking findings. This is engineering/source clearance, not an assertion that WSL restarted.
- Complete official test coverage: 677 ordinary server files, 148 serialized files, complementary chat partitions covering all 995 tests, UI/CLI and all twelve workspace projects. Initial failed group invocations remain failed in their original manifests. Whole-suite/project reruns and the one serialized gap complete the coverage; this is not a single monolithic `pnpm test:run` exit-zero claim.
- Preserved failures: initial long TMPDIR prevented tsx IPC before tests; one DB hook timeout; CLI guidance scanner entered unrelated preserved worktrees; routine and CodeMirror scan timeouts; DB workspace timeout/initialization failures. Corrected orchestration uses short private roots, an original-checkout-only temporary mount for guidance scanning, and quiet complete reruns. No timeouts, assertions, dependency versions, product guards or test skips were weakened.
- Default service remained healthy on loaded implementation 909e9ac55 during checks. Config bytes and POL-6 status/scope stayed unchanged. Read-only live inspect identifies exactly two old Polaris executions and the original source identity. No live prepare/close or task replay has occurred yet.

## Outstanding real maintenance

Real host boot change, persisted default-instance closure, and actual Polaris original-directory production admission remain unverified until a separately approved WSL maintenance window. `wsl --shutdown` affects all running WSL distributions and the WSL2 VM, including other services and agent sessions. A Paperclip-only restart does not supply this proof. Do not report the live `workspace_busy` incident resolved before the genuine closure/admission evidence is complete.

After real Paperclip acceptance, the Polaris team resumes the exact remaining unique-export planner routing/materialization scope in POL-6, preserving previously validated diagnostic files and checkpoints. No implicit model/provider replay is part of this delivery.

Compact evidence is under `doc/operations/evidence/2026-10-06-legacy-workspace-closure`. Protected original logs, full command manifests, failure attempts and readonly runtime snapshots stay registered at `/home/dains/.paperclip/diagnostics/workspace-busy-20261006/implementation`. Final full artifact gates, commit and runtime-loaded version will be recorded after they complete.

Final required artifact gates returned zero: `pnpm -r typecheck`, production `pnpm build`, and `pnpm check:token-gates`. Frozen implementation bytes still match the reviewed source. Build completed before the code commit, so its compiled server stamp names base 4e710a604; the managed deployment uses source CLI/server and must verify its loaded new commit separately.
