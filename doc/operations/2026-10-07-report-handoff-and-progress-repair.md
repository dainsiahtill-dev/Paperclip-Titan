# Report handoff and progress diagnosis repair

## Incident and scope

POL-23 run `ab4cd43c-50ac-487f-b435-ae20444bcc85` succeeded and wrote its
independent-review report. Its instructions prohibited API/status/handoff
writes and required Root to dispose of the work. The issue remained
`in_progress`, with `maxNoProgressRuns: 1`. The material observer saw only
database documents/work products/decisions/dependencies, not the unregistered
local reports. It classified the run `needs_followup`; resource admission
treated that missing proof as verified no progress and created board recovery
action `c14cf7ad-763f-4c32-b8cd-d180f3f4cb42`.

This repair addresses report-only delivery, truthful progress classification,
review handoff and recoverable notification. A submitted adverse review is a
completed report, not a successful source implementation or project delivery.
Limits, billing history, original runs and independent review authority remain.

## Contract

A board-authorized task can declare locally observed reports using the existing
execution policy and review stages:

```json
{
  "mode": "normal",
  "commentRequired": true,
  "resourceLimits": { "maxNoProgressRuns": 1, "maxAutomaticRuns": 1 },
  "reportDelivery": {
    "version": 1,
    "files": ["reports/REPORT.md", "reports/REPORT.json"]
  },
  "stages": [
    { "type": "review", "participants": [{ "type": "user", "userId": "local-board" }] }
  ]
}
```

The reviewer must be a real eligible principal in the company. Ordinary tasks
and existing artifact publication require no new reporting contract. Executors
cannot create, replace or remove controller-observed report contracts. Native
and remote artifact publication retain their existing authority; this observer
requires a locally readable bound workspace and does not grant filesystem write
access or disable a sandbox.

The controller captures report hashes after acquiring the physical source lane
and before provider dispatch. It pins company, task, source run, actual run
workspace, directory identity, configured paths and review contract. Local Git
worktrees remain supported. Same-run recovery retains the original baseline.
Active reviewer/approver runs consume existing reports without a production
baseline or an instruction to rewrite them.
Completed-task notifications to a different employee also consume existing
context. Only a company/comment/author-bound mention receipt can use that
notification path; it does not reopen the task or resume its original executor.
An explicit source status/assignee guard is checked first under the enqueue lock,
so a completion racing recovery preserves its original guard-mismatch evidence.

Every required final output must be nonempty and changed from its baseline.
Missing/old/partial/mixed-freshness reports, symlinks, hardlinks, invalid UTF-8,
oversized or unstable reads fail closed. Existing secret/path gates and the
confined native file reader are reused. Known empty placeholders are valid
baselines, but empty final outputs are not delivery.

At the successful workspace-finalization boundary, the controller seals exact
output hashes before terminal success is committed. After runtime cleanup, while
the source's guarded lane is still reserved, a task/run-locked transaction
registers unapproved work products and enters the configured review stage.
Native finalization mediates this declaration through the existing execution
stage authority; missing proof remains explicitly unverified, never `done`.
Native unprotected ownership history is preserved and is not converted into
namespace exit proof.

Agent-review wake intent is stored in the same transaction. The existing durable
status-wake dispatcher promotes it with its truthful report source, stage guard
and idempotency identity. It retains pause, disabled-wake and resource gates.
Startup/stranded reconciliation can complete a terminal source's pending report
from its host seal without another provider call. It cannot invent a new seal
after source ownership was released. Changed bytes, later runs/decisions and
changed ownership/configuration are rejected. Background observation is bounded
and preserves an explicit next action rather than repeatedly creating work.

Report products use the public work-product schema and exact workspace file
references. Opening a report resolves the pinned execution workspace, even after
a newer reviewer workspace exists. Company/project/task/source bindings and
controller-authored product evidence are enforced; caller-created product rows
cannot grant access to another execution workspace.

## Resource semantics

- Confirmed unchanged observations consume the configured no-progress limit.
- Missing/unknown observations produce `issue_progress_unverified` at the same
  bounded threshold. They do not claim that work was absent or request a larger
  limit. The owner must inspect preserved outputs and record a truthful path.
- Productive material, terminal scope and real waiting paths retain existing
  behavior. New human input does not reset lifetime automatic attempts or tokens.
- Provider JSON cannot supply controller `workObservation` or report-observation
  authority. Host activity seals, not model prose or mutable flags, own delivery.

## Verification and delivery

Regression evidence covers safe declaration/schema roundtrips, real file/DB
submission, adverse findings, empty/missing/unchanged/stale inputs, forged markers,
company/owner/workspace/decision changes, crash recovery, durable review intent,
exact public file opening, legacy execution and native initial finalization.
The source/project's acceptance is assessed separately.

Final check results, live qualification, historical recovery disposition and
loaded deployment identity will be recorded after their respective checks.
