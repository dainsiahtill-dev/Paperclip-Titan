# Actual runtime MCP route review

Read-only review of three-file diff against HEAD `06366690a5e49b228767f012f35178ee72a67cb4`: `codex-home.ts`, `codex-home.test.ts`, `heartbeat-runtime-mcp-servers.test.ts`. Actual producer and public broker handler inspected as call-path context. No tests, live/provider actions, database operations, source edits, or extra agents performed by reviewer.

## Assessment

No blocking correctness finding in exact diff.

- `packages/adapters/codex-local/src/server/codex-home.ts:360`: final allowlist matches complete public-ID `/mcp/gateways/gw_<32 lowercase hex>` routes, exact `/mcp/runtime-tools` and `/api/mcp/project-tools`, and exact legacy `/api/tool-gateway/gateways/<single segment>/mcp` shape. Broad legacy prefix removed. Exact same-origin/no-userinfo conditions remain; unrelated paths, invalid public IDs, foreign hosts and unmanaged servers gain no override.
- `server/src/services/heartbeat.ts:4794` and its companion injection paths emit these owned endpoints. Public gateways retain bearer-session/per-tool policy. Runtime tools validate signed capability and bound run lifecycle. Project tools require agent-run JWT/company context, filter tools by task mode, and use normal authenticated API validation/audit. This diff changes none of those authorization handlers.
- `server/src/__tests__/heartbeat-runtime-mcp-servers.test.ts:155`: integration test feeds actual producer URL/token/name into Codex config generator and asserts emitted approval mode. This catches the earlier producer/generator route mismatch without model calls.
- Adapter positives cover all three owned route forms; negatives cover foreign public-ID route and same-origin invalid public ID. Existing foreign/private/nonbroker negatives and unmanaged/root approval-policy preservation remain.

## Verification inspected

- `git diff --check`: clean.
- `actual-mcp-route-red.json`: one failed/56 passed; real public-route config assertion fails before mapping fix.
- Earlier `actual-mcp-route-green.json`: 64 passed. Final `actual-mcp-route-final-exact.json`: 66 passed, zero failed/skipped; Codex home 61 plus real producer integration suite 5.
- Inspected `mcp-real-config-parser-proof.json`: native Codex parser accepts `default_tools_approval_mode` and initializes successfully; unknown-field control rejects `mcp_servers.owned.unknown_policy_probe` with exit 1. No inference involved. Parent reports package typecheck/build exit 0; reviewer did not rerun.
- These prove generated-route mapping, not successful model inference or blocked phase-2 delivery. Earlier model attempts and product checkpoints are outside this read-only review and remain retained.

## Declined to judge

- Further inference trials, deployment, employee retry and final delivery acceptance: explicitly outside review assignment.

## Reviewed source SHA256

```json
{
  "packages/adapters/codex-local/src/server/codex-home.ts": "3c0cf2c9b8d963e8f4889ad810f29246f71d99c973dfdadec0fc88518543d38e",
  "packages/adapters/codex-local/src/server/codex-home.test.ts": "f285a5eb5319b989ba95c78c853d7969f7fdb426cc47a5860c9497a5352d2f81",
  "server/src/__tests__/heartbeat-runtime-mcp-servers.test.ts": "bd5a130925f45987e734bd5cd323c938efcb62965fb3a6b925d6565abf633981"
}
```
