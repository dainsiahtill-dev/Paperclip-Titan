# Deleted workspace epoch closure implementation plan

**Goal:** formally close unavailable-source legacy lifetimes without altering historical runs, then qualify Polaris in its original directory.

**Spec:** [Approved governance boundary](2026-10-07-deleted-workspace-legacy-epoch-governance.md).

**Architecture:** a separate instance-local database record binds immutable old run/lease/event facts to an authenticated local PostgreSQL/kernel observation. Preparation fences the physical ownership realm; only a subsequent authenticated kernel boot transition closes that exact cohort. Existing namespace receipts and existing-source migration remain separate.

**Execution:** direct `main`, isolated test databases and process fixtures. Service and CLI work have disjoint ownership; root integrates the schema and physical admission guard. No source copies or maintenance worktrees. User authorization covers implementation, verification, commit/push and local service update; WSL shutdown requires separate authorization.

## Interfaces and ownership

- Root: `packages/db/src/schema/legacy_workspace_epoch_closures.ts`, schema export/generated migration, `workspace-write-ownership.ts`, integration review and delivery.
- Service: `legacy-workspace-epoch-closure.ts`, its real database regression tests. Export `legacyWorkspaceEpochClosureService(db, {databaseDirectory?})` with `inspect()`, `prepare({expectedDigest})`, `status({id,generation})`, `close({id,generation,expectedDigest})`; export `legacyWorkspaceEpochClosedRunIds(tx, realm): Promise<Set<string>>`.
- CLI: a separate `scripts/workspace-legacy-epoch-closure.ts` using the same private local operator/config checks as existing maintenance. No caller-supplied boot proof; no process signals or automatic reboot.

## Tasks

- [ ] Add failing integration tests for deleted source roots and absent old namespace evidence; show current guard rejects unrelated original-root admission.
- [ ] Generate the additive closure table migration. Fields: ID/generation/realm/state/digest/immutable manifest/closure proof/timestamps; one open record per realm, no cascading entity foreign keys.
- [ ] Implement authenticated inspection and digest-matched preparation. Keep run, lease, source-pointer and complete event hashes. Reject live owners/services and nonterminal unknown local executions. Write company-scoped audit summaries for each affected company.
- [ ] Enforce the prepared fence inside the existing realm advisory lock for all physical claims and service observations. Only validated closed cohort IDs can be discounted by the old-local-run admission scan.
- [ ] Implement close with unchanged instance and history, changed kernel boot, exact ID/generation/digest and idempotence. Never synthesize namespace proof, source inodes, old run status or effect acceptance.
- [ ] Add CLI help/argument/read-only/mutation tests using a private isolated instance, including refusal of supplied boot IDs and external database overrides.
- [ ] Verify successful legacy run, timeout and retained live child scenarios. After modeled closure, use real protected writing, actual Stop/drain and a second dispatch. Mark modeled epoch evidence separately from real host acceptance.
- [ ] Review negative cases: renamed/replaced/symlinked roots, missing events, another company, reused PID, DB/UID/realm drift, changed lease/event/run, new cohort and duplicate prepare/close.
- [ ] Run scoped tests, repository checks and independent review; backup, deploy at idle, run read-only live inspection and register exact immutable evidence.
- [ ] If real host transition remains necessary, prepare inspectable capture and affected-workload handoff before requesting WSL authorization. After formal close, qualify original-root Polaris tool/output/Stop/second dispatch and continue pending authorized work.

## Review focus

The prepared fence must cover service launches as well as employee claims. Admission must not trust display activity logs, a run ID alone, caller host data, terminal status, vanished PIDs or unrelated closed records. A replaced source after closure cannot resurrect a stopped writer; changed historical source pointers must invalidate proof. Tests may model the old boot but cannot be reported as a real WSL restart or Polaris delivery.
