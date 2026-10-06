# Supplemental Codex exec argument review

Read-only review of three changed files against HEAD `7718ff746b2d909f36f6e5250177398eb1113c45`: `codex-args.ts`, `codex-args.test.ts`, `codex-readonly-effect.test.ts`. Shared audit validator inspected as call-path context. No live actions, CLI execution, inference, database operations, or source edits performed by reviewer.

## Assessment

No blocking correctness or permission-regression finding.

- `packages/adapters/codex-local/src/server/codex-args.ts:72`: audit exec now receives `--sandbox read-only` and retains `-c sandbox_mode="read-only"`. Both constraints precede optional `resume`; fresh/resume remain on same builder path. No writable/network/bypass option added to audit branch.
- Shared audit gate still rejects both bypass aliases, custom commands, non-CLI engine, and permission/profile/config overrides in both extra-argument aliases. Accepted extra argument remains `--skip-git-repo-check` only.
- `packages/adapters/codex-local/src/server/codex-readonly-effect.test.ts:27`: real fresh/resume `exec --help` checks cover parser compatibility without inference. Existing real sandbox-denial test derives its separate debug profile from emitted read-only mode and checks source bytes remain unchanged.

## Evidence and limits

- `git diff --check`: clean.
- Inspected `readonly-cli-green.json`: 69 passed, zero failed/skipped; safety presets 31, argument builder 35, real CLI/help/denial 3.
- Inspected `namespace-closure-final.json`: 11 passed, zero failed/skipped; clarified completed-close replay includes benign annotation and exact-owner preservation.
- Retained `current-scoped-suites.json`: initial 170 passed/one failed/six skipped. Failed annotation insert omitted mandatory `agentId`; current source supplies it. Final namespace report passes after field correction; assertions remain.
- `cli-sandbox-final.json`: 14 passed/six skipped. `bwrap-sandbox-final.json`: sandbox 16 passed/two skipped. These are distinct parent runs, not one combined result.
- Parent reports Codex package typecheck/build exit zero; reviewer did not rerun. Parser/help and debug sandbox denial do not establish successful resumed inference or final POL10 delivery; that acceptance remains root-owned.

## Declined to judge

- Authorized live POL10 continuation, provider availability, and delivery acceptance: excluded from this read-only three-file review.
- Behavior of other installed Codex releases: current actual CLI report establishes tested host compatibility; no version matrix requested.

## Reviewed source SHA256

```json
{
  "packages/adapters/codex-local/src/server/codex-args.ts": "8bdf0dad5ef2c62176dd4625eb57d3b3bb5f440190bded2df09467eaf96d5abd",
  "packages/adapters/codex-local/src/server/codex-args.test.ts": "921cc9de61466097518c9fa7390351e4a9f8705256ce766e065941322869fda9",
  "packages/adapters/codex-local/src/server/codex-readonly-effect.test.ts": "b7b528343ed01781b26aae5634e1d0d5f4ab5ed8a567125451b1de608c5fdd9c"
}
```
