# Context, material progress and resource admission

Scope: PC-09/10/11 source slice on the full-delivery branch. This is implementation evidence, not a production or whole-project qualification claim.

## Behavior

- Resume context projects long plans to core constraints, current task and exact revision references. Original documents remain readable. A projection explicitly does not prove that a provider read a revision. `GET /api/issues/:id/documents/:key/revisions/:revisionId` returns bounded pages with `complete` and `nextOffset`.
- Provider prompt metrics record numeric plan source/resume/omitted character counts. No prompt, credential or filename is added to Telemetry. Character reduction is not a claimed token or billing saving.
- Material progress compares normalized document content, artifact identities/digests, dependency readiness and actual decision outcomes. Timestamps, revision IDs, comments, tool counts and mutable display approval alone cannot reset the rewake streak. Source snapshots remain company-scoped; incomplete samples prove no progress.
- Cost records may carry nullable `totalTokens`. Codex cached input is a subset; Claude cache reads/creation use the parser's own semantics. Existing input/cache/output counters and prices are preserved. Historical unknown totals are not inferred. Subscription zero billing does not mean zero resource usage.
- Optional `total_tokens` policies reuse existing company/agent/project budget admission, incidents and actual stop hooks. Billed-cent fields are changed only by billed-cent policies. Incomplete usage is shown explicitly and cannot bypass a configured token hard-stop. Known final run usage can be used if its cost-event publication was interrupted; missing usage remains unknown.
- Optional `executionPolicy.resourceLimits` supports task/subtree tokens, per-run reported tokens, cumulative automatic runs, consecutive no-progress runs and run wall seconds. Limits apply to descendants and survive role/run/client changes. Agents cannot remove the policy or reparent out of a limited subtree. New human input only resets no-progress admission, not lifetime tokens/attempts. Valid waits remain owned by the existing blocker/monitor workflow.
- A wall deadline aborts the original execution controller and retains its stop promise until that executor settles. It does not release physical capacity. Persisted run identity/deadline survives same-run resume. Model/engine/permissions stay unchanged.

## Boundaries still requiring integration

- Token ceilings act at reported usage boundaries; an in-flight provider may finish above a ceiling before usage arrives. Native continuous-goal streaming/control qualification is still required. Wall time provides a separate physical bound.
- Invocation checks alone do not serialize sibling admission. The runtime domain must recheck task resource admission under the existing capacity singleton/claim transaction.
- Current task resource controls reuse normal board-authorized mutation and preserve other execution-policy keys when changing monitors. Independent delivery authority (PC-03) is a separate pending domain stage.
- Real browser flows, 10-turn adapter measurement, full suite/build, independent review, real Agent sample and production deployment are pending. No default instance, business Agent, configuration or GPU job changed here.

## Fresh verification

Node24.21.0; own worktree dependencies; unset external database URLs; isolated PAPERCLIP state; temporary PostgreSQL fixtures.

- RED: long resume plan still included unrelated100KB payload; comment/activity/tool-only runs reported `advanced`; ordinary comment reset the actual DB rewake streak; pinned revision reader absent.
- GREEN: context/documents/liveness/throttle/material observer focused5-file74 tests.
- RED: normalized total counters absent and subscription token ceiling did not block.
- GREEN: token accounting + budgets2-file11 tests; token budget component2; normalized UI total helper2.
- RED: resource leaf absent; PG aggregate subquery invalid; Agent reparent escaped its ancestor cap; completed run without usage was counted as known zero.
- GREEN: resource pure/integration2-file10 tests, including restart/client changes, descendants, real new user input, policy deletion/reparent denial, missing-usage preservation and deferred deadline stop.
- Final combined source slice:9 server files95 tests passed (73.35s);2 UI files4 tests passed. Server direct `tsc --noEmit`, latest UI typecheck, token gates and `git diff --check` passed.

These are scoped results; no global completion claim follows from them.
# Integrated follow-up qualification

The 2026-10-04 follow-up adds six real PostgreSQL budget regressions: company,
agent and project pauses survive a raise or disable of another exhausted metric;
unknown token usage keeps its hold; manually paused company/project scopes keep
their original pause reason through budget exhaustion and a later raise. The
first run reproduced all six failures. All fourteen budget tests subsequently
passed in the combined integration run.

An actual Node child was launched by a registered test adapter through the normal
heartbeat admission/controller path. A two-second task deadline stopped that
owned child. A second Agent stayed queued until the child closed and the first
adapter's held log drain finished. The RED run exposed a generic cancelled
reason and missing resource metadata. The fix retains the resource stop cause,
owner and deadline granularity in result metadata, independently of usage
availability. The existing twenty-four capacity tests passed before the final
observation addition; the final physical-deadline case passed after it.

Final run observations now retain execution liveness separately from material
progress, with the observed content fingerprint and next owner. The observer
locks the run and writes an advance event once per observed fingerprint. The
presentation projection previously replaced this newly saved metadata using a
stale result object; the physical integration reproduced that loss even after
capacity release. Presentation now merges its own field into the current DB
result. The regression checks the observation after physical release.

Run-ledger copy displays material change, unchanged work or awaiting verification
separately from run success, plus resource stop reasons. The new labels and
resource controls use the Chinese/English locale catalogs. Twenty-eight ledger
and locale tests passed; UI/server typechecks and token gates passed. The Chinese
pixel office retains preparing/confirming as waiting states.

CEO/CTO/QA bundled templates and onboarding state the minimal responsibility
graph and actual-artifact handoff rules. The generated teams manifest, four team
validations and ten catalog tests passed. Existing business Agent instructions
were not rewritten.

These are scoped implementation results. Whole-source review, full repository
checks, integrated browser/provider qualification, the real-Agent application,
controlled default deployment and rollback remain separate required gates.

The first actual isolated ACP preflight exposed an additional API boundary:
`normalizeIssueExecutionPolicy` discarded a resource-only policy and omitted
resources from a reviewed policy. The ordinary HTTP child-create regression
reproduced `executionPolicy: null` despite submitted limits. Both normalizer
regressions and the HTTP regression were RED before retaining resource limits
in normalization and the empty-policy guard. All three policy/service/routes
files then passed99 tests; direct server typecheck passed. Fixture admission
will be rechecked on a refreshed isolated server before application execution.

That preflight also omitted the existing nonsecret CODEX_PATH binding, invoking
the bundled0.153.4 instead of configured0.160.0. The owned provider rollout
reported the exact unsupported-model400 and actualmodel/effort. Three failed
preflight runs were retained; the isolated Engineer was paused for diagnosis.
The four fixture Agent profiles now retain the original ACP/model/effort and
explicit configured binary path. No application code or production config was
modified by those preflights. Executable/auth-file readiness alone was not
treated as successful provider invocation.

Verified delivery now connects to ordinary task execution and the task page.
Fresh and resumed provider task briefs retain the current criterion states and
the assessment/decision API references, so independent QA can inspect real
material, submit current content pins, then use the existing typed review
handoff. Ordinary tasks retain their current completion policy. The task page
uses server permissions, refreshes on material/decision events, and reports a
stale decision failure before requesting current authority again.

The material observer includes the latest durable independent verdict for each
criterion, including its criterion/content/material pins. Repeated acceptance
of identical material and changed review narration do not reset no-progress
limits. A new criterion or a changed authoritative verdict does count. These
integration regressions passed107 tests across four files; UI/server typecheck
and the token gates passed. Serial schema migration, final review and the real
Agent application qualification remain pending.
