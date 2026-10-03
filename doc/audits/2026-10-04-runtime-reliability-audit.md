# Paperclip Runtime Reliability Audit and Implementation Plan

> **For agentic workers:** Use `superpowers:executing-plans` to implement this plan task by task. Use `superpowers:subagent-driven-development` only when the task owner explicitly authorizes delegation. Checkbox steps track execution; this audit does not authorize production restart, configuration changes, model calls, task cancellation, or database mutation.

**Goal:** Improve Paperclip scheduling, provider recovery, and restart reliability while preserving existing tasks, execution ownership, budget gates, and external effects.

**Architecture:** Keep `heartbeat.ts` as the existing orchestration boundary. Add narrow scheduler and probe identity owners around the existing durable run, wake, controller lease, quota book, and native finalization mechanisms. Use PostgreSQL claims and receipts as authority; live events and comments describe committed changes.

**Tech Stack:** Node.js 24.11+, TypeScript, pnpm 9, Express, Drizzle, PostgreSQL, Vitest; current tested Node is `/home/dains/.paperclip/runtime/node-v24.21.0/bin/node`.

**Spec:** `doc/SPEC-implementation.md`, particularly §§8.2, 11, 13, 15, 17; `doc/DEVELOPING.md` agent concurrency, hot restart, native restart, and backups; `doc/DATABASE.md` legacy controller ownership and native runner persistence. Read `AGENTS.md`, `doc/GOAL.md`, and `doc/PRODUCT.md` before implementation. Resolve detailed execution semantics against `doc/execution-semantics.md` before changing recovery admission.

## Global constraints

- Every business record belongs to exactly one company. Preserve single assignee, atomic checkout, approval gates, budget hard stop, and mutation activity.
- Every shell command starts with `rtk`; use `rtk proxy` when there is no native wrapper. Every pipeline/chained command also receives its prefix. Read/write UTF-8 and use `apply_patch` for repository edits.
- Preserve unrelated work. This audit owns only this file; other audit files have separate writers.
- Run Node 24.11+; use literal `PATH` in the commands below. Do not depend on Windows pnpm or the host's older Node.
- Test in a fresh state root with explicit `PAPERCLIP_HOME`, `PAPERCLIP_CONFIG`, and `PAPERCLIP_INSTANCE_ID`. Keep port 3100 and the default database out of tests. Set `CUDA_VISIBLE_DEVICES=`. All provider behavior in local tests is mocked.
- Scope is Paperclip platform reliability. Company names, issue titles, customer content, credentials, and project-specific execution requirements do not belong in this document.
- A terminal database status does not prove provider termination. An expired lease does not authorize duplicate inference or automatic tool replay.
- Existing configured engine, model, environment, responsible user, task policy, and credential owner remain execution authority. A cheaper model or a different engine does not qualify that authority.
- Repository-wide typecheck/test/build are required for a broad PR-ready implementation handoff. This document-only audit has targeted evidence and is not that handoff.

## Review focus

1. Same Agent and responsible user can own multiple tasks with different project credentials or engine overrides; one positive probe must not release unrelated waits.
2. Company pause, Agent pause, project budget, pending approval, manual blocker, task tree hold, or verified operator Stop must remain authoritative through recovery and deployment.
3. A failing or slow recovery phase must not prevent independent companies' eligible queues, dependency wakes, or lock reconciliation from progressing.
4. Terminal runs can still own physical capacity; cancellation, controller loss, native recovery, PID reuse, and cross-host PID identity require separate evidence.
5. Recovery after a commit/notification crash must resume the same intended work once, retain receipts, and avoid replaying a completed external effect.

## 1. Snapshot and evidence authority

Audit date is 2026-10-04 Asia/Taipei. Read-only health returned:

| Evidence | Current observation | Meaning |
|---|---|---|
| On-disk HEAD | `ce97b8e8fee0b952186e85f4433c29491d63ae2c`, branch `main` | Source audited here |
| Process version | `2026.916.1+50.git.e7761ba11` | Loaded server version; do not replace with on-disk Git metadata |
| Process start | `2026-10-03T10:49:27.128Z` | Current loaded process predates the HEAD metadata commit |
| Startup recovery | `ready`, updated `2026-10-03T10:49:33.203Z` | Startup recovery completed; this is not provider/continuity qualification |
| Backup health | `enabled=true`, `status=ok`, latest file about 189 MB, age about 0.1 hour at observation | A recent logical backup exists; restore was not tested |
| Initial worktree | Clean | Runtime source unchanged during audit |

Anonymous API aggregate at `2026-10-03T17:59:03.539165Z`:

- One active company; 12 Agents: 11 idle, one running.
- `/live-runs?minCount=0` reported one running run and no queued run.
- Last 1,000 runs: 525 succeeded, 75 failed, 394 cancelled, five interrupted, one running. This capped sample is historical task activity, not a failure-rate estimate or proof of a current platform incident. No task payload was recorded.
- No live configuration, database, service, business run, external provider, SSH, or GPU was changed.

`.codegraph/` is absent for this checkout. Navigation used RTK source queries. Line references below belong to `ce97b8e8f`; reacquire them if code changes.

## 2. Existing behavior: retain, characterize, do not rebuild

### 2.1 Recent fixes already present

| Commit | Existing delivery | Existing proof to retain |
|---|---|---|
| `e7761ba11` | Active primary monitoring before the first quota error; active run and responsible-user context provided to probe | `agent-quota-fallback.test.ts:76`, cadence at `:96` |
| `9d8ec5843` | `unavailable` primary probe activates configured backup without inventing quota history; `busy/error` leave primary routing unchanged | `agent-quota-fallback.test.ts:57`, parameterized inconclusive results |
| `07e7439a4`, `a22c63eb7` | Per-user quota book, backup selection, probe lease, durable recovery token; recovered primary clears incompatible session/reset waits | `agent-quota-fallback.test.ts:45`, `:289`; `heartbeat-retry-scheduling.test.ts:436` |
| `8b32a6b7d` and earlier capacity commits | Verified legacy local stop receipt, namespace fencing, missed terminal release sweep, native same-run failure reservation | `heartbeat-agent-concurrency.test.ts:349`, `:370`, `:428`, `:459`, `:585` |
| `f5ec78ed0` | Reconciled legacy capacity release through `execution-recovery-resolution.ts` | `issue-recovery-actions.test.ts` includes a 60-line regression added by this fix |
| `b77b2c3f7` | Tests follow current dependency wake states | `heartbeat-dependency-scheduling.test.ts` |
| `dd351a5e7`, `3ef9609c4` | Comments merge into legacy retries and preserve running retry ownership | Reuse current wake/queued-comment owners; do not introduce another message queue |

