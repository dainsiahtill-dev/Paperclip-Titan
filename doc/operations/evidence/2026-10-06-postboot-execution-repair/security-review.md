# Security review — final nine-file candidate, 2026-10-06

**No unresolved concrete findings in the reviewed diff on the tested x64 host.** All nine frozen hashes matched before and after independent owned probes. This is engineering review of the exact source below, not deployment, ARM64 runtime, paid employee execution, or production acceptance. Reviewer performed no source, service, host sysctl, live database/task, or provider mutation. CodeGraph skipped because `.codegraph` is absent.

## Review findings closed

1. **P2 — initial seccomp target 0 denial weakened tool cancellation.** A GNU timeout grandchild wrote after timeout returned124. Fixed by setsid before the fixed ACK shell, host pre-ACK verification of payload PID=PGID=SID distinct from custodian SID, and allowing current-group signal0. Fixed owned probe leaves no late file, drain1. Evidence: `security-cancellation-probe.before-fix.json` (exact earlier tool output recovered after helper filename reuse, with provenance), `.fixed.json`, and `security-cancellation-control.json`; root's official RED stayed untouched. [GNU timeout source](https://raw.githubusercontent.com/coreutils/coreutils/master/src/timeout.c), [cross-session group restrictions](https://man7.org/linux/man-pages/man2/setpgid.2.html).
2. **P2 — intermediate proc mask could be covered by a later RO proc mount.** Owned reproduction exposed host PID numbering and proc aliases. Fixed by rejecting declared managed/extra roots overlapping `/proc`, including ancestor `/`, before launch; fresh private procfs and read-only `/proc/1` mask now follow all other mounts. Current raw RO proc input rejects and default aliases return ENOENT. Evidence: `security-proc-overlay-probe.json` and `.fixed.json`.
3. **P2 — intermediate durable-stop consumption admitted an empty/partial persisted identity.** Owned model of the real confirmStopped admitted `{}` or `{launchId}` with matching generation/launch journal. No public/API forgery path was established; this was a malformed persisted-evidence acceptance gap. Fixed by the shared complete namespace-identity validator in workspace-owner-provenance plus exact receipt identity/generation/launch matching and stamped journal. Evidence: `security-receipt-probe.json`, `.fixed.json`, `.final.json`.

## Namespace reuse: proved defect, distinct from first transient

`namespace-reuse-witness.json` contains the exact independent kernel witness: after six attempts, old init30470/start331479 was gone; new live init30529/start331502 had reused `pid:[4026532204]`; scanning the old identity falsely reported not drained. This proves a latent reuse defect. It does **not** establish the cause of the earlier focused81 transient drain failure, whose evidence remains preserved separately.

