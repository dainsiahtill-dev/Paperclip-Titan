# Read-only MCP coexistence review

Read-only review of three-file diff against HEAD `dffdcfcfe25fd965cb33984a1e37e6ce8315b51a`: `tool-gateway.ts`, `governed-stdio.ts`, `tool-gateway.test.ts`. Existing sandbox builder and governed-stdio tests inspected as call-path context. No tests, live/provider actions, database operations, process actions, source edits, or subagents performed by reviewer.

## Assessment

Filesystem/PID confinement and writer coexistence are sound in inspected code. Initial runtime-timeout finding is resolved by the four-file follow-up below. No remaining blocking correctness finding.

## Important finding

- Resolved P2 — `server/src/services/tool-gateway.ts:4923` / `server/src/services/governed-stdio.ts:106`: initial ordinary-read routing silently capped authorized 40–60-second runtime calls at 30 seconds. Follow-up preserves the already-normalized gateway runtime budget with a separate host-set flag; audit/basic limits stay unchanged.

## Verified source properties

- Selection requires catalog `isReadOnly === true`, no write/destructive flag, and `riskLevel === "read"`, or an existing audit read-only profile. Host-bound active run/company/agent/project/workspace checks still precede execution.
- Selected tools receive actual source-RO filesystem confinement and fresh PID namespace through bwrap. Writable private home cannot overlap source; loader/home override environment keys are stripped. Metadata cannot authorize source writes.
- Ordinary implementation read calls preserve previous network access; audit/basic callers default to denial. Separate writable stdio still claims ownership before argv execution and remains blocked by a held physical writer.
- New real guarded-writer test proves read succeeds, attempted source write fails, original bytes remain, and writer owner stays active. Existing write-before-argv rejection assertions remain; fixture now correctly declares its real write effect.

## Verification inspected

- `git diff --check`: clean.
- `readonly-mcp-live-writer-red.json`: 63 passed/one failed on physical-owner conflict.
- Initial `readonly-mcp-live-writer-green.json` retained: 67 passed/one failed because fixture server exited; parent identifies malformed fixture newline and corrected it without dropping assertions.
- `readonly-mcp-live-writer-final.json`: 68 passed, zero failed/skipped; tool-gateway 64 plus real governed-stdio 4.
- Parent reports initial server typecheck exit 0; reviewer did not rerun. Initial tests used short calls; follow-up adds actual-process timer observations for runtime/basic budgets.
- Real CodeGraph Test-tab execution is recorded in the follow-up below; actual employee phase-2/product delivery remains unverified by this review.

## Declined to judge

- Live CodeGraph/provider retry, deployment, employee acceptance and product checkpoints: explicitly outside read-only review.

## Initial reviewed source SHA256

```json
{
  "server/src/__tests__/tool-gateway.test.ts": "087884bd39911e8f7caa3133ae5d3a3a07ceb1e44d3fd50798fd345d8b3f4a43",
  "server/src/services/governed-stdio.ts": "1b1a2493ac3c18a6d26918b23a0425fae9728ac36f3b9c53d0a22397642da374",
  "server/src/services/tool-gateway.ts": "f3a90299935bc51d78cb0341068b25a14c8ca4cb3fbb59c9aad2c8430c29e40e"
}
```

## Four-file timeout follow-up

`preserveRuntimeTimeout` is separate from `allowNetwork`, defaults false, and changes only timeout ceiling to the existing 60-second gateway limit. Gateway sets it from validated host profile; tool parameters do not supply it. Audit/basic callers retain the 30-second default ceiling and default network denial. Filesystem/PID confinement and source-write denial remain unchanged.

`governed-stdio.test.ts` adds two real confined-process handshake cases that observe actual timer scheduling: a 40-second runtime budget remains 40 seconds, while basic/default execution stays capped at 30 seconds. Tests do not wait for long deadlines or replace process confinement.

Inspected `readonly-mcp-live-writer-timeout-final.json`: 70 passed, zero failed/skipped (gateway 64, real governed stdio 6). `git diff --check` clean. Inspected saved public `real-codegraph-readonly-test-call.json`: HTTP 200 and tool result `isError: false`; parent reports five symbols/one file returned using saved audit employee without inference. Reviewer made no live calls. Latest typecheck completion was not independently inspected; prior server typecheck report predates this timeout-only follow-up.

Latest reviewed source SHA256:

```json
{
  "server/src/__tests__/governed-stdio.test.ts": "50f03c9abbbdbcaf621d46b96d3943c686f81ee512be6ebe96049fab469f1996",
  "server/src/__tests__/tool-gateway.test.ts": "087884bd39911e8f7caa3133ae5d3a3a07ceb1e44d3fd50798fd345d8b3f4a43",
  "server/src/services/governed-stdio.ts": "a874fe0b818af8c9096c2fe17d9a8fe4902f2e6175f73e8a4ecad07ac1a75705",
  "server/src/services/tool-gateway.ts": "002ef25836ab4ca51d3fc2b34a19bba357a11f9b110879734a7a44a8c93f0ac1"
}
```
