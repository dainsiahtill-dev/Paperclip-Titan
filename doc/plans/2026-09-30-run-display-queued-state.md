# Honest execution status in live task displays

## Problem and intended behavior

SOU-200's queued run `81ef8d82-43b8-466a-b165-8bc7764e5f97` had no
`startedAt` or `processStartedAt`, but its chat header said "Working" and
the sidebar counted it as live. Both chat renderers accept an execution
projection but ignore it; sidebar counters count every queued/running row.

Queued runs must say "Queued" and show time waiting, never time working.
Running records with a non-working execution projection must show the
projected state. Only confirmed working runs contribute to live badges.
Queued runs remain visible and retain their existing execution controls.

## Boundaries and data flow

Reuse the server's ExecutionProjection as presentation authority. Add one
UI predicate/label helper shared by the chat headers, sidebar counters and
issue live badges. Preserve the broader queued/running predicate used to
find execution paths and prevent duplicate wakeups. Preserve terminal
Worked/Stopped summaries and transcript visibility. Production sidebar
variants use the same predicate as development variants.

Use processStartedAt when available for a working run's elapsed clock;
queued time starts at createdAt. No scheduler, capacity or provider state
is mutated by this presentation fix.

## Verification and risks

First reproduce queued-as-Working, queued-as-live, and ignored reconnect
projections in component and badge tests. Verify working and terminal
compatibility, then run the affected UI tests, typecheck, build and token
gates. Inspect desktop/mobile task pages with a queued run and with real
live API data. An empty transcript alone does not imply the model is idle.
Legacy records without a projection retain the running-status fallback.

Startup progress revalidates a cached non-working projection without cancelling
an in-flight request. Once working is confirmed, output events keep the existing
cache-only path. The token gate exposed one existing concurrency-settings grid
literal; move that exact layout to the token layer without changing its geometry.

## Results

- Regression before implementation: 8 failures reproduced the misleading
  queued/working labels and live counts. Startup cache tests separately
  reproduced stale company and per-issue projections.
- Final affected UI suites: 316 tests passed across 8 files.
- Full workspace typecheck passed; final UI typecheck/build and token gates passed.
- Desktop (1440x1000) and mobile (390x844) browser checks on the served UI:
  a queued run displays "Queued for 3 minutes" and "Waiting to start...";
  one working plus one queued run displays "1 live". Both had no page errors.
  Fixtures replaced read responses only; API mutations were blocked. The
  real SOU-200 page was also opened without modifying its task or run state.
- Screenshots: /tmp/paperclip-queued-desktop.png and
  /tmp/paperclip-queued-mobile.png.