Exact relevant repository history can be refreshed with `rtk proxy git log --oneline -- server/src/services/heartbeat.ts server/src/services/legacy-process-capacity.ts server/src/services/execution-recovery-resolution.ts`.

### 2.2 Current call paths and owners

| Entry and path | Actual authority and effect |
|---|---|
| `server/src/index.ts:1650` scheduler interval; quota at `:1668`, timers at `:1672`, periodic recovery at `:1784` | Tracks async work for shutdown. Timer and quota calls are separate promises; periodic recovery is one chained promise. |
| `heartbeat.ts:26147 enqueueWakeup`; company gate `:26391`; budget gate `:26560`; `:19820 startNextQueuedRunForAgent` | Persists wake/run intent; then selects eligible Agent work. Wake acceptance is not execution or business completion. |
| `heartbeat.ts:17340 claimQueuedRun` | Agent invokability, budget, daily cap, tree hold, dependencies, stale task identity, responsible user, quota pin; current dispatch module provides transactional stale/continuation gates. |
| `run-capacity.ts:51 admitQueuedRunCapacity`, `:62 checkRunCapacity` | Singleton settings row lock serializes capacity across controllers and companies. Counts running or unreleased terminal reservations plus active probe reservations. Missing/invalid group is fail closed. |
| `heartbeat.ts:20050 executeRun`; configured quota pin selection `:20217`; `:26065` release/finally | Executes admitted runtime profile. Finally flushes run effects, attempts safe capacity release, and triggers queued work. |
| `heartbeat.ts:15180 scheduleBoundedRetryForRun`, `:15215 registerQuotaFailure`; `:16337 promoteDueScheduledRetries` | Uses bounded failure ancestry, durable retry row, reset/backoff constraints, issue gates, and idempotent predecessor successor creation. Quota without reset waits one hour if no immediate backup handoff. |
| `modules/run-dispatch/application/use-cases.ts:28 createPromoteDueScheduledRetries`; `adapters/postgres.ts:448 listDueRetries`, `:753 promoteOrCancelDueRetry` | Due retry sweep capped at 50; issue/wake/run locks and transactional status/event writes. Existing tests cover rollback and cross-company isolation. |
| `heartbeat.ts:9441 quotaFallbacks`; `agent-quota-fallback.ts:134 checkPrimary`, `:215 tick` | Agent metadata stores scoped routing/probe/recovery receipts. Probe occurs after the capacity/Agent-lock transaction commits. |
| `heartbeat.ts:9453 onRecovered` | Advances all matching scheduled quota successors, removes backup sessions/wait hints, then schedules the one recorded latest failed quota source. This is persistent progression, not notification only. |
| `heartbeat.ts:16893 releaseRunCapacityIfStopped`; `:16936 nativeCapacityReleaseAllowed`; `:19378 reconcileTerminalCapacityReleases` | Requires terminal status plus owner/process/native evidence, then conditional release. Terminal sweep pages 200 and retains cursor; an unknown remote owner is not released from a local PID guess. |
| `legacy-process-capacity.ts:74 recordLegacyProcessIdentity`, `:86 legacyProcessStopConfirmed`, `:93 recordLegacyLocalProcessStop` | Uses matching controller/PID/group/start metadata and OS/PID namespace. Later launch invalidates older stop proof. |
| `legacy-controller-lease.ts:13 legacyControllerClaim`, `:22 renewLegacyControllerLease`, `:67 watchLegacyControllerLease` | Database-clock 60-second lease, 10-second renewal, dispatch fence, abort on lost ownership. Lease expiration permits cleanup, not replacement dispatch. |
| `heartbeat.ts:18850 reapOrphanedRuns`, `:19413 resumeQueuedRuns` | Startup/tick orphan cleanup, terminal capacity reconciliation, deferred comment recovery, then active-company queued Agent dispatch. |
| `heartbeat.ts:14809 recoverNativeRunsAfterRestart`; `native-restart-recovery.ts:273 classifyNativeRunnerRecoveryEvidence`, `:422 claimNativeRestartRecoveries`, `:855 controller generation` | Durable native controller ownership and restart request distinguish reattach from replacement. Native recovery completes before generic startup queue admission. |
| `index.ts:1443 startupHeartbeatRecovery`, `:1938 shutdown`; `hot-restart.ts:496 writeHotRestartIntent`, `:550 writeHotRestartShutdownSnapshot` | Startup order protects native/hot restart before ordinary queues. Shutdown quiesces scheduler, snapshots detached CLI ownership, selectively drains ACP, flushes writes before embedded DB shutdown. |
| `recovery/service.ts:5225 reconcileResolvedDependencyWakeBackstop`; `issue-dependency-wakeups.ts:137 buildIssueBlockersResolvedWakeStateKey` | Durable wake keyed by full blocker set and blocked cycle; skips existing live paths, pending interactions/approvals, independent waits and pause holds. A comment is not resolution authority. |

### 2.3 Bounds that already exist

- Failure retry count is owned by `execution-recovery-attempt.ts:2`; resource waits and max-turn continuations do not reset or inflate failure ancestry.
- Quota probes lease provider capacity for 120 seconds (`agent-quota-fallback-policy.ts:48`) and individual hello subprocesses have 45-second timeout plus five-second grace. These are not a measured whole-probe bound.
- Legacy controller lease bounds authority even when output is silent. Renewals are independent of output.
- Dependency backstop has keyset cursor and candidate bound. Terminal capacity sweep also pages rather than only scanning the first blocked records.
- Active-run silence is informational. It does not terminate legitimate long work or wake a substitute Agent.

