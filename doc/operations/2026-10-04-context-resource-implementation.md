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
