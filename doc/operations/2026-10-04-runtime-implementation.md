# Runtime reliability implementation — 2026-10-04

Base: `39451d9e9`; branch `fix/delivery-runtime-20261004`.
Worktree: `.claude/worktrees/delivery-runtime-20261004`.
Scope: PC-04, PC-05/06, reproduced runtime portions of PC-12.

## PC-04 recovery maintenance

Implemented `recovery-scheduler.ts`: retained physical cycle owner, same promise across overlapping ticks, sequential typed completed/failed/skipped outcomes and duration, stop barrier checked after asynchronous suppression, per-phase exponential backoff capped at five minutes, fixed-code errors. Failed/skipped reap suppresses promote/queues/stranded; independent dependency/watchdog/silence/stale-lock methods retain their existing guards. Shutdown stops admission and drains cycle before hot-restart snapshot. Startup native owner classification remains first; failed startup reap now suppresses startup dispatch phases.

RED: four coordinator regressions failed (reap exception stopped independent lanes, overlapping tick owners, shutdown race, backoff). GREEN: coordinator 4/4; adjacent hot-restart/native-restart/coordinator files passed in the seven-file run (52 tests total, one admission-release failure described below).

Ruling: retain physical promise without a logical cycle timeout — a deadline cannot prove lease/child settlement and must not permit another cycle.
Ruling: global failed reap conservatively skips dependent dispatch — no per-company stop authority exists in the current periodic coordinator; broader dispatch would guess ownership.

## Work in progress

PC-05/06 scope/probe/predecessor changes, PC-12 locked fairness, subprocess cancellation, synthetic workspace measurement remain uncommitted at this checkpoint. Focused quota plus predecessor helper: 28 tests passed. Physical cancellation plus adapter probe regressions: 26 tests passed. Server `tsc --noEmit` passed after this worktree's SDK and runner TypeScript prerequisites were built.

Adjacent failure under diagnosis: `heartbeat-task-drain-admission-release.test.ts` / `leaves the run row running for the orphan reaper when the atomic release fails` expected running but observed queued. The test injects transaction-index-specific faults; regression must be resolved before handoff.

## Isolation and unrun checks

All shell invocations use RTK; no `.codegraph` index exists. Node v24.21.0 first PATH, isolated `PAPERCLIP_HOME=/tmp/paperclip-runtime-tests-20261004`, `DATABASE_URL` unset; offline frozen install with scripts disabled. No dependencies or compiled package links to main. No port3100/service/default DB/config, real Agent or provider touched.

Full runner build reached binary phase but explicit initial PATH omitted cargo (`cargo: not found`); runner TypeScript/contract checks passed. Full repo typecheck/test/build and real configured provider/ACP hello acceptance remain Root integration work. ACP environment test currently checks CLI login/scaffold only: exact ACP quota path is explicitly unsupported, never certified from CLI or classified as quota exhaustion.

## Physical probe cancellation checkpoint

Optional `AdapterEnvironmentTestContext.signal` propagates through Claude/Codex CLI hello and Claude ACP authentication probing into the existing execution-target/runChildProcess owner. A pre-aborted call starts no process; in-flight abort sends TERM, arms one grace/KILL timer, and retains the promise/process ownership through actual child close and stdout/stderr log drain. Close/error clears owned timers/listeners. Whole quota deadlines request abort; occupancy clears only after probe and managed auth cleanup settle. No hidden execution-run wall deadline introduced.

RED: real synthetic child ignored cancellation and reached its wall timeout; pre-aborted child incorrectly started. GREEN: both real process regressions passed, adjacent Claude probe/remote suites passed in the latest runtime 11-file sweep. That sweep had148 passing tests and one workspace mock failure; no probe/cancellation failure.

Ruling: cancellation acknowledgement comes from child close plus log drain, not AbortSignal delivery. Remote quota probes remain unsupported; no remote-provider stop proof is inferred from a host process.

## PC-05/06 scoped availability and predecessor recovery

Primary probes preserve saved engine/model. Explicit ACP is unsupported because the current ACP environment testers certify auth/scaffold, not a real ACP hello; the CLI login helper is not execution-path proof. Unavailable is emitted only from quota/usage-limit codes; transport/auth/config errors stay inconclusive. Managed AI selection uses current responsible-user grant/credential refs, and scoped context reconstructs environment, Agent/issue overlay, project env, and immutable routine revision env precedence. Fingerprints persist only hashes and non-sensitive identity fields, including referenced secret versions and native CLI config/auth file content hashes. Source IDs identify provenance and do not deduplicate accounts.

Per-effective-fingerprint routing separates same-user projects/credentials. A changed fingerprint invalidates an in-flight positive and releases only the old physical reservation. Claim transactions recheck the current Agent/context fingerprint. Existing claimed descriptors and pins are immutable. Historical user scopes without matching immutable fingerprint proof stay held; config changes retain outstanding physical occupancy. A logical120s expiry never releases a pending request, including a second service instance.

`quota-recovery-continuations.ts` walks50-source pages. Production callback filters company/Agent/user/fingerprint, pending interactions/approvals, paused/dependency/budget/manual blockers and current execution ownership; existing predecessor idempotency handles retries/restarts. Only sources with valid legacy effect-reconciliation evidence can retry. It advances all eligible predecessor successors using fresh primary sessions; partially failed work retains the recovery token for replay.

RED/GREEN: wrong-engine CLI certification, same-user different-account recovery, in-flight config/secret rotation, expired-but-physical probe occupancy; native config hash freshness; actual callback schedules3 eligible predecessors once and leaves fourth manual-blocked source held. Latest11-file sweep:148pass, one workspace test mock failure subsequently fixed. No quota/retry/drain/concurrency source failure. Policy test file preserved its original7 cases; new explicit-permission regression appended. Targeted policy/workspace rerun10/10GREEN.

