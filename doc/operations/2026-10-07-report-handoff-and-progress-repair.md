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
Protected shared Codex workspaces retain their explicit CLI-engine requirement.
For an employee without that setting, declare
`assigneeAdapterOverrides.adapterConfig.engine: "cli"` on the task; auto/ACP
lifetime is not admitted. This changes neither its model nor sandbox protection.

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
The product card opens validated, same-task workspace references in the existing
file viewer with the exact project/execution-workspace selector. Ordinary URL and
attachment/media actions retain their previous behavior.
If the experimental workspace viewer is disabled, a report opens in a bounded
dialog using the same protected reader and content renderer. Long text scrolls
inside that dialog; its header and close action remain on screen. The instance
experimental setting is not changed.

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

### Actual employee and browser acceptance

- POL-25 source run `f2fcde63-a5d5-49cb-b56e-d2db3721fd45`: `succeeded`,
  liveness `advanced`, original Polaris directory and protected CLI execution.
  The employee wrote only two synthetic reports; no product tests or source
  acceptance were requested.
- The controller registered exactly two `ready_for_review` /
  `needs_board_review` products from that source run and entered the configured
  `local-board` review stage without another recovery action. Both current file
  hashes matched their submitted metadata.
- The source write owner and environment lease were released; the actual
  process namespace was independently confirmed drained with its exit receipt.
  Board accepted this qualification through the normal typed review transition:
  task `done`, execution state `completed`, outcome `approved`.
- Edge 154 browser clicks opened the new Markdown report and POL-23's original
  11,747-byte / 311-line JSON in their exact execution workspaces. Returned hashes
  matched the originals; the long JSON scrolled to the final line with its
  header/close action visible. There were no browser page errors; the owned Edge
  processes were closed. The experimental viewer setting stayed `false`.
- A preceding config-only attempt, POL-24, was rejected before model startup
  because the employee did not declare `engine=cli`. Its failed run and resource
  history remain. That attempt was intentionally cancelled through public
  governance APIs; it is not counted as a successful qualification.

### Historical disposition and deployment

The original POL-23 report and all 358 manifest entries were independently
verified. Its write lease and real namespace were already safely released.
Recovery action `c14cf7ad-763f-4c32-b8cd-d180f3f4cb42` was formally resolved as
`false_positive`, completing only the review/report task. Original runs, limits
and adverse findings remain. POL-22 stays `blocked`; `QA-COMPOSE-MULTISPEC` and
`QA-TYPED-SPEC-COLLAPSE` are still unaccepted source defects. Board manually
registered the existing report originals as work products with
`manualReportReview.sourceAccepted: false`, without inventing a historical
controller baseline or output seal. Six relevant source files still match their
pre-qualification hashes; no Polaris code change was performed.

Implementation is on `main`. The local default3100 instance loads
`2026.916.1+180.git.39d6b00cc`, startup recovery `ready`. Its config hash,
employee model/adapter/runtime settings and disabled wakes are preserved. The
final hot-restart report has no adopted/lost/skipped runs, and a fresh whole-
instance check found no active or pending work.

Cold rollback storage is
`~/.paperclip/backups/report-handoff-20261007T0514`: 23,746 fresh entries /
3,940,018,976 bytes, plus 160 individually SHA-verified archive references /
22,964,136,606 bytes retained in the earlier complete
`stale-wake-20261006T172910Z` backup. The database was stopped during the cold
copy. New manifest SHA-256:
`4b4506595ee4309fc5f6f1d7259250073569269e755ab22b8a80fe6ee26f092f`.
These archive references are an incremental backup, not a new full copy of all
old archives. Originals remain under
`~/.paperclip/diagnostics/report-handoff-20261007/`.

The user's latest maintenance rule is recorded in `AGENTS.md`: future edits
stay directly on `main`, followed by validation, commits and local service
updates; no new maintenance branches/worktrees/code copies.

### Verification ledger

| Check | Result |
| --- | --- |
| Repository `pnpm -r typecheck` and `pnpm build` | Both passed after the report/native/dispatch repair; the subsequent UI-only change passed its full UI typecheck/build and final server build stamp |
| General server group | Completed 683 files / 13,018 cases: initially 672 files and 12,943 cases passed, 6 files / 11 cases failed, 5 files / 64 cases skipped; all six failed files have complete passing rechecks |
| Serialized server coverage | 148/148 declared files, 2,708 tests passed, using the latest complete passing run of each file |
| Shared workspace project | 809 tests passed |
| Skills catalog project | 20 tests passed |
| Database project | 147 initially passed; the timed-out client file was fully rechecked, 19/19 passed, preserving the other 129 tests |
| CLI project | 485 tests passed |
| UI project | 6,430 initially passed; the single timed-out retry-supersession file was fully rechecked, 1/1 passed |
| Remaining adapter/plugin projects | All nine official groups passed: 2,547 tests passed, 13 preconfigured tests skipped; their existing skip conditions were not overridden |
| Final report-card/Markdown-artifact/selector files on `main` | 30/30 tests passed, including the experimental viewer being disabled |
| UI token gates | All four gates clean |
| Actual bounded employee and browser | POL-25 source, typed human review, two unchanged report hashes, namespace exit, short Markdown and long JSON preview passed |
| Independent code review | No remaining blockers after the native CAS, notification guard, exact file binding and dialog scrolling corrections |

The original monolithic run began before the final corrections. Its general
server invocation finished in 6,547.77 seconds with exit 1; its initial failures
and later complete-file rechecks are retained separately. The six files are file
resources (36 passing cases), comment batching (30), bounded retry (113), stale
enqueue admission (32), report delivery (25), and the Postgres dispatch adapter
(50). No failed file remains without a complete passing recheck. The already
verified groups, existing configured skips and final UI checks are preserved;
thresholds and assertions were not relaxed. This is aggregate verification,
not a claim that one frozen-source monolithic invocation was all green.

Implementation and the direct-main maintenance rule were pushed as
`39d6b00cc`. The final acceptance-document commit is separate from the loaded
code version; documentation-only changes do not require another service reload.
