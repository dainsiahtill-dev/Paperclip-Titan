# Physical workspace writing ownership

The initial protected execution boundary is one Paperclip instance and database,
one Linux local storage realm, and supported legacy CLI processes. It uses the
canonical source directory plus device/inode identity across project IDs,
company IDs and symlink aliases. Parent and child source directories conflict.
This is whole-directory managed-process exclusion, not per-file authorization,
rollback, or exclusion of arbitrary external editors and other Paperclip databases.

`workspace_write_owners` retains immutable company/issue/run identities without
cascading foreign keys. Its generation is independent of the controller lease.
Neither elapsed time, a terminal run, deleted entity, server restart, nor an old
PID's absence frees a source root. Claim and lifecycle history commit atomically.
Cross-company conflicts return an opaque busy result.

Before every supported spawn, the host reserves a launch generation. The guard
pins source and authorized private runtime directory FDs, starts Bubblewrap with
a PID namespace and no nested user namespaces, and captures its exact boot,
namespace-init PID/start identity and namespace inode. The provider stays behind
both a Bubblewrap block FD and an explicit nonce ACK on stdin. After namespace
ownership and run process metadata commit, the outer gate opens only far enough
to start the fixed host bootstrap. The host validates its unique direct-child
PID/start, PID/mount namespace, fixed script and current launch nonce, then binds
that payload identity to the same ownership generation before the inner ACK.
No adapter output supplies this identity. EOF is not ACK. A controller
death before ACK cannot execute an argv writer. Loader and shell startup hooks
are removed before the outer sandbox process starts. The remaining provider
stdin follows the ACK line unchanged.

Public Stop and Pause register and signal the existing host execution control,
even when the CLI adapter has no optional readiness callback. For a fully bound
Codex payload, Stop sends SIGINT to that exact verified payload; other supported
local CLIs use their normal termination signal. The configured grace and the
existing per-cancel bound apply once, without extension by duplicate requests.
If needed, the host then kills the exact namespace init and wrapper. Before the
inner ACK, cancellation never grants permission to execute the provider.

A same-host observer must verify the matching namespace is drained before
recording a stop receipt. Stop acknowledgement references the current run,
request, ownership generation and latest launch. Duplicate requests join the
same cancellation settlement and share a failure; delayed adapter results
cannot overwrite it as success. Missing identity or failed drain persistence
retains an unknown hold and cannot produce an acknowledgement. Historical
records without a payload identity cannot claim a verified graceful interrupt.
Raw Bubblewrap exit values remain raw, and physical stop does not certify that
a CLI session was preserved; a forced stop never fabricates session continuity.
Adapter return alone cannot release ownership. Sequential helper launches use
distinct launch IDs; an overlapping helper is refused while another is active.
No auxiliary PID can overwrite an active provider identity. Failed identity
commits or uncertain stop observations retain an `unknown` hold.

Supported local Codex/Claude CLI and Hermes processes use the host guard through
both async execution context and explicit process options. Codex and Claude
require an explicitly selected CLI engine. ACP, retained native shared runners,
remote shared roots and unknown adapters fail closed for protected shared mode.
`auto` serializes. Explicit shared `allow` is preserved in storage but rejected
with a configuration-incomplete reason; select `serialize` or task-owned
isolation. Supported local legacy isolated writers use the same physical
registry, so a different workspace classification cannot bypass aliases.

Native/unsupported isolated lifetimes retain an `unprotected` observation. A
same-task native reconnect can reuse that observation without changing native
ownership/hotrestart behavior. It cannot overlap a protected writer. This first
slice does not automatically release such observations using parent-only native
or service stop evidence. Preexisting untracked local process/native rows with
matching or unverifiable roots also block protected admission. A new, disjoint
task-owned root is the supported escape from uncertain historical ownership;
there is no automatic TTL reclaim or force-unlock endpoint.

An explicit local upgrade-maintenance entry can capture an exact legacy cohort
and source hold, then close it only after a genuinely ended host kernel boot
epoch on the same database/host/source identity. The independent host-epoch proof
does not upgrade an old group-stop record into a namespace receipt. Genuine
already-recorded guarded namespace drain remains durable across boots; older
guarded rows require authenticated process-ledger linkage when they lack the new
binding stamp. New source/identity/ledger drift refuses reuse. See
`2026-10-06-legacy-workspace-upgrade-governance.md`; real WSL maintenance requires
a separately approved window and does not automatically retry business tasks.

