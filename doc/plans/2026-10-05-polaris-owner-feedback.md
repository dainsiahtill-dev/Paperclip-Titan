# Polaris owner feedback implementation

Spec: `/home/dains/Documents/polaris/docs/governance/PAPERCLIP_OWNER_FEEDBACK_20261005.md` (PC-01 through PC-08).
Baseline: `6047c4b2ab103ef1c24f40b7b6fc42ce99eed54a`.

## Global constraints

- Work only in this isolated Paperclip worktree. Polaris, its existing changes, live companies, credentials, model selections and wake settings are preserved.
- All shell invocations start with RTK. No CodeGraph index exists; use RTK discovery without creating an index.
- No paid/model requests, live writes, service restarts, dependency upgrades, unrestricted Codex settings or host credential copying for implementation/testing.
- Reuse existing dispatch, continuation, tool governance and verified_delivery contracts. Historical failures remain failures. Configuration presence is not runtime readiness or model qualification.
- Meaningful regressions must fail before implementation. Tests use isolated home/database/process fixtures and source-only Vitest projects. No timeout inflation, skips or weaker gates.
- Sequential implementation ownership; independent read-only reviews may run in parallel. Root owns integration and actual acceptance. UI changes use existing design tokens and token gates.
- Each task reports completed behavior, remaining limits and exact verification. Do not promise per-file OS fencing from scheduling or prompts.

### Task 1: Stable suppression and resumable checkpoints (PC-08)

Own server recovery/retry/continuation services, their shared types/validators and focused tests. Read `/tmp/paperclip-feedback-runtime-explore-20261005.md` first for call paths.

Persist one typed, server-owned suppression disposition on the terminal source run under company-scoped issue/source locks. Preserve status, error, artifacts and physical-attempt count. Repeated and concurrent recovery sweeps produce neither successors nor new warning writes. Restart and re-enabling wakes do not remove the disposition. Surface the stable wait using existing blocked/recovery-action mechanisms without overwriting another incident or closing the issue.

An explicit authenticated resume must bind the source, current issue/owner/revision and current workspace/scope; refuse terminal/reassigned/stale tasks. Reuse existing retry_failed_run lineage and continuation, ensuring one successor. Add an additive versioned checkpoint/residual envelope for stage, source/artifact fingerprint, completed command evidence, pending verification/report and remaining budget; do not certify arbitrary model summaries or reset total budget. Wire the envelope to actual continuation boundaries, not just a disconnected type.

Regression acceptance: at least three sweeps; concurrent single-event suppression; restart; wakes enabled without explicit resume; terminal/reassigned rejection; stale source/scope; explicit idempotent single successor; completed work remains and only pending stages are carried forward. Test no physical invocation during suppression.

### Task 2: Safe role presets (PC-01)

Own shared defaults/preset helper, Codex config/args, agent creation service/routes, UI agent create/config and related tests. Read the tools investigation report. Reuse existing low-trust containment separately; role presets must not invent privacy/permissions or a second trust resolver.

New agents default concurrency 1 and Codex sandbox bypass false; preserve explicit existing/imported values. Provide audit, manager, implementation and testing presets through existing create contracts/UI. Audit uses enforced read-only Codex sandbox and rejects conflicting bypass/extra flags. Implementation/testing use bounded writable workspace and serialize shared writing. Show resolved concurrency/workspace policy.

Audit source-file constraints must be enforced after all workspace/project/issue adapter overrides and before effective fingerprint/launch, using the saved server agent preset, with a second final-profile validation. Existing self-config access is not authority to remove/weaken an operator-managed preset; protect update/rollback/adapter switch through existing Board configuration checks. Native uses a different profile/mode: support explicitly enforced read-only launch/resume or reject unsupported audit mode; never assume legacy flags affect native. Normal control-plane review/status operations retain existing authorization; no new trust/privacy resolver.

Verify minimal public route and direct service create, explicit legacy/imported settings, audit read-only actual CLI args, contradictory overrides and role preset UI. Update default documentation alongside code. No existing employee configuration migration.

### Task 3: Exact display names and stable URLs (PC-05)

Own agent name/URL helper, create/update/reference resolution, hire/access/import and UI name conflict tests. Read the UI investigation report.

Keep stored name as display name. Use stable unique agent identity for canonical URLs (UUID acceptable), preserve unique legacy shortname lookups, reject ambiguous lookup and exact human-name duplicates explicitly and atomically. Distinct Chinese names must persist byte-for-byte without URL-normalization suffixes. Cover rename stability, existing shortname links, concurrent duplicates, access hire/import paths and cross-company boundaries. Explicit import rename policies remain deliberate; no blanket historical suffix repair.

### Task 4: Governed MCP and no-model toolchain preflight (PC-02, PC-03)

Own strict readiness/reference schema, tool-access/gateway probing and a separate employee preflight service/route/UI plus related tests. Managed AI arbitrary config/auth/env guard stays strict. Read tools investigation report.

Reuse approved company stdio templates/connections/grants and managed runtime gateways. A first-class typed declaration may reference governed connections/required tools; no raw provider/auth/config overrides. Execute approved MCP initialize and tools/list with the effective employee project cwd/target and existing process cleanup; metadata-only checks are labeled as such.

Separate preflight from paid model hello. Check approved interpreter/version probes, readable required SKILL.md files, actual MCP initialization/tool list, effective cwd/project/sandbox/model/effort against declared expectations. Return precise configured/resolved/readable/connected/unverified/error evidence and effective source/fingerprint, without secrets. No paid provisioning, package install, cwd creation, model invocation or mutation of live health records. Unsupported confinement/remote provisioning reports unverified rather than false success.