Ruling: explicitly configured fallback respects saved permission flags; routing must not manufacture dangerouslyBypassSandbox or skip-permissions authorization. Missing per-backup permission UI fields remain an interface limitation, not a global default escalation.

## PC-12 reproduced runtime fairness/workspace paths

Reproduced starvation inside shared capacity pool: a recently served Agent could claim ahead of another company's unserved Agent. Shared singleton transaction now validates the eligible fair winner with current capacity, invokability, budget/dependency/recovery gates. The persisted latest `startedAt` is the turn history across controllers/boots; one admission per Agent per sweep and5-minute priority aging prevent a busy Agent from filling every shared slot. Unready/manual-blocked/recovery-held work cannot win from age. Cancelled/interrupted completion preserves its prior drain boundary; normal completions revisit the full queue. Max6 is capacity, not a promise that6 tasks are ready or distinct-workspace eligible. External CLIs are outside this Paperclip pool.

Workspace status was already scheduled; rev-list/merge-base bypasses reproduced through real close-readiness flow. Both heavy read commands now use the existing process-wide scheduler with cacheTtlMs=0; merge-base exit1 retains divergence semantics. Existing mutation commands retain their owner. No timeout increased and no user/old runtime files removed or copied. Synthetic measurement:1002tracked files (1000archive),1000untracked and1000ignored; status17ms/queue1ms; ls-files7ms/queue10ms;8 scan requests became2 physical scans plus7 joins. Report: `2026-10-04-runtime-git-measurement.json`. This measures synthetic filesystem data and does not qualify a customer-sized clone/seeding or real model/MCP readiness.

Drain regression repair: transaction-index-based fault injection missed the release transaction. Test now detects semantic release (queued + startedAt=null), faults the subsequent issue-lock update, and proves real rollback and reaper cleanup (2/2GREEN). Workspace cleanup-fence test now faults only status operations, so adding scheduled ancestry reads cannot shift its injection.

Remaining integration: Root resource gate under this same capacity lock; final focused qualification after integration; full repo checks and actual configured provider/ACP/browser acceptance owned by Root. No schema migration/barrel export required by these runtime leaves.

## Atomic Root resource gate integration

Root prerequisites `ab2a8badf544ae15f9df4b816f77451c45fa1fcb` are present locally as `78cfd3a64`, including real generated cost-token migration/shared contract/issue-resource owner. Runtime delta is only capacity admission and its concurrency regression: read `getIssueResourceBlock` under the existing singleton lock before queued-to-running claim; exclude the same run; validate company/Agent queued ownership; exclude resource-held fair contenders. No second scheduler/hold/queue.

RED: simultaneous different child Agents under parent maxAutomaticRuns=1 admitted2. GREEN:1admitted/1queued, exactly1running. Adjacent maxWorkers1 capacity/resource-PG/policy/drain/quota:5files66/66pass, original timeouts unchanged. All test owners closed. The Root prerequisite commit must not be cherry-picked back as a new runtime change.

Next owned qualification: PC-10 real first/resume/compact/stale-resume prompt path and measured10-turn100KB-plan sequence, with exact immutable revision and preserved latest steering/core constraints. Scope limited to plan projection/context, heartbeat context assembly, and Claude/Codex prompt selection/fallback tests; other Root UI/token changes remain protected.

## PC-10 physical prompt-path qualification

Actual CLI fixture subprocesses (not mocked stdin) execute Claude/Codex first/resume/compact-selection and stale-resume fallback paths. RED: both fresh retries reused the initial resume-delta prompt, losing the full plan/bootstrap. Attempt-local prompt construction now chooses against the actual attempted session; fresh retry restores full pinned brief/bootstrap/instructions. RED: assignment-shaped resume repeated105662-byte plan; a separately projected resumed brief retains full current assignment while omitting unrelated plan sections. New variant passes secret redaction and workspace/quota notes. RED: numeric omitted-plan metrics falsely reported compact savings on fresh attempts; now metrics match actual selected prompt.

Measured10 physical small turns with105662-byte plan: Codex first stdin112860bytes, Claude112625bytes; subsequent turns3095–3145bytes. Each includes latest steering, scope/permission constraints and exact revision reference. Measurements are exported in `2026-10-04-plan-{codex,claude}-measurement.json`, explicitly synthetic CLI, estimatedPromptTokens=ceil(chars/4), billedTokenSavings=null. No paid-provider/cached-billing savings inferred. Compact here qualifies compact prompt selection, not universal provider context-compaction retention.

Verification: stale/fresh,10-turn and saved-session config identity cases6/6 plus real immutable-approved-revision/company-boundary PG case1/1. Adjacent server-utils and remote adapter suites plus prompt/immutable cases:5files142/142pass before the two added config-identity cases; final2files7/7pass. FreshservertscGREEN. Complete plan stays in immutable document revision. No hash is treated as an Agent read receipt; projected prompt expressly requires the exact readable revision when context is missing/new.

Ruling: retain all current assignment data on assignment/recovery resume, independently project long plan. Fresh invalid-model/cwd/session configuration gets full context. Root native-session prompt selection uses the same helper; actual ACP/paid-provider semantic acceptance remains Root qualification.

Next owned PC-11: native/ACP provider-normalized totalTokens and canonical continuous-goal usage callback/durable highwater/stop proof. Root owns original maxRunSeconds deadlines and result classification.
