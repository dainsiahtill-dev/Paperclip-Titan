# GPT-6.1-Sol support in the maintained Paperclip version

The user requested `gpt-6.1-sol` in the Codex model selector. The local native
Codex model cache (client metadata version 0.159.2) includes `GPT-6.1-Sol`,
reasoning levels low/medium/high/xhigh/max/ultra and the priority Fast tier.
The installed CLI reports 0.159.1. Paperclip's fallback model list omits it,
and the local auto-engine rule recognizes only GPT-6 Sol/Luna.

Add the exact slug and display name to the shared Codex adapter catalog, add
its native reasoning levels and Fast capability, and choose CLI automatically
for this model while respecting an explicitly selected engine. Agent forms,
issue overrides and the server model endpoint consume the shared catalog.
OpenAI connection compatibility already checks the adapter/provider and does
not restrict this model slug.

Verify catalog and UI reasoning choices, default/explicit engine routing,
Codex argument handling, package/server/UI type checks and a real local hello
probe with the exact model. Publish the verified maintained branch to the
user’s Paperclip-Titan repository. Deployment must preserve active work or use
a verified quiescent boundary; check the live model endpoint after restart.

## Verified locally

- Catalog, engine, argument and UI reasoning suites: 74/74 passed after the
  new tests first reproduced the missing model and wrong auto-engine routing.
- `pnpm -r typecheck` and `pnpm build`: exit 0 on the local Node 24 runtime.
- The Codex environment probe with exact model `gpt-6.1-sol`, high reasoning
  and the machine's own account returned `codex_hello_probe_passed`.

The full unrelated Vitest suite was not rerun for this model catalog change.