## 3. Findings, certainty, and priority

No P0 platform defect was established. Existing mechanisms are substantial; the remaining work should improve authority and scheduling edges rather than create a replacement runtime.

### R1 — P1 reproduced: this availability probe tests CLI only

**Root:** `quota-model-probe.ts:46` constructs `{ ...agent.adapterConfig, engine: "cli", ... }`. `selectQuotaFallbackAgent` preserves explicitly selected ACP execution (`agent-quota-fallback-policy.ts:129`, `buildQuotaBackupConfig` at `:117`, `quota-fallback-live-steering.test.ts:4`). `quotaProbeAvailable` accepts CLI hello as primary availability. The actual execution path can therefore remain ACP while availability evidence was obtained on CLI.

**Fresh isolated reproduction:** An ephemeral PostgreSQL Agent was seeded with `adapterType=claude_local`, `engine=acp`. A registered mock adapter captured its `testEnvironment` configuration and returned mock hello; `execute` was forbidden. Output:

```json
{"configuredEngine":"acp","observedProbeEngine":"cli","treatedAsAvailable":true,"providerExecuteCalls":0,"isolatedDatabase":true}
```

Corrected harness exited 0 and cleaned its disposable database. An earlier harness import used root cwd and failed before database creation; the next harness incorrectly omitted the URL from `closeRegisteredClients`, producing a cleanup error after the observation. The final harness uses server cwd and the fixture's own `cleanup()`. No repro Postgres process remained. This proves that the availability probe tests CLI even when execution is configured ACP. The actual ACP availability, quota interpretation, and business outcome of a resulting switch remain unverified. The mock establishes configuration routing, not a real provider-ready result.

Keep three evidence levels separate: (1) probeConfig/environment identity can match or differ from the task; (2) a harmless probe can receive a valid hello on that exact execution path; (3) the task can continue with its permissions, context and durable effect handling. A configuration match alone does not prove provider readiness, and CLI readiness does not prove ACP readiness. A real quota diagnosis still needs the exact failed request's provider classification/reset evidence.

**Minimum fix:** Verify primary availability on the configured engine, or return an explicit unsupported/error result if an exact harmless probe is unavailable. Do not certify ACP from CLI, do not change the executing Agent engine, and do not force backend fallback. Preserve the current `available/unavailable/busy/error` contract and existing backup behavior.

### R2 — P1 confirmed structural isolation gap: recovery chain and interval overlap

**Root:** `index.ts:1784-1831` uses `reapOrphanedRuns().then(promote).then(resume+stranded).then(dependencies).then(watchdogs).then(silence).then(staleLocks).catch(...)`. Any rejected earlier phase skips every later phase on that tick. `startHeartbeatSchedulerInterval` at `:1183` uses `setInterval`; the periodic recovery chain has no own single-flight admission. If a chain lasts more than the interval, another begins while the first remains active.

Existing database claims protect many duplicate effects, but they do not prevent overlapping scans, repeated contention, or independent healthy work waiting behind a bad phase. This is source-proven control flow, not a reproduction of a production outage. Preserve native startup ordering, which is a safety barrier; do not turn startup ownership recovery into free-running parallel phases.

**Minimum fix:** A small scheduler owner should retain one physical promise per recovery cycle, isolate independent phase errors, and report the blocked/failed phase. Reaper failure may prevent unsafe successor dispatch; safe read/reconcile lanes can still run. Do not use `Promise.race(timeout)` to clear a lane while its DB/provider owner remains active.

### R3 — P1 needs regression proof: one user scope covers different task accounts

**Evidence:** `quotaScopeKey` uses responsible user only (`agent-quota-fallback-policy.ts:49`). `agent-quota-fallback.ts:225-228` picks the latest running source per such key. `quota-model-probe.ts:34-44` may use that source task's project credentials. `heartbeat.ts:9454-9467` advances matching scheduled quota successors for the whole Agent/user scope. A same-user Agent can operate tasks whose project credential owners differ. The global Agent fingerprint does not include each task's project env binding/version.

**Risk:** A valid probe for project B could clear quota routing or accelerate retries for project A using a different account. Source/Agent overrides are currently rejected by probes, which is good; project credentials are supported and need identity separation. A transient secret rotation can also change account authority without changing the Agent's fingerprint. No live cross-project wrong recovery was established.

**Minimum boundary:** First add a regression with two project accounts. Bind successful probe evidence to a content-free effective execution identity: company, Agent, responsible user, environment, engine, model, provider/connection owner, project or routine credential context, and revisions. Include secret reference/version IDs, never secret material. If the exact identity cannot be derived, keep that source waiting and report unsupported. Reuse existing quota receipts rather than adding another general retry system.

### R4 — P1 needs regression proof: recovered scope stores only one exhausted source

**Evidence:** `registerQuotaFailure` stores one `primaryQuotaRunId` and one `backupQuotaRunId` per scope; newer failures replace older pointers. `onRecovered` advances existing scheduled successors for all matching sources, but creates a missing successor only for `scope.backupQuotaRunId ?? scope.primaryQuotaRunId`.

**Risk:** Several distinct issues can exhaust their backup retry ladders under one scope. A positive primary probe can immediately revisit only the latest pointer; earlier failed issues rely on other recovery monitor/backstop timing. Current backstops may eventually restore them; do not claim permanent task loss without tracing those paths. Measure each issue's persisted next action, not the count of recovery notifications.

**Minimum boundary:** Reconcile a bounded list of same-identity failed quota source issues without successors; re-read current task ownership/gates; schedule through the existing idempotent predecessor path. Keep the existing recovery token until the batch is fully committed or continuation remains durably deferred.

### R5 — P1 needs acceptance proof: no bounded fairness across Agents/companies

**Evidence:** `resumeQueuedRuns` fetches every queued Agent without ordering (`heartbeat.ts:19497-19512`) and calls `startNextQueuedRunForAgent` sequentially. Each Agent start calculates its full free Agent slots (`:19836`) and claims until those slots fill (`:19932`). Its sort always ranks ready `in_progress` above ready `todo`, then priority, then creation time (`:19900-19926`); no aging changes those ranks. Completion/invoke paths also directly start the same Agent.

