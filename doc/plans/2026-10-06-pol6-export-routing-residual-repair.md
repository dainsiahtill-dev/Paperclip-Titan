# POL-6 bounded export-routing correction — 2026-10-06

Status: authorized remaining product work after actual Paperclip execution and
independent review of run `161b94e3`. Framework fixes are deployed at `fd35ea339`.
This plan does not authorize root to edit Polaris source directly.

## Evidence and intended behavior

The existing public unique-export Plan redirects a used default/named import to
a module with only the named export. A comment containing an export-shaped token
is also accepted as a real export. Named-only, missing/ambiguous candidates and
canonical importer routing already have useful behavior and must be preserved.

A candidate must satisfy every used imported binding before the whole import
specifier changes. Export evidence must come from executable declaration syntax,
not comments, strings or templates. Reuse the existing syntax helpers. If a form
cannot be proven, refuse the proposal rather than inventing an export. Do not
claim module/runtime completeness from shadow planning alone.

## Ownership and allowed files

The original Paperclip POL-6 employee implements in the sole existing Polaris
checkout `/home/dains/Documents/polaris`. Allowed source files:

- `src/backend/polaris/cells/director/runtime/internal/repair_kernel/typescript_syntax/imports_exports.py`
- `src/backend/polaris/cells/director/runtime/internal/repair_kernel/typescript_syntax/common/import_text_ops.py`

Allowed new regression test:
`src/backend/polaris/cells/director/runtime/tests/test_unique_export_binding_frontier.py`.
Engineering reports/checkpoints belong under
`.superpowers/sdd/2026-10-06-paperclip-repair-frontier/export-binding-repair/`.

Keep all other files read-only, including the accepted dirty diagnostic/provenance
fix, old test assertions and reports, generated Bench targets, path contracts,
Factory, owner/QA/runtime/provider/security configuration. No branch/worktree/code
copy, commit, install, service, Bench, external provider or subsidiary agent.
No source changes outside the allowlist without a new root decision.

## Implementation and verification

1. Reuse the accepted validation evidence and previous context. Confirm exact
   source identity and use `.venv/bin/python` (CPython 3.13.12), RTK, UTF-8,
   `PYTHONPATH=src/backend`, `PYTHONDONTWRITEBYTECODE=1`.
2. Write real public normalize/Plan/probe regressions before implementation.
   Observe the used-default-without-default-export and comment/string/template
   false-export failures. Include valid mixed bindings with a real default export,
   valid named/aliased exports, missing/ambiguous refusal and canonical typed/raw
   importer preservation. Keep fixtures generic and in memory.
3. Make the minimal two-file correction. Keep input DTOs unchanged and retain
   the public effect authorization/path gate. Do not lower or rewrite existing
   assertions or replace real APIs with mocks/private-only checks.
4. Run the complete new regression file, relevant existing import/materialization
   and diagnostic routing suites, scoped Ruff and mypy; preserve commands, exits
   and source hashes. Report broader baseline findings by name if observed.
5. Checkpoint RED/GREEN before spending remaining time on reports. Stop with
   precise evidence on a real tool/environment failure; no blind automatic retry.
   Root independently inspects the diff and tests before acceptance.

One bounded 600-second implementation allowance; historical usage and results
remain. Malformed-path ValueError behavior, truncated prior B probe/string proof,
TS5110, B1/B6, real effects and fresh Bench remain separate until actually verified.