The host opens the exact namespace FD before ACK, verifies inode/readlink/birth, and retains it through both physical drain scans and the durable recordDrain transaction. The child is already spawned and the FD is never in its stdio/env. Existing physical drain predicates remain unchanged. Owned `security-namespace-pin-probe.json` proves pin present before binding and throughout asynchronous durable callback; success closes it with drain1; injected binding rejection closes it with unknown1/drain0. [Namespace FD lifetime](https://man7.org/linux/man-pages/man7/namespaces.7.html), [nsfs ownership](https://raw.githubusercontent.com/torvalds/linux/v6.6/fs/nsfs.c).

Later confirmStopped consumes already committed host proof rather than rescanning a now-reusable inode. Its shared row lock serializes against transition update locks. It requires reserved state, exact unreleased owner/company/run/generation selector, complete launch identity, matching receipt fields, and exact-generation/current-launch `namespace_drained` history. beforeLaunch clears identity/receipt and creates a new launch ID, so an old journal cannot authorize a later launch. recordDrain still verifies kernel drain before atomically storing reserved state, receipt, and stamped journal. No old records or group-stop receipts are rewritten or converted.

Modeled real-function matrix: one complete older V1 identity without optional payload fields admitted; twenty negatives rejected, including missing/wrong journal/receipt, active later launch, missing/empty/partial identity, and malformed required fields even when receipt fields match. This validates predicates, not SQL selector/lock execution; the latter was inspected in source and is exercised by root's database tests. Trusted host DB/journal remains the authority boundary; full hostile database forgery is outside this proof.

## Other independent boundary proof

- `security-custodian-fixed-probe.json`: real nested user+mount namespace; PID1/-1 signals, setns, ptrace, process_vm_writev, pidfd signal/getfd denied; own-group signal0 succeeds; joining custodian group fails; four proc memory aliases absent; drain1.
- `security-probe-fixed.json`:75 BPF interpreter assertions across x64/arm64 dispatch, wrong ABI and x32; real x64 nested old/new mount APIs cannot clear source RO, source unchanged, drain1. Payload has no leaked host anchor/filter/private-root FD. Host FD indices, private0600 policy file, O_RDONLY|O_NOFOLLOW, and cleanup align.
- `security-proc-mask-extended-probe.json`: fresh ancestor proc and fsconfig CREATE fail EPERM; nonrecursive bind/open_tree fail EINVAL; recursive bind retains mask; unmount fails EINVAL. Fresh proc in a new descendant PID namespace shows its own PID1, while outer mask remains. [Locked inherited mount rules](https://man7.org/linux/man-pages/man7/mount_namespaces.7.html), [proc namespace ownership](https://raw.githubusercontent.com/torvalds/linux/v6.6/fs/proc/root.c).
- Mask proof does not depend on Yama: unmasked bwrap PID1 maps were readable and [bubblewrap0.9](https://raw.githubusercontent.com/containers/bubblewrap/v0.9.0/bubblewrap.c) enables dumpability before its reaper fork. Masked aliases return ENOENT. No Yama setting changed. [Seccomp inheritance](https://www.kernel.org/doc/html/latest/userspace-api/seccomp_filter.html) and [PID-init lifetime](https://man7.org/linux/man-pages/man7/pid_namespaces.7.html) preserve the outer Stop boundary.
- Exact uppercase empty CODEX_API_KEY reset remains narrow; malformed/nonempty credentials and executable/config overrides reject. Production audit depends on Codex inner read-only profile; stronger outer-RO testing is not new production enforcement. Subscription credentials/API actions remain outside source-read-only scope.

## Limits

Root owns fresh full-suite and production acceptance. Reviewer did not run ARM64 native kernel, paid employee inference, deployment, or service restart. Root's actual Codex/legacy compatibility test counts are separate evidence. Direct signals to local PID1 in all descendant namespaces, ptrace, and pidfd_send_signal remain intentionally unavailable.

Preexisting read exposure remains separate: reviewer resolved native Codex to the standalone release whose nearest existing package root is `/home/dains`; root reproduced the whole-home RO mount. Source/Python/RTK visibility is not private credential/company-isolation proof. No broader read-scope repair or new write authority is claimed here.

## Exact reviewed source

- `packages/adapter-utils/src/workspace-custodian-seccomp.ts`: `71caa7c72e91ad1a32e960c0d8f90368d70c00a0082f7d1c1b80b075d2c1c39c`
- `packages/adapter-utils/src/workspace-process-guard.ts`: `c5b428b9dea44157caf45e8304fb5ce1bf55a13a0f83bd4bf30c10f382eac974`
- `packages/adapter-utils/src/workspace-process-guard.test.ts`: `3121f8adabc57b801ac3633ce1452e54994be7dd2ec545d53170f3e6f3b6b9f1`
- `packages/shared/src/agent-safety-presets.ts`: `384510ef59924d946f5ca324527685a2634ce2eff04cd0d618c1d73aecc521e7`
- `packages/shared/src/agent-safety-presets.test.ts`: `62fc01fd255ca3859095a2e5375559631db8dc36bd092a251ccc4dbbc6560cf6`
- `server/src/__tests__/ai-connections.test.ts`: `fd122dba81f5c48d525a5f8aab9526ad2971ba7df188525280e341ffe4a1b37d`
- `server/src/services/workspace-write-ownership.ts`: `1d61d605310ae66e7329eab036f568a067a487c04c5f21a2d9c64dbdbd1dfa91`
- `server/src/__tests__/workspace-write-ownership.test.ts`: `89b2ce10d9adb06b6123f67fb84af778f7d22944636338e9221ec9292d42dadb`
- `server/src/services/workspace-owner-provenance.ts`: `0bec1f902c176d8a6e5c59c518623c777c1aad5067c2c26b3e4d215ecf60bb53`

Hash assertions: `security-review-exact-freeze9.before-probes.json` and `.after-probes.json`. Later source edits require refresh.