**Risk:** A busy Agent can refill a shared pool while another company waits; a stream of higher-ranked eligible work can keep an older lower-ranked run queued. Global fairness is absent from the current algorithm. Current live snapshot has no queued backlog, so there is no measured live starvation.

**Minimum boundary:** Define fairness for eligible admissions, not a time guarantee while all existing work still owns capacity. Use a one-admission Agent quantum and bounded priority aging, apply the same policy to invoke/completion/tick claims, and preserve atomic capacity/gate checks. Validate a winner under the capacity singleton lock; sorting an unlocked snapshot alone cannot enforce fairness across two controllers.

### R6 — P2 needs measurement: whole-probe and execution bounds

**Evidence:** 120-second probe reservations expire by timestamp. Probe secret resolution, managed authentication, executable checks, hello, and cleanup are distinct asynchronous steps; there is no whole-operation cancellation contract in `AgentQuotaFallbackDependencies.probePrimary`. `process/execute.ts:52`, Claude `execute.ts:320`, and Codex `execute.ts:791` accept absent `timeoutSec` as zero. `runChildProcess` only arms its wall timer when `timeoutSec > 0` (`adapter-utils/server-utils.ts:4769`).

**Risk:** A slow owner can outlive a probe reservation, or a legitimate active execution may have no configured time bound. A lease's expiration is not physical-stop proof. Long session goals are deliberate product behavior; do not terminate them solely to improve a metric.

**Minimum boundary:** Measure phase duration and physical owner lifetime; propagate abort and stop acknowledgement through probes; retain occupancy until physical completion or positively proven stop. Any new run wall limit must be an explicit execution policy with visible durable deadline and stop evidence, not a hidden default that kills existing tasks.

## 4. Implementation sequence and ownership contracts

Each task ends with a small reviewable diff and its own red/green cycle. Proposed new files are intentionally separate from live runtime edits. Do not start R3/R4 data changes until R1/R2 gates pass and regression proves the need.

### Task 1: qualify exact probe engine (R1)

**Files:** Modify `server/src/services/quota-model-probe.ts`; test `server/src/__tests__/agent-quota-fallback.test.ts`; retain `server/src/__tests__/quota-fallback-live-steering.test.ts`. If the adapter environment tester cannot harmlessly probe ACP, adjust only the appropriate adapter test owner and its tests; do not alter execution routing.

**Interfaces:** Keep `probeQuotaModel(...): Promise<AdapterEnvironmentTestResult>` and `quotaProbeAvailable` call sites. Unsupported exact probing returns the existing `quota_probe_environment_unsupported` error check. The dependency's `PrimaryQuotaProbeResult` stays unchanged.

- [ ] Add a parameterized test seeded with `engine=acp` for Claude and Codex. Mock `testEnvironment` to capture `context.config.engine`, forbid `execute`, and assert `engine=acp` or explicit unsupported; CLI success must not qualify ACP.
- [ ] Add missing/auto engine cases using the adapter's current production engine resolver, plus an explicit CLI case. Do not duplicate model-specific resolver rules in the quota service.
- [ ] Run only the new test and require it to fail on the captured CLI engine. Preserve the failing assertion in review evidence.
- [ ] Replace forced CLI authority with the exact resolved engine. Retain stripped task JWT/instructions, model selection, credential ownership, hello requirement, environment refusal, cleanup, and capacity reservation.
- [ ] Run existing quota/fallback/retry tests. Verify `busy/error` never activate backup, `unavailable` still does, and a stale probe after config edit cannot recover primary.
- [ ] Review and commit only this task's files. No live check-primary request is part of the local test.

Concrete assertion for the existing test fixture:

```ts
const run = await seed();
await db.update(agents).set({
  adapterConfig: { model: "test-model", engine: "acp" },
}).where(eq(agents.id, run.agentId));
const [agent] = await db.select().from(agents).where(eq(agents.id, run.agentId));
if (!agent) throw new Error("Seeded Agent missing");
const test = vi.spyOn(requireServerAdapter(agent.adapterType), "testEnvironment")
  .mockResolvedValue({ adapterType: agent.adapterType, status: "pass",
    testedAt: now.toISOString(), checks: [
      { code: "claude_hello_probe_passed", level: "info", message: "mock hello" },
    ] });
await probeQuotaModel(db, agent, "alice");
expect(test.mock.calls[0]?.[0].config.engine).toBe("acp");
```

This uses the existing test file's `seed`, `db`, `now`, imports and fixtures. For Codex change its seeded adapter type and use its own hello code. If ACP test support is absent, assert the unsupported check and zero adapter calls instead; that branch must be decided from the adapter contract before implementation.

### Task 2: isolate periodic recovery failures and physical owners (R2)

**Files:** Create `server/src/services/heartbeat-recovery-scheduler.ts` and adjacent `.test.ts`; modify only the periodic orchestration block in `server/src/index.ts`. Retain startup barrier and shutdown tracking.

**Interfaces:**

```ts
type RecoveryPhase = "reap" | "promote" | "queues" | "stranded"
  | "dependencies" | "watchdogs" | "silence" | "stale_locks";
type PhaseOutcome = "completed" | "failed" | "skipped";
interface RecoveryPhaseResult { phase: RecoveryPhase; outcome: PhaseOutcome; durationMs: number }
interface RecoveryScheduler {
  tick(): Promise<readonly RecoveryPhaseResult[]>;
  drain(): Promise<void>;
}
```

Callbacks remain the existing heartbeat service methods. Phase errors are logged through fixed phase codes; do not log arbitrary provider/config values. A failed stop/lease/reaper prerequisite suppresses dependent promote/resume/stranded dispatch until that authority is proven. It is not sufficient to catch the error and call the next dispatch method anyway. Independent non-dispatch reconciliation can run; unaffected company dispatch is permitted only with its own current, established safety prerequisites. Dependency/lock lanes keep their own existing gate checks. No parallelizing native startup ownership classification.

