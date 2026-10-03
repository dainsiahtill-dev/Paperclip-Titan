# Active primary availability monitoring

## Evidence and intent

Two Starwave agents spent long runs on MiniMax while the existing actual primary probe returned `unavailable`. Their configured Codex backups were not selected until Root explicitly invoked `check-primary`. The scheduled fallback tick only inspects scopes already using backup, so it cannot discover an unavailable primary before a quota-classified terminal error. Users have requested configurable primary/backup operation and automatic primary availability checks.

## Bounded design

Use the existing configured check interval and enabled recovery setting for active primary work as well as backup recovery. For eligible running tasks, derive the responsible-user scope and actual source run. The first active check and later due checks use the existing capacity/lease/auth guard. Do not probe idle healthy agents, unauthorized users, or paused/pending/terminated agents. Busy/error remains inconclusive and must not switch models or invent quota evidence.

Pass the actual active run as probe context, preserving its project credential/environment checks. Do not store that ID as a fabricated quota-failure run. Keep the current primary configuration unchanged and record verified unavailability through the existing activation event. This arms routing for subsequent work; it does not preempt a live provider turn or replay tools. Existing automatic primary recovery remains in place.

## Verification

Regressions cover an active primary with no prior quota metadata, user isolation, current source-run context, configured cadence, idle/recovery-disabled exclusion, and unavailable versus busy/error. Retain lease/capacity, recovery and credential-context suites. No schema, permission expansion, new provider, UI workflow or speculative quota classification is required.

## Verification result

The original service reproduces the missed active checks: two new tests fail while the existing 17 pass. The completed change passes 30 tests across fallback state, policy and live steering suites. Node 24 server typecheck and build pass. Actual scope/source context is passed separately from quota-failure IDs; active turns remain running and only later dispatch routing changes after verified unavailability. Complete repository suites retain previously reported unrelated failures; this is not a claim of whole-repository completion.
