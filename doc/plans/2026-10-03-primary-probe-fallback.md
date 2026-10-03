# Activate the configured backup after a confirmed unavailable primary probe

## Observed failure

Starwave's evaluation agent has a configured Codex backup. Its primary MiniMax
run remains pending without tools or output. The existing real primary probe
returns `unavailable`, while `usingBackup` remains false. The fallback currently
waits for a terminal quota failure, so this observed provider failure does not
select the backup for subsequent work.

## Ownership and data flow

Keep provider probing and capacity admission in the existing heartbeat service.
In `agent-quota-fallback.ts`, commit a successful probe result to the same locked,
responsible-user-scoped book. A confirmed `unavailable` result with a configured
backup activates that backup for subsequent runs and schedules primary recovery
checks. Preserve the policy fingerprint and probe lease guards.

Do not label the probe as a quota failure or create a fictitious failed run:
`lastQuotaAt` and quota run IDs retain their actual values. Record the activation
reason as `primary_probe_unavailable`. `busy` and `error` remain inconclusive.
An `available` probe uses the existing recovery mechanism. An active invocation
is not preempted by this state change; operator recovery preserves its task and
queued messages before the next dispatch uses the configured backup.

## Verification

First reproduce unavailable-primary plus configured-backup remaining primary.
Verify backup activation, responsible-user isolation, recovery scheduling, no
invented quota evidence, and no activation for busy/error results. Preserve
existing quota failure and primary recovery regressions. Then typecheck/build,
publish to main, load at a safe controller boundary, and verify the real agent
uses its configured backup while primary recovery remains enabled.
