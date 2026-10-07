# Report seal and CI portability review fixes — 2026-10-07

Status: two review fixes implemented and deployed; complete combined regression inventory verified after isolated rechecks. Live employee/browser report acceptance is blocked and is not claimed.

## Review findings and changes

P1 reproduced with a PATH containing Node/Git but no RTK: both added recovery fixtures failed spawnSync rtk ENOENT. They now invoke native Git directly. The complete heartbeat-process-recovery file passed 329 tests under the same no-RTK PATH. Local maintenance shell commands still follow the user's RTK convention; the test suite does not require it.

P2 reproduced in an isolated real database with the valid bare filename REPORT.v1.md. Existing logActivity correctly redacted its JWT-shaped string, but the old verifier compared that display value to the original filename and blocked submission. New version 2 seals record a canonical SHA256 digest of the original path, state, file SHA256, byte size and non-empty flag before logging. Submission checks that digest plus existing company/run/contract/workspace/finalization/namespace conditions. Display output remains redacted; no redaction exemption was added.

Only exact intact version 1 seals remain compatible. Corrupted old display logs are not reconstructed from current files and cannot bypass a version 2 digest. Regression coverage includes normal adverse-source reports, legal version filenames, post-seal changes, invalid digests, intact/damaged legacy seals and forged provider-result markers.

## Verification

- RED evidence: missing RTK fixture calls; REPORT.v1.md submission; fake v2 digest previously admitted by raw-output fallback.
- GREEN evidence: no-RTK full heartbeat process recovery 329 tests; report/recovery/native domain 44 tests (37 report delivery, 4 review-budget, 3 native finalizer); current-user redaction 24 tests.
- Server typecheck, complete `pnpm -r typecheck` (35 projects) and full build passed. One initial build used the intentionally restricted CI-test PATH and lacked Cargo; restoring the pre-existing Rust toolchain PATH made the full build pass without product changes or installing dependencies.
- Independent source review: no blocking findings.
- Complete configured Vitest inventory: 1,784 passing files and 7 conditional skipped files; 26,099 passing cases and 77 conditional skipped cases. All 15 planned groups, the exact downstream serialized/package/CLI continuations and ten whole-file rechecks were verified. The four chat source-line shards collectively ran all 995 cases; their 2,985 filter exclusions are not conditional skips.
- This is combined coverage, not a claim that the first command passed. CPU contention caused original setup/test timeouts, including two initial rechecks; passing final isolated whole-file rechecks retained the original limits. CLI import setup used a task-local link to the already installed pnpm instead of downloading through Corepack. Initial logs and all continuation plans/results remain inspectable; no assertion/time-limit weakening.

## Delivery and preserved state

Source commit b910328f2 was committed directly on main, pulled against remote main, pushed and hot-loaded by the default loopback service. Loaded version is 2026.916.1+185.git.b910328f2, startup recovery ready. A consistent SQL backup was completed and gzip integrity/SHA verified before the idle hot update: backup-proof.json in the private original directory. Thirty-eight employee configurations remained unchanged; model, sandbox, timers, quota accounting and issue histories were preserved.

## Actual qualification and independent runtime blocker

POL-29 was a bounded synthetic qualification with two fresh bare versioned report names in the original Polaris root, gpt-6.1-sol/high, sandbox enabled and one allowed automatic run. The exact source run cc95bee2-f6cc-493e-aa6d-96e0f93c9510 was cancelled at physical admission with workspace_busy, before provider execution. Its single scheduled resource retry 775997d4-5f77-4e25-95c4-8bb998b38fc8 never started and was suppressed by the preserved disabled on-demand wake. The Board intentionally cancelled only this synthetic issue; old run status/history and protections were not forced or deleted. No reports were written, no model tools ran, and no source/project acceptance occurred.

Read-only evaluation of the actual admission predicates found 37 old Starwave executions with missing physical source roots and no qualifying tracked owner/closure, across five deleted worktree directories. There are no active owner or local-service rows, but logical idle state does not establish unknown descendant exit. The exact existing closed host witness did not match the sampled historical identity records. These records block protected writes across projects under the current fail-closed policy. This issue is independent of report seal redaction and CI RTK portability.

The concrete governance proposal is [Deleted legacy workspace governance](../plans/2026-10-07-deleted-workspace-legacy-epoch-governance.md). It is proposed only, with no capture/activation or WSL restart. Missing-directory migration is unsupported by the current exact-source closure. Required next work is an auditable unknown-lifetime capture/host-epoch-close capability, preserving all old records, followed by a separately authorized host operation if no original proof can be recovered. A service restart, process absence, fake namespace proof, deleted locks or another code directory cannot resolve it.

## Acceptance boundary

The two reported source defects are repaired and isolated behavior/CI-path checks pass. Polaris cannot yet be declared able to run protected employee tools normally. Live report/browser acceptance remains unrun because the original-root protection blocked the provider. Do not promote component tests, API dispatch or old succeeded runs to source, whole-project, Bench or settlement acceptance.

Private originals stay in ~/.paperclip/diagnostics/report-seal-portability-review-20261007; source/runtime/gov artifacts are registered in the existing project library rather than copied. Task governance uses skills/paperclip/SKILL.md. No new maintenance branch/worktree, code copy, Polaris source edit, sandbox bypass, quota increase, history deletion or WSL shutdown was performed.
