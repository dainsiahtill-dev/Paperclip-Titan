# Preserve ACP provider limit failures for configured fallback

## Evidence

Starwave run `217ff4bc-2bfe-4712-998c-2d9a269c3292` failed with
`ACP agent reported a terminal limit failure.` and generic `acpx_turn_failed`.
Its Agent already has Codex gpt-6.1-sol backup/recovery enabled, but no fallback
scope was created. The SDK produces this exact message only from typed ACP
sessionFailure metadata with category `limit`. The ACP engine discards that
category; the scheduler requires errorFamily `provider_quota` to activate backup.

## Narrow fix

Map that exact SDK terminal failure to the existing provider_quota contract in
both a failed terminal result and the turn exception path. Preserve failure,
usage, cleanup, session state and settlement. Cancellation, timeout, transport
loss, access errors, service errors, token-limit stop reasons and arbitrary user
or stderr text must not activate this mapping. Keep existing backup selection,
responsible-user scope, concurrency and periodic primary recovery unchanged.
The SDK category does not identify billing versus rate versus provider context
limits; report that boundary rather than claiming confirmed subscription quota.

## Verification

Exercise the real ACP executor with terminal metadata already normalized by the
SDK, not a mock classifier. Prove expected tests fail first, then provider_quota
survives to execution results and JSON. Preserve negative access/service cases,
timeout/transport precedence, and existing retry/fallback regressions. Review
before merge and verify the real affected Agent uses configured backup while
continuing the course work; no Starwave GPU operations in this platform fix.

## Verified results

- Both real executor quota regressions failed before the mapping.
- The combined thrown-limit/channel-loss regression failed before the precedence
  fence; its final result now stays duplex_channel_lost without quota family.
- Final five relevant suites: 263 passed. Adapter utilities typecheck/build passed.
- Independent review accepted the final narrow guard; existing generic thrown
  failure classification remains unchanged, and timeout keeps priority.
- Native Starwave owner resumed as Codex gpt-6.1-sol using its configured backup.
  The live server's periodic primary probe reported unavailable and retained
  backup with the next 15-minute check scheduled. No fabricated readiness.
- Repo-wide suites were not rerun for this narrow adapter classification change;
  the earlier broad run was stopped during unrelated chat integration work.
