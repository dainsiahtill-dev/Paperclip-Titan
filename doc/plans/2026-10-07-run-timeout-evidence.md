# Effective run timeout evidence

## Observed failure

POL-37 run `bc8bb743-e74c-489f-8d50-e6e75f4a6706` used the issue's 1800-second execution timeout and ran for approximately 17 minutes. Its reassignment cancellation result nevertheless reports `effectiveTimeoutSec: 600`, the current agent default. `mergeRunStopMetadataForAgent` reconstructs timeout policy from agent configuration instead of the configuration resolved for that execution. Its stop reason and authenticated namespace release remain valid.

## Bounded implementation

Freeze the actual server-resolved timeout policy for each new execution after issue/workspace overrides and resource clamping, before adapter dispatch. Terminal metadata, cancellation and recovery must consume that run's evidence, including after later configuration changes. Adapter results and caller wake fields cannot supply trusted timeout evidence. Historical runs without the snapshot require an explicit compatibility fallback; do not rewrite old database records or infer facts from current issue settings.

The Paperclip engineering worker owns `heartbeat.ts`, `heartbeat-stop-metadata.ts`, its tests and a necessary dispatcher regression. Root owns this plan and the operations record. Work stays on main, separate from the Polaris audit's source directory. No budget, cancellation, namespace, sandbox or retry-accounting behavior changes are authorized by this fix.

Independent review found two blockers in the first implementation: snapshot overwrite during same-run native adoption and capture before a gate that could reject dispatch. The bounded correction additionally owns the internal run-dispatch `application/ports.ts`, `application/use-cases.ts`, `adapters/postgres.ts` and `adapters/postgres.test.ts`. A narrowly typed optional timeout snapshot is persisted once under existing accepted issue/run locks before synchronous handoff. Recovery/adoption sends no new snapshot and cannot populate missing historical evidence from current configuration. No arbitrary profile-write hook or public API extension is added.

## Acceptance

Reproduce agent 600 / issue 1800 through a real heartbeat dispatcher regression, then prove cancellation metadata retains 1800 after post-launch configuration changes and does not claim timeout fired. Cover normal completion/failure, disabled timeout, defaults, resource clamping and HTTP milliseconds where applicable. Verify caller/adapter markers cannot overwrite server evidence and missing historical evidence has the declared fallback.

Run focused RED/GREEN and relevant typecheck first. Root independently reviews, completes required checks, commits and pushes the verified change, and updates the local service only after active employee execution has safely released. Preserve POL-37's original cancellation record and all raw evidence.