- [ ] Write a test with reaper rejection, successful independent reconciliation callbacks, and dispatch callback denied by missing stop authority. Assert each allowed callback runs once and failed phases are visible.
- [ ] Write a deferred-promise test: call `tick()` twice before the owner settles; require one physical invocation and one tracked owner. `drain()` remains pending until that owner settles.
- [ ] Write shutdown test: suppression check is in flight, stop admission, then resolve it; require zero new dispatch after shutdown snapshot barrier.
- [ ] Implement the coordinator with a retained cycle promise. Clear it only in physical `finally`, never on a timer race. Sequence dependent phases but catch failures at the smallest valid boundary.
- [ ] Bind its promise to `trackHeartbeatSchedulerWork`. Shutdown stops future ticks and awaits `drain()` before authoritative run snapshot.
- [ ] Run new coordinator tests plus existing hot-restart, task-drain, native-restart tests. Review and commit.

Complete internal owner sketch, using the typed interfaces above:

```ts
function createRecoveryScheduler(
  phases: Readonly<Record<RecoveryPhase, () => Promise<unknown>>>,
  canRunPhase: (
    phase: RecoveryPhase,
    priorResults: readonly RecoveryPhaseResult[],
  ) => Promise<boolean>,
  logFailure: (phase: RecoveryPhase) => void,
): RecoveryScheduler {
  let active: Promise<readonly RecoveryPhaseResult[]> | null = null;
  const order: readonly RecoveryPhase[] = [
    "reap", "promote", "queues", "stranded", "dependencies",
    "watchdogs", "silence", "stale_locks",
  ];
  async function cycle(): Promise<readonly RecoveryPhaseResult[]> {
    const results: RecoveryPhaseResult[] = [];
    for (const phase of order) {
      const started = performance.now();
      let outcome: PhaseOutcome = "skipped";
      try {
        if (await canRunPhase(phase, results)) {
          await phases[phase]();
          outcome = "completed";
        }
      } catch {
        outcome = "failed";
        logFailure(phase);
      }
      results.push({ phase, outcome, durationMs: performance.now() - started });
    }
    return results;
  }
  return {
    tick() {
      if (active) return active;
      active = cycle().then(
        results => { active = null; return results; },
        error => { active = null; throw error; },
      );
      return active;
    },
    async drain() { if (active) await active; },
  };
}
```

`canRunPhase` must preserve shutdown/scheduling suppression and use `priorResults` plus current scoped ownership evidence to enforce phase-specific prerequisites. Unknown stop/lease authority skips dependent dispatch; it cannot be replaced by a warning. Unaffected work may proceed only when its own prerequisites are known. Each phase still uses its existing row/lease/gate checks. `logFailure` receives a fixed phase, not credentials or an untrusted exception body. This owner retains the physical cycle even when a callback is slow; cancellation/deadline implementation belongs in Task 6 and must not clear `active` before settlement.

### Task 3: bind availability to effective task identity (R3)

**Files:** Create `server/src/services/quota-probe-identity.ts` and adjacent tests; modify `quota-model-probe.ts`, `agent-quota-fallback-policy.ts`, `agent-quota-fallback.ts`, and quota selection/admission seams in `heartbeat.ts`. Use current AI connection/runtime and secret metadata owners; do not copy decrypted credentials into a book.

**Interfaces:** Internal proposed contract:

```ts
interface QuotaProbeIdentity {
  version: 1;
  companyId: string;
  agentId: string;
  responsibleUserId: string | null;
  sourceRunId: string | null;
  effectiveFingerprint: string;
}
```

The fingerprint includes engine/model/environment/provider binding/context revisions without raw values. `sourceRunId` is provenance, not part of the account dedupe identity. It must resolve the same overlays as actual execution, including project and applicable routine revision, before a positive result is accepted.

- [ ] Seed two projects under the same company/Agent/user with distinct synthetic credential bindings. Register only mock adapters. Let B probe available while A is unavailable; assert A remains backup/waiting and its `scheduledRetryAt` is unchanged.
- [ ] Add same-project secret-version rotation while the probe is in flight. Assert the old positive result releases its physical slot but cannot change new routing.
- [ ] Add same-account tasks with distinct source IDs; assert one probe can be shared only when effective identity matches.
- [ ] Implement identity derivation and match it again under the Agent/claim transaction before committing routing. Unknown/unsupported overlays return error and leave existing routing intact.
- [ ] Define backward reading of version-1 user scopes: retain outstanding probe occupancy; do not turn stale unknown-account state into a recovered identity. Migrate lazily only after current identity is derived, or use an additive versioned metadata field.
- [ ] Run identity, quota, primary/backup authentication, company isolation and retry suites. Review schema/API decision below before commit.

### Task 4: reconcile every affected failed quota issue (R4)

**Files:** Create `server/src/services/quota-recovery-continuations.ts` and adjacent tests; modify `heartbeat.ts:9453` callback. Reuse `scheduleBoundedRetryForRun`, recovery actions, and the existing predecessor idempotency seam.

**Interfaces:** Internal batch result `{ examined: number; scheduled: number; alreadyCovered: number; gateHeld: number; deferred: number; nextCursor: string | null }`. A batch of at most 50 issues uses keyset traversal. Persist an outbox cursor only if required to survive partial batch completion; existing recovery token remains uncleared while durable work is incomplete.

- [ ] Seed three distinct failed quota issues on one Agent/user/effective identity, each without a successor. Include existing scheduled retry, running successor, stale assignment, manual blocker, paused company, project hard stop, pending interaction, and another company's similar run.
- [ ] Run the callback twice and concurrently, then instantiate a fresh service. Assert at most one successor per predecessor, every eligible issue has a durable next path, held issues remain held, other company unchanged.
- [ ] Inject failure after scheduling the first issue and before token completion; restart the service and verify it finishes the rest without duplicating the first successor.
- [ ] Implement candidate selection restricted by company/Agent/user/effective identity and current failed source identity. Recheck current issue/lease/approval/budget/Stop gates through existing admission. A false probe cannot override those gates.
- [ ] Existing source-scoped recovery monitors/actions must be resolved or retained consistently with actual scheduled work. A notification or `primary_recovered` activity alone is not delivery.
- [ ] Run quota/retry and relevant recovery-action suites. Review and commit.

