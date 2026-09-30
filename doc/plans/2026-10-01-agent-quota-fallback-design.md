# Agent quota fallback and primary recovery

## User outcome

An Agent can configure a backup Claude CLI or Codex CLI model and an independent
AI connection. A classified provider quota failure switches the next safe
continuation to that backup. Configurable periodic checks verify the primary
model and switch subsequent turns back when it is available. Existing Agents
remain unchanged until their owner enables the policy.

## Configuration and state

`runtimeConfig.quotaFallback` contains enabled, one typed backup profile,
recoveryEnabled, and primaryCheckIntervalSec (60–86400; default 900).
Backup fields include adapterType, model, thinkingEffort, fastMode,
concurrencyGroup, and an optional managed aiConnection. Local CLI authentication
is the default. Nested raw credentials, environment maps, arbitrary command
arguments and native-runner substitution are excluded from this profile.

Server-owned `metadata.quotaFallbackState` stores independently scoped state
per responsible user, a primary configuration fingerprint, the active route,
quota failure time, primary check/result times and a bounded probe lease.
Client Agent metadata edits cannot forge or erase this state. State survives
server restarts and is invalidated by changes to the corresponding configuration.
It does not change the primary adapterConfig or runtime fingerprints on each tick.

## Safe execution

Both admission and execution resolve the effective adapter through one helper.
Admission pins the route in the run's server-owned runnerProfileJson and uses its
real provider concurrency group. Execution honors that pin even when a probe
recovers the primary during startup. The existing claimed-adapter identity guard,
workspace, owner, budget, pause and reconciliation gates remain effective.

Backup configurations retain shared instructions/workspace settings, strip
primary AI credential bindings, and resolve the backup's selected connection.
Codex backup defaults to the host Codex login and CLI sandbox bypass; Claude
backup uses CLI and dangerously-skip-permissions. The task/Agent identity remains
the same. A switch creates a fresh compatible provider session and carries a
concise predecessor/issue/workspace handoff; history and already-written files
remain the continuation evidence.

Quota failure permits one route transition before the normal delayed retry.
There is no ping-pong if the backup is also unavailable. Other errors keep their
existing recovery behavior. Successors retain predecessor idempotency and run
ownership; an uncertain previous execution must still be reconciled.

## Recovery checks

Only real model-response success establishes primary availability. Installation,
authentication hints, elapsed reset forecasts, and a different account's quota
statistics cannot establish recovery. Reuse the adapters' bounded, small hello
probes with the primary configuration and credentials. Local probes disable
unnecessary project/plugin work where the adapter already supports it.

Probe leases are admitted under the same instance capacity lock as task runs and
count toward instance/provider limits, without consuming the Agent's coding slot.
The timer runs independently of the Agent heartbeat interval, honors suppression
and pause/budget boundaries, deduplicates concurrent controllers and persists its
next check. A failed/ambiguous probe leaves the backup active. A successful probe
selects the primary for the next claim and advances quota-related delayed retries
without cancelling a running backup turn. Checks verify availability rather than
inventing an exact remaining-token balance.

## User interface and run evidence

Harness / Runtime exposes Enable quota fallback, backup Adapter/Model/Thinking
effort/AI connection/provider group, automatic return, and primary check interval.
Support custom Claude model strings and GPT-6.1-Sol with its real effort options.
Show the active route, why it switched, the last primary check and next check.
Offer explicit primary check and backup connection test actions. Draft edits use
the normal Save/Discard flow. Current task run metadata and transcript parsers
use the pinned effective adapter, not the Agent's primary adapter.

## Verification and limits

Test quota-only activation, immediate backup retry, all-unavailable boundedness,
fresh cross-adapter sessions, correct credentials/concurrency, separate users,
changed configuration, controller races, restart persistence, budget/pause,
primary recovery during an active backup, and correct run adapter labels.
Exercise settings in desktop/mobile browsers and use real local model probes.
Provider quota exhaustion can be simulated in an isolated test; do not consume
an actual subscription to force exhaustion. Keep Starwave work isolated during
deployment and preserve all interrupted-run outcomes.
