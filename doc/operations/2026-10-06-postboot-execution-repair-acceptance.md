# Paperclip postboot execution repair — 2026-10-06

Status: source review, focused verification, audited full regression coverage, typecheck, production build and token gates passed. Commit/service update are recorded in the deployment addendum. No inference-backed employee retry or Polaris product change has occurred.

## Confirmed defects and fixes

1. POL-9: guard --disable-userns prevented Codex0.160.1 from creating its real nested tool sandbox, producing ENOSPC despite host support. Same command succeeds on host and fails through original guard. Keep filesystem/PID/network containment, pin source/runtime roots, drop capabilities and use inherited native-ABI seccomp. Protect outerPID1 from direct/queued/pidfd signals, setns/ptrace/process-memory injection; mask its procfs entries after all mounts; reject raw hostproc declarations. Fixed ACK shell has verified independent SID/PGID before permission, preserving GNUtimeout process-group cancellation.
2. POL-10: managed subscription projection intentionally clears inherited CODEX_API_KEY to empty. Audit mistakenly rejected the key by name before model start. Admit only the exact empty reset, preserving CLI/read-only enforcement and executable/config/loader restrictions; nonempty/malformed overrides remain rejected. Actual managed-runtime preparation and subsequent audit validation are covered.
3. Additional verified namespace lifetime boundary:6th owned diagnostic launch reused an exited namespace inode; a later current scan misattributed the new live namespace to the old one. Pin the exact host namespace object until its real drain is durably recorded. ConfirmStop consumes the matching complete identity, generation, launch and host namespace_drained journal under a shared row lock; nextlaunch uses exclusive transition, unique nonce and clears old identity/receipt. No old group-only receipt becomes namespace proof. Malformed identity/journal/receipt fail closed.

## Verification ledger

-111 focused cases pass, no skips: real Codex workspace tool read/report/tiny assertion, actual audit write denial, loader-beforeACK denial, strict roots/nonce/generation, nested Stop/no late write/next protected task, GNUtimeout, hostproc/memory protection, namespace pin cleanup, durable valid/invalid receipts and historical compatibility.
- Public HTTPStop9/9 pass;309 unrelated tests were name-filtered, not full-suite evidence.
- Managed subscription + operator safety API52/52 passed.
- Full repository typecheck and token gates exit0; source freeze matches nine reviewed files.
- Independent security probes cover native/x32 BPF dispatch, nested user/mount escape denial and newmount APIs, alias masking, hostpin lifecycle/failure cleanup, valid legacy namespace shape and20 malformed projection cases.
- Original Polaris directory realCodex read-only sandbox executes requiredRTK/Python3.12.3 and a tiny assertion, reads authorized feedback and records actual drain. These callbacks are synthetic; this is tool/environment evidence, not a production employee verdict. Original code directory and existing product files are untouched.

First concurrent focused drain failure retained; its precise cause was not proved. Separate kernel-inode reuse was reproduced and fixed; a200-attempt no-inference stress before that fix returned200drains, which does not erase the failed attempt.

The first broad test attempt became obsolete during review and was explicitly canceled only in newly owned temporary test processes; it is not final qualification. Initial throwaway invalid CLI arguments/tmp mount/BPF jump attempts and an omitted-cargo PATH typecheck failure are retained as author limitations, not product failures.

## Pending production qualification

After deployment, fresh authorized employee qualification must use the same originalPolaris code directory and saved model binding: read authorized file, write engineering output only in authorized location, execute tiny real test, publicStop/exactdrain and secondprotecteddispatch. API200, processExit0, a host shell or synthetic callback proof alone cannot complete employee qualification. Do not automatically replay POL-9/POL-10 or already-completed product work. Polaris resumes only unfinished validation under fresh authority.

## Limits

Native ARM64 kernel unrun; BPF ABI cases are modeled. No provider/model or Bench call performed. Existing native-binary package-root discovery can select /home/dains because its package.json is an ancestor; its broadRO exposure predates this patch, and tool readability is not private-root isolation proof. That separate hardening issue was recorded, not silently included as resolved.

Artifacts remain repository/local operator storage per user destination. Sensitive auth/config/raw worker logs are excluded from public evidence.

## Complete repository verification

