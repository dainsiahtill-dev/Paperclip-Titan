# Quota fallback for local Agents

Open an Agent's **Harness / Runtime**, then **Quota fallback**. Enable the
policy, choose **Codex CLI** or **Claude CLI**, enter the exact backup model ID,
choose its effort and provider concurrency group, then **Save changes**.

For a MiniMax primary configured through Claude/CC-Switch, a typical backup is
Codex CLI, `gpt-6.1-sol`, High. Leave the managed-connection checkbox off to use
the execution machine's own CLI login/configuration. A managed backup account
can be selected independently of the primary account.

Enable **Automatically return to primary** and set **Primary check interval
(seconds)**. The default is 900 seconds; the supported range is 60–86400.
**Check primary now** runs a small genuine model-response test immediately.
**Test backup connection** uses the current draft backup settings. These requests
use provider tokens and obey the instance/provider concurrency limits.

After a classified quota failure, the next safe continuation uses the backup.
Only a genuine successful primary response switches future turns back. An
already-running backup turn completes on its admitted model. The task, working
directory, existing files, run history and saved continuation summary survive
the switch; provider sessions are kept compatible. A quota-limited backup does
not cause a loop between two exhausted providers.

The status shows **Next run**, last check and next check. It verifies whether
the configured model/account can respond; it does not report an exact remaining
token balance. State is scoped to the responsible user and survives restarts.
The recovery continuation itself is durable, so an outage between successful
verification and task resumption is retried automatically.

## Supported execution environments

This policy supports local Claude/Codex runtimes. Remote environments and
instance policies forbidding local execution cannot be verified using the
host's account. For an unbound primary with routine-specific credentials, or a
task with an adapter/execution-policy override, a host-only check cannot prove
recovery of that exact runtime: automatic primary checks fail closed. Normal
local tasks reproduce environment, Agent and project authentication precedence.
Managed bindings use the responsible user's selected connection.

Pause, task drain, budget stops and existing execution reconciliation still
apply. Existing Agents have fallback disabled until you enable and save it.