### Task 5: enforce fairness at all admission entrances (R5)

**Files:** Create `server/src/services/queued-run-fairness.ts` and adjacent tests; modify `resumeQueuedRuns`, `startNextQueuedRunForAgent`, the completion/invoke dispatch entrances, and `run-capacity.ts` only for a locked winner check. Preserve wake-queue ownership contracts.

**Policy:** Each eligible Agent receives one admission per round in a shared capacity pool. Within Agent, readiness remains mandatory; priority ages every five minutes toward the highest priority. Old ready `todo` can join the highest ready rank after aging; unresolved dependency work never becomes ready by aging. Ties use `createdAt` then run UUID. A busy pool grants no dispatch-time promise while earlier owned work remains active.

- [ ] Add deterministic tests with one pool of size one, two companies, one busy Agent with 20 pending issues, and another with one old issue. Across released slots the second eligible Agent must get a turn; repeat through tick, invoke, and completion entrances.
- [ ] Add ongoing critical/in-progress arrivals while an old ready low-priority task waits. Advance the clock to its aging boundary; require bounded admissions before it runs. Unready/manual-held/budget-held tasks must never win by age.
- [ ] Add two-controller competing claims; both must validate the same policy inside the capacity lock, admit only one winner, and keep the losing run queued without cancelled-retry churn.
- [ ] Implement pure candidate comparison and bounded candidate pages. Use the existing singleton capacity transaction to validate the winner; retain conditional run claim and issue lock ordering.
- [ ] If a fairness cursor is needed across boots/controllers, add private scheduler state instead of hiding mutable state inside user-editable General settings. Prove cursor-reset behavior and indexed queries before adding a table.
- [ ] Run capacity, start-lock, stale queue, dependency, retry, tree hold and company guard suites. Review and commit.

### Task 6: qualify probe physical bounds and controlled run deadlines (R6)

**Files:** Modify `AgentQuotaFallbackDependencies` and the exact probe/process owners only after measuring; test `agent-quota-fallback.test.ts`, relevant adapter probe utilities, and `heartbeat-agent-concurrency.test.ts`. Optional explicit run deadline policy requires a separate contract review.

- [ ] Mock a probe callback that stays pending past 120 seconds; assert a second controller cannot release its slot and start another physical request merely because timestamp expired.
- [ ] Mock abort, delayed termination, config edit, and server restart. Require reservation retention until completion/stop receipt, then exactly one release. A failed cleanup remains visible.
- [ ] Propagate an abort/physical settlement contract through testEnvironment/probe operations. A whole-probe deadline requests cancellation; it does not clear the owner or stamp availability before stop acknowledgement.
- [ ] Add phase-duration evidence without prompts, account identifiers, secrets or telemetry. This is the local run log/health path unless separately reviewed as telemetry.
- [ ] If explicit execution deadlines are added, persist absolute deadline across restart, preserve session goals, publish the visible reason, stop the exact provider owner, reconcile outcomes, and retain capacity until stop. Omitted timeout remains a deliberate policy boundary until approved.
- [ ] Run cancellation/grace/capacity/lease/restart tests and the isolated process acceptance below. Review and commit.

## 5. DB/shared/server/UI contract decisions

| Task | DB/schema | Shared/API | Server | UI |
|---|---|---|---|---|
| R1 | None | Existing result union/check codes; add a stable check only if unsupported copy needs it | Exact engine probe resolution | Display returned unsupported reason through existing test/status surface |
| R2 | None for single process owner | No required API change | Coordinator and per-phase outcomes | No runtime control change; optional phase health should use server contract |
| R3 | Prefer versioned metadata initially; no migration of plaintext credentials | If status is now context-specific, add explicit identity selector/summary consistently to shared validators/types/routes/UI | Probe identity and revalidation | Agent-wide status must not claim all tasks recovered when only one context is qualified |
| R4 | Existing token/unique successor may suffice; persistent batch cursor only if regression requires it | Optional count/status fields must be typed and scoped | Bounded continuation reconciliation | Show resumed/held counts if new fields are exposed; never infer from comments |
| R5 | No new table for first pure policy proof; private cursor table only if cross-controller test needs it | No required setting surface for fixed initial policy | Shared locked admission policy | Existing waiting state remains; new reason requires shared type/client handling |
| R6 | Probe owner receipt/deadline storage must survive boot if added | Explicit policy needs validator/type/API changes | Abort and physical stop lifecycle | Deadline/cleanup state and actions must match server authority |

Any real schema change must update `packages/db/src/schema` and exports, generate migration with `pnpm db:generate`, preserve company keys/indexes, and verify latest migration snapshot. Do not hand-edit migration snapshots, rewrite historical run rows, weaken unique successors, or free all unreleased reservations with a blanket SQL update.

Native finalization ledger and provider attempts must remain unchanged by R1/R2. R3/R4 must preserve run pins as immutable admitted identity; a switch starts a separately authorized continuation, not mutation of the active admitted provider. Avoid changing task status just to make a queued recovery visible.

## 6. Fresh verification results and executable commands

### 6.1 Commands run here

Tests used a disposable root `/tmp/paperclip-runtime-audit-20261004-6ZwWys`; each embedded Postgres fixture allocates its own random nonreserved port and temporary database. The command's literal PATH selects Linux Node24/pnpm. No production database URL was consumed by these fixture suites.

```sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/usr/local/bin:/usr/bin:/bin CUDA_VISIBLE_DEVICES= NODE_ENV=test PAPERCLIP_HOME=/tmp/paperclip-runtime-audit-20261004-6ZwWys/h PAPERCLIP_CONFIG=/tmp/paperclip-runtime-audit-20261004-6ZwWys/h/config.json PAPERCLIP_INSTANCE_ID=runtime-audit-20261004 pnpm exec vitest run --project @paperclipai/server --no-file-parallelism --maxWorkers=1 server/src/__tests__/agent-quota-fallback.test.ts server/src/__tests__/heartbeat-agent-concurrency.test.ts server/src/__tests__/heartbeat-retry-scheduling.test.ts server/src/__tests__/heartbeat-dependency-scheduling.test.ts
```

