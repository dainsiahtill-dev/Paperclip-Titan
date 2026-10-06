# Terminal active-owner closure review

Read-only narrow review of service/test/CLI-help diff against HEAD `23ff8dd0c92fc26c20306005eef76c11c14e3a20`. No live/provider actions, source edits, test execution, process signals, or database operations performed by reviewer.

## Assessment

No blocking correctness finding.

- `server/src/services/workspace-namespace-closure.ts:45`: admitting `active` alongside `unknown` expands recoverable journal states only. Run must already be terminal under `FOR SHARE`; exact owner/generation/launch/source, original guard provenance, resolved leases, same boot/observer namespaces, and absence of prior receipt/release remain mandatory.
- Initial close still requires unchanged inspection digest, two actual namespace-drain observations during close, and final source identity recheck before release. An active owner beside a logically terminal but physically live run still fails drain verification.
- Existing lock order and owner `FOR UPDATE` stay unchanged. No new handles, resource-cleanup paths, run-state writes, event mutations, history deletion, task dispatch, or process-control actions introduced.
- `server/src/__tests__/workspace-namespace-closure.test.ts:77`: new positive fixture launches a real guarded process and suppresses final controller journals, rather than rewriting owner state to fabricate the condition. Live-namespace refusal now runs for both `active` and `unknown` owner states.
- `scripts/workspace-legacy-closure.ts:15`: help accurately names guarded owners of terminal runs and retains existing maintenance restrictions.

## Verification inspected

- `git diff --check`: clean.
- `terminal-active-closure-red.json`: 11 passed/one failed; new active-owner recovery case fails before service change.
- `terminal-active-closure-green.json`: 15 passed, zero failed/skipped; namespace 13 plus CLI 2, including still-live active-owner refusal.
- Existing preservation/idempotence/identity-drift tests remain. No test assertions removed to admit the new case.

## Declined to judge

- Actual maintenance closure/deployment and interrupted product-run disposition: reserved to root, outside read-only source review. This assessment neither resumes old product tests nor qualifies live delivery.

## Reviewed source SHA256

```json
{
  "scripts/workspace-legacy-closure.ts": "92e1e5617d57a557f3946e519805c1b98e7056e6808f0afd9cb0f5727efdb743",
  "server/src/__tests__/workspace-namespace-closure.test.ts": "c1fc802368a478aa13a9a63dfadcb905b0e60b6a697ad7fbebf726aef96734f7",
  "server/src/services/workspace-namespace-closure.ts": "fcc4efbaff10420bdf6fb467b786a6c53fb6f7fc3daf6a1550e42ad808fc0fbe"
}
```

## Follow-up: reaper controller-ID reconciliation

No unsafe-release defect found in closure-only fallback at `server/src/services/workspace-namespace-closure.ts:37`. It applies only after ordinary provenance fails for a terminal `failed`/`process_lost` run, selects latest exact company/agent/run host-system identity event excluding imported source events, validates original controller UUID, and changes only a non-persisted controller-ID view passed to unchanged provenance validation. PID/group/start, owner generation/launch/source, host namespace identity, leases, digest and double actual drain remain mandatory. Original run row is neither restored nor rewritten. Run lock also serializes ordinary event appenders across both provenance reads.

Previously important admission limitation, now resolved below — `server/src/services/workspace-owner-provenance.ts:56` and `server/src/services/workspace-write-ownership.ts:125`: earlier closure-only fallback left future ordinary claims comparing released owners against overwritten run controller ID. Historical local-lease scanning still returned `busy`. This was an admission gap, separate from closure drain safety.

Tests inspected: `reaper-controller-closure-red.json` retains 13 passed/one failed; `reaper-controller-closure-green.json` has 19 passed/zero failed (namespace 17, CLI 2). Positive case preserves exact reaper-mutated run row; negatives reject non-`process_lost`, changed event PID and malformed controller UUID. Tests currently establish formal release, not subsequent claim admission. `git diff --check` remains clean. No live actions or tests executed by reviewer.

Follow-up source SHA256:

```json
{
  "server/src/__tests__/workspace-namespace-closure.test.ts": "cec4b0eee0b245f5b368e5dcf2e483d5c9886311c90d0cc842404e9458ea5998",
  "server/src/services/workspace-namespace-closure.ts": "3e5dbb79d52ac4d32801ce6c43727667c0a416abb949472abdfb696def8ce0a8"
}
```

## Follow-up: durable controller proof restores ordinary admission

No remaining blocking correctness finding in inspected admission fix.

`workspace-namespace-closure.ts:86` persists the authenticated original controller ID in both operator receipt and matching drain journal, without modifying failed run fields. `workspace-owner-provenance.ts:73` uses that ID only for a fully durable released drain of a `failed`/`process_lost` source, `local_operator` verification, a 64-hex input digest, a valid controller UUID, and exact generation/launch/digest/controller journal agreement. Unchanged latest host-event, company/agent/run, PID/group/start, namespace, timing/binding and physical-source checks still apply. Live/unknown owners gain no controller exception or release authority. `legacy-workspace-closure.ts:84` synchronizes its candidate projection with the private tracked-run status/error-code contract.

Real guarded fixture now includes a released historical local lease and checks that the next ordinary owner claim succeeds after formal closure while the failed run remains unchanged. Four corruption cases (original controller, digest, journal, verification) retain `busy`; existing live-namespace refusal remains.

Inspected evidence: `reconciled-source-admission-red.json` has 16 passed/one failed on the new post-close claim; `reconciled-source-admission-green.json` has 48 passed; `reconciled-source-admission-final.json` has 52 passed/zero failed/skipped across namespace 21, ownership 17, legacy closure 12 and CLI 2. `git diff --check` clean. Server typecheck was running when assigned; reviewer did not execute or claim its result. No live/provider actions or source edits performed.

Latest reviewed source SHA256:

```json
{
  "server/src/__tests__/workspace-namespace-closure.test.ts": "a23e54b701a2f648c1ef224b4a3616371c2eb0e825a096e756ef7cf7a2c1dd60",
  "server/src/services/legacy-workspace-closure.ts": "b4517ea46cef773d3a86b749fbc6e3f49dce047c64bf63fe8ff2f9506ebe913b",
  "server/src/services/workspace-namespace-closure.ts": "ec24b727b015774a15d5896d2abee5f921661aa047e6f34f68ed88aa4a3f6165",
  "server/src/services/workspace-owner-provenance.ts": "f76a961f972ad784014a8cb90b52da16addd6c689f13f53c332743fd9fe809bd"
}
```
