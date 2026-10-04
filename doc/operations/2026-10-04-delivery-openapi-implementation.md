# Delivery API contract synchronization — 2026-10-04

The mounted-route coverage check found ten missing OpenAPI operations: scoped quota status/primary check/backup test, pinned document revision reads, issue delivery assessment/policy/decisions, project delivery policy, and watchdog recovery batches/dispositions.

The specification now registers every operation, reuses its actual shared request validator, and documents current permissions and errors. Project policy remains board-only. Watchdog mutations require an authenticated agent identity bound to the configured watchdog run; agent keys and local JWTs remain supported, while board credentials are not advertised. New delivery verdicts return201 and idempotent replays return200.

Revision reads document optional offset>=0 and limit1–32000, with defaults0/16000 stated explicitly because the existing converter omits default keywords. Array conversion now retains the actual Zod4 minimum/maximum/equality lengths, including the watchdog batch's one-to-three mutation limit. HTTP handlers and runtime authorization are unchanged.

Verification: existing coverage plus new contract controls initially failed on missing operations, lost array bounds, and verdict/auth metadata. The complete11-case OpenAPI suite then passed. Independent read-only review matched all ten registrations to current handlers, validated strict request bodies and bounds, and independently passed11/11 in5.43s with unchanged source hashes. This is API contract evidence; real project delivery and deployment are separate qualification steps.