Fresh result: **4 files passed, 97 tests passed**, exit 0; 125.54 seconds. Existing mechanisms passed their relevant tests. This does not prove R2–R6 acceptance gaps absent.

Second focused command:

```sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/usr/local/bin:/usr/bin:/bin CUDA_VISIBLE_DEVICES= NODE_ENV=test PAPERCLIP_HOME=/tmp/paperclip-runtime-audit-20261004-6ZwWys/h PAPERCLIP_CONFIG=/tmp/paperclip-runtime-audit-20261004-6ZwWys/h/config.json PAPERCLIP_INSTANCE_ID=runtime-audit-20261004 pnpm exec vitest run --project @paperclipai/server --no-file-parallelism --maxWorkers=1 server/src/services/native-runtime/native-restart-recovery.test.ts server/src/services/legacy-execution-recovery.test.ts server/src/services/execution-recovery-attempt.test.ts server/src/services/hot-restart.test.ts
```

Fresh result: **4 files passed, 52 tests passed**, exit 0; 6.19 seconds. These are controller/hot-restart unit characterization, not a real restarted server acceptance. Combined focused result is **8 files / 149 tests passed**; the engine reproduction is separate diagnostic evidence.

Historical server-wide result **37 failed / 15,050 passed** belongs to an earlier run and was not rerun here. Do not call it the current result or erase it because focused tests pass.

### 6.2 Next Agent test commands

Create a new disposable root before rerunning. Do not reuse the audit's literal temporary path or rely on host config discovery. Run from repository root; replace only the explicitly supplied unique test paths/instance token:

```sh
rtk proxy mktemp -d /tmp/paperclip-runtime-verification-XXXXXX
```

Use that returned directory as the literal `PAPERCLIP_HOME` and point `PAPERCLIP_CONFIG` inside it. Add any new test files to the focused command after they exist. Further relevant existing gates:

```sh
rtk proxy env PATH=/home/dains/.paperclip/runtime/node-v24.21.0/bin:/usr/local/bin:/usr/bin:/bin CUDA_VISIBLE_DEVICES= NODE_ENV=test PAPERCLIP_HOME=/tmp/paperclip-runtime-verification/h PAPERCLIP_CONFIG=/tmp/paperclip-runtime-verification/h/config.json PAPERCLIP_INSTANCE_ID=runtime-verification pnpm exec vitest run --project @paperclipai/server --no-file-parallelism --maxWorkers=1 server/src/__tests__/heartbeat-start-lock.test.ts server/src/__tests__/heartbeat-stale-queue-invalidation.test.ts server/src/__tests__/heartbeat-task-drain-admission-release.test.ts server/src/__tests__/heartbeat-archived-company-guard.test.ts server/src/services/issue-dependency-wakeups.test.ts
```

The `/tmp/paperclip-runtime-verification` shown in that command is a command example; substitute the returned unique directory before executing. For code handoff, use the same isolated environment and run repository required `pnpm -r typecheck`, `pnpm test:run`, `pnpm build`. These broad commands were **not run in this audit**. Do not suppress test failures or add broad type ignores.

## 7. Real isolated acceptance before production

Create a new isolated Paperclip state root and separate free API port. Use synthetic company/issues, synthetic files, mock provider binaries and a credential-free process adapter. Do not clone the production database into a running scheduler. Disable automatic real provider probing in the test config, then inject deterministic quota outcomes through the test adapter/harness. Start Node24 with the correct explicit config; verify health reports the intended port/root/version before creating work.

Acceptance is an evidence package, not a test count. Record boot ID, company/task/run IDs, predecessor/successor, session identity, admitted engine/model/account fingerprint, wake receipt, effect receipt, process identity, finalization state, capacity release, and timing; use synthetic content only.

| Scenario | Required observation |
|---|---|
| Capacity limit six, seven workers | Exactly six physical owners; seventh keeps one queued run. Cancel status alone does not start seventh. After exact old process/group stop and release receipt, seventh starts once. |
| Primary quota, backup quota, primary recovery | Preserve saved files/conversation. Failed primary and backup runs remain immutable. Matching recovered scope resumes every eligible issue once; account/engine mismatch does not recover it. |
| Recovered scope while company/Agent paused | Probe and dispatch remain blocked. After authorized resume, current durable intent advances once; no manual blocker/approval/budget mutation. |
| Project hard stop and manual blocker | A positive primary probe cannot change those holds. Typed dependency resolution wakes only when all blockers clear; a comment cannot do so. |
| Two companies in one shared pool | One busy company cannot monopolize released admissions. New high-priority arrivals cannot indefinitely bypass older aged eligible work. |
| Inject recovery phase error/slow owner | Healthy independent reconciliation continues; one physical recovery cycle owner; no duplicate wake/effect. Draining waits for physical owner, not only a logical timeout. |
| Native live runner, hot restart | Same heartbeat/native/provider session identity reattached; controller generation advances; provider attempt does not increment for reattach; no second submitted provider turn. |
| Native dead controller/result-finalization race | Already durable result finalizes without new provider work. Replacement starts only on supported safe evidence; ambiguous checkpoint remains visible and blocked. |
| Legacy detached CLI, hot restart | Original run adopted or finalized while down. Preflight and shutdown snapshot agree; every original run classified; no lost run is ignored. |
| Legacy ACP, hot restart | ACP selectively drains, saved session/history preserved, bounded successor scheduled. Detached CLI sibling may still be adopted. No automatic tool replay. |
| Hard restart after commit before notification | Durable run/wake/token resumes; missing live event does not lose intent; repeated sweeps create no duplicate successor/effect. |
| PID reuse or foreign host PID | Wrong PID/namespace cannot grant stop/adoption authority; old stop receipt cannot apply to later launch. |
| Restore in sandbox | PostgreSQL journal/schema/function/trigger and uniqueness survive. Upload files, workspace files, encrypted key are separately restored. No scheduler starts until stale execution ownership and effect history are reconciled. |

For effect duplication, use a fake external service with an idempotency key and append-only effect ledger. Crash after it commits but before Paperclip receives acknowledgement; require outcome reconciliation rather than blind replay. Preserve both the external receipt and the Paperclip decision. A completed mock inference response alone is not proof of a business effect.