All twelve official disjoint partitions were attempted against unchanged implementation. The initial broad attempt was not exit-zero; its failures remain preserved. Whole-file/project rechecks passed at original timeouts, and every file/project skipped by a failed wrapper was executed. The final audit has no unrun coverage or unresolved failures; this is not a claim that a monolithic command passed. Database whole-project serial verification: 148 passed. CLI guidance main-checkout39passed under a test-only mount hiding older unrelated worktrees; no old directory was moved/deleted/copied. Production build exit0. No deadline, threshold, assertion, skip policy or dependency changed.

Polaris original root remains device2096/inode244796/HEAD9bb5bd1b4. Its route implementation is already committed according to owner evidence; continue only unfinished POL-9 qualification/independent review after fresh authority. Do not redo POL-6 implementation.

## Deployment addendum

- Implementation main/remote: ea0cc3abcc9890beb41260d9d7ea64c13ac358e9.
- Default3100 service sourceCLI restarted on Node24 with --no-repair and existing devUI; actualnewPID7027/startTicks739441, serverVersion2026.916.1+149.git.ea0cc3abc, startupRecoveryready/authReadytrue. Build stamp726894ccf predates commit and is not the running sourceCLI entry.
- Bothcompanies and38employees preserve name/role/title/reporting/adapter/model/runtime/permissions/budgets/status exactly; configuration bytes unchanged. Hotrestartlost/skipped arrays empty.
- Exactoriginal historicalruns/leases/events digests unchanged; genuinepostbootmigration remainsclosed with no fabricated namespace receipt. Noactive/queued/retry/pendingwakes remain.
- Ordered API/PostgreSQLstop verified before coldbackup;8469files sequentially checked against stoppedinstance. Backuproot /home/dains/.paperclip/backups/postboot-execution-20261006T010107Z. It excludes oldbackupduplicates, workspaces andPolaris source. Initial random-access gzipvalidator was inefficient; only its ownedreadonlyprocess was replaced by streamverification, preserving archive anddata.
- NoWSLrestart, provider/modelcall, business replay orPolaris product edit performed inthis repair. Actual inference-backed employee qualification remains pending fresh authorization.

## Authorized remaining qualification repair

The operator authorized remaining employee qualification on 2026-10-06. The historical POL-10 failure remains retained. A fresh supersession was refused because its never-launched source lacked a process identity. Admission now accepts only a precise released owner, original physical workspace identity, matching generation/null-launch journal, no process/invoke events, and fully released clean leases. Pending or failed cleanup still blocks admission.

A separate independently dispatched POL-12 executed real commands and tests in the original Polaris directory, then ended after reassignment with an unverified drain. This is execution evidence, not successful Stop acceptance. Its failed run and event ledger remain authoritative and unchanged.

New local operator commands in `scripts/workspace-legacy-closure.ts`:

- `namespace-inspect --config <private config> --company-id <id> --cwd <original root> --owner-id <id> --generation <generation> --launch-id <launch>` is read-only.
- `namespace-close` uses the same selectors plus `--expected-digest <fresh inspection digest>`. It requires a terminal run, exact trusted process binding, unchanged owner/source, clean released leases, same boot/observer, and actual empty guarded namespace. It appends a genuine drain receipt and release journal with activity audit. It never signals, changes run status, removes history, or wakes work.
- Actual procfs/nsfs metadata and open namespace descriptor identity are checked against the local embedded database process. Boot/namespace identities cannot be supplied as arguments.
- Repeating a completed close with its original digest returns `alreadyClosed: true`, performs no mutation, and permits later annotations on the failed run. Initial close requires a fresh unchanged admission digest.

Ordinary Linux alternatives are mounted read-only so tools such as `awk` resolve normally. Namespace shutdown gets a strict, bounded one-second drain observation window; exhausting that window remains unverified. The exact cause of the earlier POL-12 drain failure has not been reproduced.

Current deployment and employee qualification results will be appended after actual execution. No Polaris product implementation is repeated by this repair.

Actual POL-10 continuation f8e7bdd5 passed prior audit environment admission and started a guarded process, but Codex0.160.1 rejected `--permission-profile` before inference. The debug `codex sandbox` command supports that option; `codex exec` does not. Exec now receives its supported `--sandbox read-only` option plus the existing read-only config. Real fresh/resume CLI parsing, physical debug sandbox write denial and safety/argument tests pass69/69. This failed attempt and its real cleanup remain retained; it is not a review verdict.
