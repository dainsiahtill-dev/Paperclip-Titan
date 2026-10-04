# Controlled rollback read compatibility

The read exercise passed against the existing restored, upgraded clone at
`/tmp/paperclip-restore-final-20261004/pgdata`, port 55432. It started only that
previously stopped PostgreSQL cluster, without initialization, restore, reset,
migration, application server, scheduler, agent, or provider request. The original
restore result remained untouched. Production services and databases were not used.

The older source was exactly `39451d9e957fe94e315560e475851e3813effbcc`, checked out
separately with its own offline dependencies. Actual issue, agent, project and
document service getters ran under a temporary SELECT-only SQL role and an explicit
read-only transaction. A zero-effect write control was rejected with SQLSTATE
`25006`. Every restored domain record was read; four missing-record controls returned
null:

| Actual old-source read | Records |
| --- | ---: |
| Issue getter | 239 |
| Agent getter | 17 |
| Project getter | 4 |
| Issue document getter | 744 |

The original 210 tables and 59,086 rows retained their original-column digest before
and after: `c28807199e7ec53c6767ff75a29d8995903bba758bd0986611320830b1f2ba22`.
The complete upgraded projection covered 215 public tables, including every column;
its before/after digest was
`a8842a5006f045cd4c922aa4ce0ede597317f726032cef65dc02ae3e216274fa`.
The 285-row migration journal also retained digest
`6b8cb21b7e7a27a542a94af7ebb9e058c486bc430750414e6fb93710fbc1e0f9`.
These use the restore exercise's MD5 row-text/table hashing and SHA256 aggregate;
the journal count alone does not identify its final migration.
Retained records included 2,289 wake requests, 1,783 heartbeat runs, 18,310 run events,
2,669 source comments, 35 recovery actions and 12,985 activity records. The five
new delivery/watchdog tables were empty in this clone; their schema and empty state
were preserved, without claiming populated new-receipt qualification.

The temporary role was removed and the owned postmaster (PID 2329) stopped. Fresh
checks found no process at that PID, no postmaster PID file and no socket on 55432.
The Node exercise exited zero. Private helper, logs and before/after observations
remain in the runtime worktree's ignored `.tmp/rollback-read-20261004/`, directory
0700 and files 0600. Executed helper SHA256:
`f64902b678afd0effa2279745039a5802a4da09e87d538bdfa26339fb806494e`;
result SHA256:
`00bf86feb0d4852fb1f00a4440cfbd7e61b1e7b271db05ac2ead132e63204d4d`.

This establishes read compatibility for that exact older source and clone. It does
not identify the last accepted or currently loaded production binary: the advanced
main history and live 0.3.1 version do not provide that binding. Legacy write safety,
API/browser behavior and scheduler compatibility remain unqualified. There is no
universal feature-off switch, and the old binary cannot enforce the new verified
delivery and token-limit contracts. A constrained rollback must keep scopes using
those features quarantined or under manual holds, preserve pending/uncertain/effect
records and failed-run evidence, reconcile external effects first, and prohibit
automatic historical replay. This read exercise grants no permission to resume old
controllers against business data.