Regressions include python vs python3; unreadable skills; advertised MCP failed initialize; missing required tool; effective profile mismatch; strict auth override rejection; company isolation; no model/install/cwd-create side effects. Use real private stdio MCP fixtures.

### Task 5: Physical shared-workspace exclusion and drain (PC-06)

Own physical workspace lease/admission integration, process containment/drain tests and documentation; coordinate heartbeat hunks with Task 1 after its review.

Read `/tmp/paperclip-feedback-workspace-design-20261005.md`. Initial enforceable scope is protected Linux local legacy writers, with durable physical owner row and required guard at the actual spawn boundary. Existing runtime-service TTL leases, Git locks and controller advisory locks do not establish this guarantee. Native retained runners and remote targets must retain their own semantics and fail closed for unsupported protected shared mode rather than inherit a fictional local proof. No automatic TTL release, cross-company owner disclosure or persistence-failure bypass. Bubblewrap namespaces are available on this WSL host (root prerequisite only).

First run private physical delayed-write/alias/cancellation fault fixtures. For supported shared writer execution acquire a canonical real-cwd lease across project aliases, atomically before physical spawn, hold until verified physical drain, fail closed on missing physical ownership proof. Do not expire a write lease solely because the controller lease expires. Reuse existing cancellation/ownership and enforced task isolation when a stronger per-file boundary cannot be established. Explicit allow stays a deliberate operator policy; defaults/presets are safe. Document file-scope enforcement limits and fail closed where advertised safety cannot be provided.

Acceptance: same file/two issues, canonical cwd/different projects, expired owner delayed writer, cancellation before successor, escaped process-group child containment. Never use production paths/processes. No unsupported claim of rollback/per-file write tokens.

Implementation rulings: protected shared-local explicit `allow` is retained in saved configuration but refused before provider launch; supported isolated local writers also register their physical root. Required host identity/onSpawn persistence precedes an exact random ACK; EOF, failed bind and inherited loader hooks must cause no source effect. Uncontained native/stdio/runtime-service lifetimes conservatively block protected overlap. Known service start/adopt/retry may append to a server-owned unprotected service cohort so normal service control remains usable; that cohort neither replaces earlier lifetimes nor qualifies as a contained writer. Observe actual configured cwd, including preexisting board-started services with no run. Unknown lifetime, TTL and parent absence cannot release protection.

### Task 6: Engineering verified-delivery preset (PC-07)

Own existing delivery policy helper/validator/material authority integration and project preset UI/tests/docs.

Add an engineering preset using existing verified_delivery, same-company independent reviewer and existing immutable root material. Provide a versioned evidence bundle covering exact source/dirty hashes, real command exits, verification/verifier, reviewer and unresolved limits. Narrow validation rejects missing/failed/stale engineering evidence in existing acceptance path; no second ledger. Preserve ordinary agent_claim_policy behavior and board authority. Self-approval, run exit0 without evidence, failed verifier and stale material cannot qualify verified delivery. No fixture claims of actual Polaris acceptance.

Only host-observed inner approved workspace-job operations with authenticated issue/run/workspace, exact approved definition and stored-log identity can prove commands. Bundle JSON requests reference resolution rather than supplying authoritative exit/source/reviewer facts. Task 5 exclusion alone does not stop a test modifying source and restoring it: require a host-owned read-only source interval or genuinely fixed immutable snapshot; unsupported paths remain unverified. Reuse bounded authorized material readers, not arbitrary paths or unbounded scans. Include engineering requirements in existing policy/criterion hashes and use the same evidence resolver at assessment, decision and completion; current source/job/log drift invalidates acceptance even when bundle bytes do not change.

### Task 7: Cold UI loading and integration acceptance (PC-04)

Own App route imports/hidden-dialog loading, compiled local launch selection, browser profiling helper, docs and final integration gates. Read UI report; retain measured cold/warm evidence.

Profile the same 26-person organization with consistent browser/timeouts and HAR; distinguish source Vite vs compiled static mode. Make supported local deployment prefer compiled UI with actionable loading/error states and lazy unrelated routes/dialogs. Do not attribute all source requests to production or raise timeouts as a fix. Validate cold/warm real content, agent count, no page errors and request reduction in isolated copied data.

Run relevant tests after each task and final typecheck, source Vitest, build and token gates. Independently review the whole branch. Attach inspectable report/artifacts; deployment/merge follows existing session authorization only after concrete reviewed result and fresh backup, using managed service ownership rules. Preserve old failure evidence and state explicit acceptance limits.

The measured read-only baseline uses the same 26 public employee records in owned Windows Edge: 5 cold and 5 reload samples for each static/Vite mode. Static cold/reload medians were 4.02/4.99 seconds (68–72 responses); Vite 37.83/34.94 seconds (1366–1369 responses). Fixed navigation/readiness/screenshot limits remain 30/90/15 seconds. Earlier Linux Chromium stalls remain failed evidence, not performance samples or a diagnosed module-count cause. Prefer explicitly selected fresh compiled assets for supported local deployment; retain an explicit source-dev mode and prevent stale static-directory shadowing. Existing employee display names/IDs/relationships stay, while new canonical URL keys are UUIDs. Root owns final full-branch review, gates, personal browser flow, remote integration, fresh backup and managed deployment.
