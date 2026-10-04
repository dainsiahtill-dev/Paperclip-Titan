# Graceful shutdown usage settlement

Implemented on a separate worktree based on exact Root source
`b0cfcf418b4dcab618d1393bb0968017ef6c7c2c`. The owned production delta is confined
to heartbeat.ts; no application, default configuration/database, provider or
original failed-attempt state was changed.

The final status now preserves the authoritative interrupted outcome. A late
adapter result can retain usage, finalized logs and normalized session metadata
only for the same company/run/Agent/controller boot still interrupted by server
shutdown. A run-row lock and bounded settlement marker commit forensic metadata,
runtime token counters and the cost event together, once. Shutdown status, cause,
signal, finish time, result history and queue disposition remain owned by shutdown.
The late path does not classify progress, publish completion, retry work or certify
tool effects. Session parameters remain forensic on the original run and cannot
overwrite a newer agent/task session. Budget cancellation hooks execute after the
accounting transaction commits. Physical ownership remains held through executor
and log drain.

The legacy adapter context now accepts the agreed typed usage observation callback.
Qualified cumulative lowerbounds persist before a scheduled abort when the
configured run token ceiling is reached. The server pins source/session/scope hash
and validates the bounded legacy checkpoint through Root's shared provenance
reader. Window-only, unbound, wrong established session/scope and duplicate/lower
reports cannot authorize a stop or change the highwater. A stream lowerbound is
stored as observedTotalTokens with usageUnknown; it is never a complete ledger
total or a native/effect receipt. Complete final accounting requires matching
provenance and an explicit total at least as large as the verified highwater.
Partial, missing, unproven numeric and below-highwater final reports retain their
unknown admission hold. Existing native callback behavior is unchanged.

TDD evidence: the actual active fake ACP child registered the real cancellation
callback and process identity. On pristine b0, complete/partial/missing shutdown
cases lost late metadata; the foreign-controller negative passed. The new stream
case initially lacked an onUsage callback. Separate REDs showed unproven numeric
and below-highwater final reports could incorrectly become complete. Final owned
regressions: 7/7 GREEN in 35.56s. The child observation sequence 80→160→duplicate160
at cap150 records before one abort, ignores unbound and wrong-session reports,
drains physically and retains partial unknown usage. Duplicate shutdown/resume
calls produce one ledger event; foreign controller results produce none.

Adjacent gates: 36 heartbeat shutdown/physical Stop cases GREEN in 71.56s; full
resource unit/integration pair 35/35 GREEN in 20.32s; prepared server typecheck exit0;
diff check exit0. All test/compile owners closed. Node24 first PATH, isolated
PAPERCLIP_HOME and embedded Postgres, DATABASE_URL/config/instance/test-DB overrides
unset, source-only Vitest forks/maxWorkers1, unchanged test timeouts. Fresh-worktree
typechecking first lacked plugin/runner declarations; own local shared/plugin/eval
and runner TypeScript outputs resolved that, without Rust builds or links to main.

Root shared-helper prerequisite b60 was imported locally as 25386cefe (only its
two helper files; an unrelated fixture hunk conflicted with missing diagnostic
context). ACP worker source 3ce was imported as 34cf30ff0. Neither prerequisite is
part of the final owned delta. Paired installed-SDK smoke remains pending: the
frozen offline install correctly rejected changed patch bytes against the old
lock hashes. Root owns the regenerated combined lock, active ancestor aggregation,
barrel export, final integrated verification and real-provider qualification.
The fake child does not certify the actual interrupted DEL4 accounting, billing
or safe historical replay; the original failed attempt remains preserved.

## Independent final-producer boundary correction

The independent reviewer reproduced an actual fake-child/Postgres service boundary
failure: Codex accepted a foreign Claude producer envelope as total250, wrote a
known ledger event and cleared the unknown usage hold. This did not establish that
the bundled collector emitted that envelope. Owned RED cases confirmed a fully
shaped foreign prompt-reset proof and static flags without a typed prompt boundary
were accepted; missing Codex baseline remained held, and genuine Claude reset
usage passed. Final acceptance now requires the source/actual-adapter pair,
per_run basis and typed_prompt_reply boundary. Codex cumulative deltas require a
verified baseline. Claude uses its producer_prompt_usage_reset capability without
fabricating a session cumulative baseline. Scope/highwater and unknown controls
remain enforced, and the original shutdown outcome remains unchanged.

Fresh paired gates after ba5 frozen patch installation and ACP1136 edge correction:
offline frozen ignore-scripts install exit0 (2.7s, resolution skipped); 11 active
child/Postgres cases GREEN in40.00s; four installed SDK/accounting smoke files
28/28 GREEN in10.64s; scoped prepared server typecheck exit0. Owners closed and
diff check passed. These replace the earlier pending installed-SDK smoke note.
No cap, application/default state, provider request or original DEL4 accounting
record was changed. Root owns the final integrated source freeze and real-provider
qualification.
