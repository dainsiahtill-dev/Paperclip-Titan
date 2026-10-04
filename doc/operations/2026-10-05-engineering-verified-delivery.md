# Engineering verified delivery (PC-07)

The optional `deliveryPolicy.engineeringEvidence.version: 1` extends the existing
`verified_delivery` authority. Ordinary `agent_claim_policy`, Board review authority,
independent reviewer checks, material versions and `issue_delivery_decisions` remain
in place. No additional acceptance ledger exists.

## Configure and use

In the project's Configuration tab, use **工程交付预设**. Board selects the exact
execution workspace, implementation files, tests, harness/configuration files and
dependency manifests, plus the existing approved workspace job IDs and their roles.
The required roles include `test` and `verifier`; `build` is optional. Configure
meaningful commands in the workspace before using the preset. Merely assigning
`true` the role `test` proves no requirements: independent semantic review remains
mandatory. The policy does not classify commands by their names or substrings.

Each file is an explicit workspace-relative path. The scope allows at most 128
unique nonempty text files, the existing preview reader's per-file limits, and 4 MB total.
There is no directory/glob expansion. The existing reader rejects secret paths,
escaping symlinks, unsupported content and remote workspaces. Implementation,
test, harness and manifest roles must all be present. The task must explicitly
bind the chosen workspace in the same company/project. Policy inheritance unions
required files/jobs; conflicting targets or roles fail closed. Agent managers
cannot edit engineering scope/roles or relocate a task to evade them.

Wait for the existing source writer to drain. Use the execution workspace's
**Run** action for every approved job. HTTP authorization supplies the actual
issue, workspace and principal. Agent execution requires its current registered
run bound to that issue. A Board execution records its principal and a null
heartbeat run; the guard's private lifecycle UUID is never relabeled a run.
Jobs on an active source writer return `workspace_write_owner_busy`; wait for
that owner to stop. Do not replace its PID or join its ownership generation.

Submit **one primary managed issue document**, containing JSON like:

```json
{
  "version": 1,
  "executionWorkspaceId": "<selected workspace UUID>",
  "operationIds": ["<inner test operation UUID>", "<inner verifier operation UUID>"],
  "unresolvedLimits": "Describe coverage limits and unresolved product concerns."
}
```

Use the nested operation IDs returned by the existing runtime command operation.
The outer operation is control-flow bookkeeping and cannot replace its inner job.
The document is a reference request; its immutable content fingerprint binds each
review. Extra fields such as `passed`, `exitCode`, source hashes or reviewer names
are rejected. Current document revisions are inspected through the existing
material authority. Attachments, arbitrary summaries, mutable remote URLs and
workspace files are not v1 engineering bundle formats. They still retain their
ordinary material semantics outside this preset.

The configured independent reviewer inspects requirements, implementation, actual
assertions, verifier quality, user-facing behavior and the stated limits, then
uses the existing criterion acceptance action. The executor, material author and
actual agent job executor cannot accept their own engineering deliverable. Board
retains its existing authority. An exit code alone never approves a criterion.

## What the host proves

For supported local Linux jobs, the existing physical owner is claimed before
source capture. The child mounts the pinned source directory descriptor read-only,
with dropped capabilities and disabled nested user namespaces. It cannot change
and restore source during its test. Temporary output is available in private
sandbox `/tmp`; `TMPDIR`, `TMP`, `TEMP` and `PAPERCLIP_TEST_OUTPUT_DIR` select it.
Commands requiring output in the source directory fail and must be configured
with a separate temporary output path. Fixed cwd and no command/adapter environment
overlays are supported initially. Toolchains must already be present in accessible
read-only mounts; this feature installs nothing and imports no credentials.

The guard holds managed-writer exclusion through post-run source capture, actual
namespace drain and operation finalization. Only the inner host job writes typed
receipt metadata. Existing `workspace_operations` retains the authenticated
owner, approved definition/role, actual exit, bounded sanitized log and source
scope digest; the existing physical owner retains the read-only launch and drain
identity. Failure, timeout or uncertain drain does not qualify.

The source digest covers exact selected working-file bytes, including selected
uncommitted/untracked edits. It is **not a clean Git status or whole-repository
hash**. No Git hooks, repository configuration, unbounded scan, `.env` or auth files
are read to manufacture such a claim. Board must include the relevant test,
implementation, harness and manifest files; review must assess whether that scope
and those tests actually establish the requirements.

This is a managed, single-instance, single-Linux-realm guarantee. External manual
writers, other databases, distributed hosts and arbitrary system effects are not
excluded. It does not prove global filesystem immutability.

## Revalidation and limits

Assessment, accepted-decision admission and completion use the same resolver.
It reclaims a short managed source read interval, reloads exact company/issue/
workspace ownership, current job definition and policy, rereads authorized source,
checks the durable read-only namespace drain, and hashes the bounded stored log.
The validated evidence digest joins the existing material digest. Source, rule,
job, operation or log drift invalidates prior acceptance even when the bundle's
JSON bytes do not change. Source-busy, missing logs, failed jobs and denied paths
remain visible with a remedy; the acceptance button cannot approve unverified
engineering evidence.

Historical/unbound jobs, generic MCP JSON, provider command notifications, native
run success, outer control success and `workspace_finalize` do not qualify.
Remote/native/shared uncertain lifetimes have no supported engineering receipt.
A drained local directory may qualify regardless of its workspace display mode;
the actual host ownership and read-only boundary determine support.

No actual Polaris project, Bench run, production provider, browser/user-flow or
unattended factory qualification is implied by these platform tests. Runtime
source/job/log drift is detected when assessed or completion is attempted; there
is no new filesystem watcher or automatic project-wide re-review scheduler.