Writable local stdio is a separate HTTP lifetime. It registers an unprotected
observation before spawn and refuses to join a protected owner. Read-only
governed stdio retains its existing read-only boundary. Long-lived local runtime
services likewise register an unprotected observation at the actual spawn
boundary when a database is supplied, and cannot start inside a guarded call.
Service observations use a distinct server-owned `UNPROTECTED_SERVICE` cohort.
Already-authorized service retries, multiple services, and healthy adoption can
append their exact service identity and canonical roots to that cohort. They do
not replace or release earlier observations, join a protected/unknown writer, or
claim exclusivity between uncontained services. Native and stdio admission do
not acquire this service-only reentry behavior.

Protected admission also reconciles persisted local runtime-service rows,
including Board starts with no run, before granting the first source owner.
Logical stopped status, deleted initiating runs, and absent parent PIDs do not
prove descendant drain. An unresolved historical root retains a conservative
realm-wide hazard; deleting its old service row cannot remove that hazard.
Healthy in-memory reuse, registry adoption and startup reconciliation register
the same observations before returning success.

New service cwd must canonically remain inside its selected workspace. Absolute
or `../` paths and symlink aliases resolving outside it fail before raw spawn
with `workspace_write_service_cwd_outside_workspace`; move the service or select
its actual workspace. The observation covers the selected source root and actual
service cwd. Stored configuration is not silently rewritten.
A service writing the same source root can therefore prevent a protected agent
from starting; separate its runtime root until its full lifetime is contained.
Standalone internal helpers without a database are outside instance ownership.

Board-configured workspace jobs now obtain a separate physical owner and execute
through the same guard. The two HTTP route callers pass their instance DB.
`workspaceWriteOwnershipService(db).claim`, `.guard`, `.recordDrain` and
`.releaseIfStopped` form the host-only seam for other host jobs. `executeProcess`
uses the guard when called in that context. A job cannot run over an active agent
writer, including its own issue. A command-recorder timeout is not physical stop;
an active/uncertain owner remains held. This seam produces no engineering
acceptance receipt or immutable-source claim. Task 6 must bind approved job,
authorized actor/run, source interval and command result separately.

Protected heartbeat onSpawn must return the matching running company/agent/run
and PID/process-group identity. A zero-row metadata update is a refused bind,
just like a thrown persistence error: no ACK, no provider write, retained unknown
physical ownership. Deleting a run after an acknowledged launch still cannot
cascade away that ownership.

The current job entry accepts `db`, `actor.companyId`, `issue` and a realized
`workspace`; its physical owner uses a generated job UUID, not an authenticated
heartbeat-run binding. Route recorder metadata supplies the existing workspace
and job identifiers. Task 6 must add the actual authorization-derived run/issue
binding before treating a job result as that run's evidence. Calling a job while
the same agent still owns the source root returns busy: use a host-created
immutable snapshot with its own owner, or execute after the original lifetime
has drained. There is no reentrant bypass, shared primary PID, or implicit
source-interval acceptance. A before/after digest alone remains unverified.

Private writable runtime paths are exact server-derived managed Codex homes,
per-run scratch directories and managed AI credential directories. They are
canonical, same-uid, FD-pinned and disjoint from the source root. Their resources
are reserved in the owner's durable history under the
same realm lock, so a later task cannot claim one as a source workspace. Another
held source root cannot be admitted as a private runtime mount. Arbitrary extra
writable roots, broad host HOME, writable ancestor mounts and path aliases are
unsupported. An external credential symlink target is not copied or made
writable to manufacture support. Existing auth selection is preserved; an
unsupported layout fails explicitly. Host jobs currently inherit the restricted
filesystem: commands requiring additional executable/cache mounts may need a
separately validated host runtime layout.

A reserved owner may reuse the same canonical and physical private directory in
the same generation across sequential contained launches. Repeated reservation
does not append duplicate history or release the directory between launches.
Its source/service roots, nonidentical private overlaps, other owners and unknown
holds still conflict. Final release requires the latest launch's verified drain.

The physical fixtures cover actual delayed writes, same-file heartbeat
contention across workspace IDs, alias/company contention, escaped `setsid`
children, controller death before and after ACK, DB identity-commit failure,
old generations, directory replacement, entity deletion, host-job contention,
and the actual Codex CLI adapter with a fake executable and managed-home writes.
They use isolated temporary databases/directories and no model/provider calls.