Existing credential-free real-process native restart suite is `server/src/services/native-runtime/native-runner-restart-recovery.integration.test.ts`; it requires runner binaries as described in `doc/DEVELOPING.md:1043`. Build those in the isolated setup, then run that exact suite with isolated home/config/instance. It was **not run here**. Run browser confirmation only for changed queue/status/health UI; verify waiting, resumed and held states on desktop/mobile through the real isolated API.

## 8. Deployment and rollback

1. Freeze reviewed source SHA and test evidence. Back up database, uploads, relevant workspaces, local encrypted key and config together without printing credentials. Confirm restore rehearsal in isolation; a recent backup file is insufficient.
2. Compare loaded `serverVersion` and process start with the intended build, not the mutable Git section in health. The current `e776`/`ce97` difference is expected evidence of distinct sources, not permission to restart.
3. Stage build before requesting restart. On the owned production instance only after explicit authorization, use the existing correlated hot-restart request and exact prior PID/start identity; never write an ad-hoc marker or kill processes based on name alone.
4. Native ownership recovery must finish before ordinary scheduler admission. ACP run drain and detached CLI adoption remain distinct. Keep embedded PostgreSQL available until snapshot/finalizer drain finishes.
5. Compare `hot-restart-report.json` to preflight and health: `lostRunIds` empty; every original run adopted or finalized while down; exact version installed; no duplicate active provider session. Any missing run remains a deployment failure.
6. Roll back code to the reviewed previous build if new probe identity/fairness/scheduler behavior fails. Keep additive metadata/receipts and migrations compatible; do not roll back by deleting run/wake/finalization history or restoring an older DB over live effects.
7. An older build must refuse or ignore new metadata without freeing still-owned capacity. If an older version cannot safely read new ownership data, use guarded pause/drain and supported recovery rather than unsafe downgrade.

Production rollout and rollback were **not executed**. Current business tasks remain running.

## 9. Field diagnosis runbook

### 9.1 Establish exact identity first

Read health, one company summary, the affected task's execution snapshot, exact run summary and events through authorized GET APIs. Keep account values, env, prompts, task bodies and secret URLs out of shared logs. Record company/run IDs privately; report anonymized platform cases externally.

```sh
rtk proxy curl --silent --fail http://127.0.0.1:3100/api/health
rtk proxy git rev-parse HEAD
```

Health version, Git HEAD, boot time and restart request are separate facts. Do not infer loaded fixes from an on-disk commit alone.

### 9.2 Queued without progress

1. Read current `executionStage`, `capacityWait`, `capacityGroup`, `capacityReleasedAt` and run status.
2. Check per-Agent, instance and group ceilings; group configuration missing/invalid is a genuine hold, not permission to remove the limit.
3. For terminal unreleased holders, require exact stop receipt/namespace/controller/native evidence. Never clear reservation because status says cancelled or PID lookup occurred on another host.
4. Check Agent/org invokability, company pause, project/Agent/company budget, task tree hold, dependencies, approval/interaction and operator Stop.
5. Verify a persistent next path: queued run, scheduled retry with due time, deferred wake, recovery token/action, typed external wait, or explicit owner escalation. A recent comment/live event is not that path.
6. If an eligible run remains behind repeated newer winners, capture admission sequence and age/priority for a fairness regression; do not increase concurrency just to hide the defect.

### 9.3 Provider quota or bad回切

1. Read the exact admitted run pin and provider error family/reset hint. Account auth error, unavailable, busy and quota remain distinct.
2. Inspect user/effective identity, fingerprint and `probeToken/probeUntil/recoveryToken`; do not print the book's account data into a public incident.
3. Confirm engine/environment/project/routine binding used by the probe is the one the task will execute. CLI hello cannot establish an ACP task's readiness.
4. Inspect durable successor and gate reason for every affected issue. Existing scheduled retry acceleration and latest-source retry are distinct paths.
5. If recovery token persists, find the failed continuation phase and verify its predecessor idempotency before retry. Do not clear the token manually or rotate Agent model to claim recovery.

### 9.4 Restart/process loss

Read hot-restart preflight/snapshot/report and native finalization ownership. Separate reattach, finalized-while-down, supported replacement, bounded legacy continuation, and blocked uncertainty. Inspect prior boot ID/PID/start/namespace, current controller generation, event cursor and provider attempt. An expired lease only permits fenced recovery work. Do not cancel healthy PM-like business roles or tasks to make a report clean.

### 9.5 DB/backup incident

Confirm schema journal, connection health, backup age/failure marker and storage/key backup set. Keep scheduler admission suppressed while restore or ownership reconciliation is uncertain. Restore into a sandbox first. Prove uniqueness and status-version triggers survived. Reconcile effects that happened after the chosen backup; replaying stale DB history can duplicate external actions even if all restored tests pass.

## 10. Handoff acceptance checklist

- [ ] New Agent reads exact source version and this audit before editing.
- [ ] R1 red test demonstrates wrong engine; fixed exact-path probe or explicit unsupported result passes.
- [ ] R2 tests prove one physical owner and independent phase failure isolation without bypassing stop/startup barriers.
- [ ] R3/R4 are implemented only after regression proves missing context scope or lost immediate continuation; migration/API choices documented.
- [ ] Fairness applies to every entrance and two controllers, with all pause/budget/approval/manual gates intact.
- [ ] Probe/deadline tests retain capacity until physical stop; no logical timeout frees active owner.
- [ ] Existing 97 focused tests stay green; controller/restart targeted evidence is separately recorded.
- [ ] Real isolated restart/quota/effect cases passed; provider model calls and production changes remain explicitly owned authorization steps.
- [ ] Required repository typecheck/test/build results, failures and unrun gates are recorded separately from this audit.
- [ ] Runtime reports use loaded build identity, durable progress and physical receipts; no business-specific model training/customer requirements enter this platform plan.

This audit supplies evidence and executable implementation boundaries. R1 is reproduced; R2 is source-proven; R3–R6 need the named regression/acceptance scenarios before claims of correction. Existing green tests, current health and a recent backup do not replace those gates.
