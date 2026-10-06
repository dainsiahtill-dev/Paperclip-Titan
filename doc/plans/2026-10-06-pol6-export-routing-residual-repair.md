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

## Independent review residual

The first employee delta passed 20 new and 169 related cases, but independent
public Plan/probe review found three unsafe proposals. It is not accepted yet:

- Used `$DefaultThing` in a mixed import is missed by a word-boundary usage check,
  so a candidate with only the named export is selected.
- `const rx = /export const Foo = 1/;` is mistaken for a real export.
- Nested template text ``const text = `before ${`export const Foo = 1`} after`;``
  exposes a fake export through the reused mask.

Preserve the first delta and its tests/checkpoints. Add real public negatives for
these cases before the next minimal correction in the same allowed files. A whole
specifier rewrite must satisfy every retained binding whose absence would break
the import; unproven usage is not permission to ignore a binding. Prefer existing
token helpers. If regex/template lexical evidence cannot be established reliably,
refuse that candidate conservatively and report the unsupported form instead of
adding another permissive regex. Keep positive default/named/alias and typed/raw
controls. Existing source assertions and effect/ownership gates stay unchanged.
Root reviews the final diff and reruns acceptance before disposition.

The next delta passed 177 related cases and independent checks closed the three
original review edges. One additional same-family public failure remains: import
`Foo` selects `export const Foo$ = 1;` because a regex word boundary treats `$`
as an identifier terminator. Require an exact JavaScript identifier boundary;
add typed/raw negative and exact `Foo$` positive controls. Preserve the 177-case
delta and all prior reports. The conservative template/slash exclusions remain
explicitly unsupported coverage, not module completeness.

## Architecture review before further implementation

Status: changes required after three implementation/review iterations. Current
183-case GREEN closes the reported trailing `Foo$` boundary, but independent
Node syntax validation and actual raw/typed public Plan/probe reproduce a remaining
false export: `let $export\nconst Foo = 1;\n` is valid JavaScript with no export,
yet the matcher starts `\bexport` inside `$export`. Current code is not accepted.

The common cause is partial lexical proof: general regex word boundaries and an
incomplete code mask are being used as declaration authority. Do not launch a
fourth isolated patch without reviewing one unified proof strategy.

Recommended design within the existing owner and source boundaries:

1. Treat JavaScript keyword and identifier boundaries consistently at every export
   entry point. Never let `$`, Unicode identifier continuations or escape forms
   prove a shorter keyword/symbol.
2. Use the existing lexical/token helpers as the single evidence path. If they
   cannot prove a candidate's relevant syntax, return an explicit unplanned result
   rather than introducing another permissive regex. Keep conservative template,
   slash and other unsupported forms visible as coverage limits.
3. Keep the whole-import binding contract and current public effect/path gates.
   Put keyword prefixes, identifier suffixes, aliases, comments, strings, templates,
   regex and namespace cases in one public negative/positive matrix, including
   typed/raw, input preservation and malformed-path refusal.
4. Review impact on other callers of the shared export helper before choosing a
   boundary-only correction or a token-based refactor. Existing diagnostics,
   planner routing and provenance assertions remain unchanged.
5. Preserve all three deltas/reports and the 183 passing cases. Root independently
   reviews the strategy and resulting public returns; no module completeness,
   real effects, settlement or fresh Bench claim follows from this matrix alone.

No new source run is authorized by this section itself. Current automatic wakes
remain disabled and the task goes to Board review. The remaining objective stays
open; no locks/history/source states are erased to make it appear complete.
