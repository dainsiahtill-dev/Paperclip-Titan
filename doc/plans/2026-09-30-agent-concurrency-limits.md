# Configurable agent run capacity

## Goal and current behavior

Operators need an upper bound on simultaneously executing Agent tasks, plus a shared subscription bound across several Agents. MiniMax through local Claude/CC-Switch is the concrete case: at most six Agents may use that subscription at once. The existing `heartbeat.maxConcurrentRuns` applies to one Agent only. Project workspace serialization is a separate safety gate and may keep actual parallelism below any capacity limit.

## Chosen design

Add `agentConcurrency` to instance General settings, persisted in existing `instance_settings.general` JSON: `maxActiveRuns: number | null` (null means no instance cap) and `groups: [{ name, maxActiveRuns }]`. Group names are normalized lowercase slugs, unique, and limits are positive bounded integers. A group is an operator-defined shared resource, not an inferred provider: CC-Switch can change provider outside Paperclip, and an AI connection ID can vary by responsible user. Each Agent can choose one `runtimeConfig.heartbeat.concurrencyGroup` from the configured groups; its existing per-Agent cap remains effective. A run consumes both an instance slot and its group's slot while its persisted status is `running`.

Capacity admission occurs while a queued run is being claimed. A transaction locks the singleton instance-settings row, reads the current caps and the persisted running runs, and changes the candidate to `running` only if both slots exist. The row lock serializes claims across concurrent Paperclip controllers. A full or unconfigured group leaves the run `queued` with a visible waiting reason and does not enter an adapter. Existing `resumeQueuedRuns` retries queued work on the normal 30-second scheduler tick and after restart; no recurring cancelled-run chain is created. Reducing a limit waits for existing runs to finish and does not kill them. A dedicated nullable `heartbeat_runs.capacity_group` column records the selected group at claim so later Agent edits or Runner profile rewrites cannot undercount it. Null denotes a historical row; an empty string denotes a newly admitted ungrouped run.

The server treats invalid or unconfigured group names as a closed capacity gate, never as unlimited capacity. A missing instance cap or group assignment preserves existing behavior. The UI puts total/group limits in Instance Settings > General and a group selector beside each Agent's existing max-concurrent-runs field. Labels distinguish a capacity *ceiling* from the workspace/dependency rules that determine actual concurrency.

## Module and data boundaries

- `packages/shared`: strict settings schema/types/defaults, no secrets.
- `server/src/services/instance-settings.ts`: normalize and persist General settings without a migration.
- `packages/db`: additive nullable `heartbeat_runs.capacity_group` migration; historical running rows fall back to the current Agent group until they finish.
- `server/src/services/heartbeat.ts`: transactional capacity check at each queued-to-running claim path, one durable wait state, normal queue recovery. Keep issue checkout, approvals, budgets, chat-control and workspace gates in their current order.
- `ui/src/pages/InstanceGeneralSettings.tsx`: labeled inputs, validation feedback, Save and pending state.
- `ui/src/components/AgentConfigForm.tsx`: select only configured group names, show saved but currently missing groups clearly.
- `doc/SPEC-implementation.md`: scheduler contract and operator instructions.

## Verification

1. Red tests: shared schema rejects zero/duplicates; instance settings GET/PATCH round trip; with group limit 1, two Agents' simultaneous queued runs admit one and leave one queued; after first ends, queue sweep admits second. Cover global limit across different groups and a missing group. Include a concurrency race test to prove the DB row lock prevents oversubscription.
2. Implement the smallest shared/server/UI changes, then run focused Vitest, `pnpm -r typecheck`, `pnpm test:run`, and `pnpm build` under Node 24.
3. Verify with a separate Paperclip instance before replacing the live service. Then set `minimax` to 6 and bind only the Agents that actually use the same local MiniMax subscription. Observe seven queued runs: six execute, the seventh waits and starts after a slot releases.

## Risks

Global limits include all running Agent runs, including preparation and cleanup, so they are conservative relative to actual provider calls. A group assignment is explicit; changing CC-Switch does not automatically reclassify an Agent. The first live deployment must wait for current long-running work to finish so the dev watcher does not interrupt it. Settings use existing JSON columns, while the durable per-run group requires one additive migration.
