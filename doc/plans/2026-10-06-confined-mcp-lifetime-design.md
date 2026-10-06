# Confined MCP lifetime correction — design for review

Status: proposal only. No production implementation, connection publication,
dependency upgrade or new employee dispatch is authorized by this document.

## Required outcome and preserved constraints

Actual employee MCP calls must complete under their existing authorized request
and run budgets, with the original Polaris directory protected. A shared host
daemon must not interpret namespace-local PID2 as host process identity. Real
process reuse, cancellation and cleanup must have inspectable evidence. Retain
company/employee/run boundaries, frozen execution profiles, tool grants, source
write denial, original failures and spent usage. No sandbox disable, PID trust
shortcut, global timeout increase, hidden warm-up or model/provider replay.

## Evidence and current call path

The observed CodeGraph proxy publishes namespace-local `process.pid`, while the
host daemon's `peerIsDead` uses the host PID namespace. A correlated live client
was reaped as PID2. Direct mode prevents that dependency-daemon mistake but still
exceeds the unchanged 10-second request budget during local engine computation.
It is not a complete fix. The broad query also sometimes completes in8.222seconds;
precise-query success and a single broad success do not establish reliability.

`tool-gateway.ts::callLocalStdioMcp` resolves the frozen local run/saved Test
profile and routes read-only calls through `callGovernedStdio`. That function
creates, initializes and stops a confined process for every request.
`tool-runtime-supervisor.ts::useConnectionSlot` persists an idle/reusable slot but
the callback's process is already gone; Stop/idle expiry currently only update
rows. Thus slot reuse is not engine reuse. Existing connection keys are company/
connection-scoped, which is too broad for a future process holding run-specific
source, profile, credentials or tool grants.

## Options and recommendation

| Option | Effect | Limit |
| --- | --- | --- |
| Namespace-aware upstream daemon transport | Keep existing daemon warm while authenticating the actual peer identity correctly | Requires dependency support/versioned protocol; current installation cannot be silently patched or upgraded |
| Paperclip-owned confined run-scoped stdio lifetime | Keep one real protected process for matching requests, reuse existing slot limits/audits and tie teardown to the run | Changes lifecycle interfaces and needs durable cleanup and real Stop verification |
| Publish direct mode only | Avoid host daemon's namespace PID check | Already fails the same cold-query budget; rejected as complete delivery |

Recommended implementation direction: Paperclip-owned run-scoped lifetime, using
the existing supervisor and profile contracts. Keep the upstream option open if a
reviewed dependency implementation meets the same containment/exit acceptance.

## Runtime identity and admission

Process reuse key must include company, agent, run or exact owned Test session,
connection, approved template/argument hash, physical source root, frozen profile,
environment/credential version and sandbox/network capability. Store hashes and
references, never secret values. Never share across companies, employees, runs,
workspace bindings, profile revisions or revoked grants.

Allow the initial lifecycle extension only for approved local-stdio read-only
tools and host-verified local profiles. Writable/destructive/unknown transports
retain their current conservative path. This bounds rollout, not the definition
of successful CodeGraph delivery. Reject unsupported lifetime configurations
explicitly; do not silently choose another executable or directory.

## Real process, requests and budgets

Each slot generation must represent an actual protected process and host-captured
identity. Initialize once; correlate every JSON-RPC request ID and response.
Serialize requests within a lifetime unless multiplexing is independently proven.
Current company/host slot limits and restart-storm controls remain.

First request, setup and any preparatory work must remain inside explicit
authorized budgets and be recorded. A startup exceeding the budget remains a
failure. Do not hide an expensive query under readiness or retry it automatically.
Timeout aborts the affected request/lifetime with actual cleanup; no late response
may satisfy a later request or another generation. Subsequent same-key requests
reuse the verified process, not a database flag.

The CodeGraph-specific direct-mode opt-out must be an approved template capability,
not an arbitrary user env override. Validate it with the same execute/config
restrictions; it does not change file/PID/network containment or host identity.

## Stop, revoke, expiry and crash

Existing slot controls, session revocation, run completion/reassignment/cancel,
environment expiry and service shutdown must drain the actual owned MCP process
before marking its generation stopped/released. Persist a matching, complete
namespace/launch exit receipt; parent exit or an old process-group record alone is
insufficient. Failure keeps an explicit cleanup hold and blocks reuse/admission.

Startup reconciliation must inspect orphan process/namespace identity without
fabricating status or deleting history. Do not adopt a process whose authority,
template, source or secret revision cannot be revalidated. Database/session rows
must not be deleted before cleanup authority is preserved. Test-tab lifetimes are
independently owned and must not inherit employee run credentials or cache.

## Expected source responsibility

- `server/src/services/governed-stdio.ts`: explicit protected lifecycle handle,
  request correlation, timeout/output bounds and verified drain.
- `server/src/services/tool-runtime-supervisor.ts`: real generation ownership,
  limits, stop/expiry/shutdown/reconciliation and truthful slot state.
- `server/src/services/tool-gateway.ts`: frozen reuse key, current authorization
  rechecks, revocation hooks and approved template capability.
- Heartbeat/application lifecycle: invoke MCP drain at existing run finalization/
  cancellation and service shutdown boundaries before release.
- Shared/DB/UI contracts only where the reviewed design introduces durable
  identity/receipt or an operator-visible state. Keep schemas/API synchronized.

Exact fields and hook signatures belong in the implementation plan after design
review; do not introduce a parallel generic session or ownership system.

## Acceptance matrix

1. Original broad CodeGraph query and precise controls under the same deadline,
   with actual process identity and phase timings; record every failure.
2. Two matching calls share the same live process/generation; different run,
   employee, company, source/profile/secret revision do not share it.
3. Actual source write is physically denied while another employee writer owns
   the original checkout. No permission or root change is used for performance.
4. Public Stop, revoke, idle expiry, reassignment, run deadline and shutdown kill
   actual descendants; verified namespace drain precedes release.
5. Stop/timeout races, late/wrong JSON-RPC IDs, output overflow, malformed responses,
   partial startup and controller loss do not cause stale delivery or false release.
6. Same original workspace supports the next actual protected employee dispatch
   after cleanup. Root independently accepts both execution and report/source effect.
7. Cold first-call failures are not hidden by a pre-warmed/easier fixture; all
   budgets/old failures/counters and unsupported modes remain inspectable.

The design is not accepted merely because the tests or a warm exact query pass.
It must satisfy the original broad request and complete lifecycle acceptance.
