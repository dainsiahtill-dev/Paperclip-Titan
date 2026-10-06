# Governed MCP approval mapping review

Read-only review of `codex-home.ts` and `codex-home.test.ts` against HEAD `6e3315822e3b6c3c9f057c796a86e2bb98728570`. Adapter caller and broker route inspected for narrow call-path context. No live/provider actions, tests, database operations, or source edits performed by reviewer.

## Assessment

No blocking URL or permission-correctness finding.

- `packages/adapters/codex-local/src/server/codex-home.ts:357`: URL resolution uses `URL`; exact `origin` equality includes scheme/host/port, broker prefix requires `/api/tool-gateway/`, and nonempty username/password prevents generated client approval. Foreign and same-origin nonbroker URLs receive no approval override.
- `packages/adapters/codex-local/src/server/codex-home.ts:372`: `default_tools_approval_mode = "approve"` belongs only to each qualifying generated MCP server table. Root `approval_policy` and unmanaged server settings remain in preserved config; collision handling assigns a distinct managed name.
- Actual broker MCP route still sends `tools/call` through `toolGateway.executeTool` with bearer session token plus exact gateway ID. This patch changes no broker grants, ask-first, deny, or execution authorization code.
- New tests cover same-origin generated broker approval, foreign broker-shaped endpoint, same-origin nonbroker endpoint, unmanaged prompt preservation, and root approval-policy preservation.

## Nonblocking finding

- P3 coverage — `packages/adapters/codex-local/src/server/codex-home.test.ts:1038`: negative table does not exercise stated URL-userinfo exclusion. Add an ordinary same-origin broker URL with username/password and assert no generated `approve` entry. Existing code explicitly rejects both fields.

## Verification inspected

- `git diff --check`: clean.
- `mcp-approval-red.json`: one failed/55 passed; new generated-broker assertion identifies missing mapping.
- `mcp-approval-green.json`: 94 passed, zero failed/skipped; home 56, arguments 35, actual read-only CLI tests 3.
- Package typecheck was running when assigned; no completion evidence inspected here.
- Config-generation tests establish mapping; actual employee gateway delivery and inference-backed acceptance remain root-owned and are not claimed by this review.

## Declined to judge

- Live second-dispatch retry and provider/tool execution: explicitly outside read-only review.
- Unrelated unmanaged MCP endpoint safety and pre-existing bearer-header forwarding: unchanged by this two-file diff.

## Reviewed source SHA256

```json
{
  "packages/adapters/codex-local/src/server/codex-home.ts": "d35b27ae645a843767d619b7f964dacb72a4a10f2cc6bd3a7186e1f250428671",
  "packages/adapters/codex-local/src/server/codex-home.test.ts": "c39efc587eb148bc68127b8beee1405ee57e220fab99d09a5ae41692d546ac79"
}
```
