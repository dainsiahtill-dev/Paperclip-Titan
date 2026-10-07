# Deleted workspace host epoch closure — operator runbook

This capability governs the exact captured legacy cohort across one local instance. It preserves each run's company ownership, process uncertainty, history and source bindings. `host_epoch_closed` is host epoch evidence, not a namespace drain receipt, completed source work or Polaris acceptance.

No live host transition has been performed by implementing this capability. CLI checks and simulated service tests do not prove a real kernel epoch change. Source repair, validation, commits and the authorized local Paperclip service update may proceed under the maintenance authorization. A WSL shutdown requires separate explicit approval because it interrupts all workloads in that WSL environment.

Use the existing WSL default3100 instance's private config. Do not select the historical macOS project-management-v3 config, create an instance, bootstrap a database or import old data. Run from the authorized host operator context, without agent credentials or `DATABASE_URL`/`DATABASE_MIGRATION_URL` overrides. The config must be owned by the current UID and inaccessible to group/other users, and must select local embedded PostgreSQL. Boot IDs and namespace facts are read from the kernel and authenticated database; arguments, environment and stdin cannot supply evidence.

## Safe sequence

1. Run read-only inspection against the existing config:

   ```sh
   rtk proxy node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-epoch-closure.ts inspect --config /absolute/path/to/private/config.json
   ```

   Save the complete output in existing private diagnostic storage. Review its cohort, declared source paths, unavailable-source reasons, process tuples, immutable history digests, UID, boot/namespace facts and exact database identity. Record the reviewed `result.digest`. Do not derive proof from process absence, terminal run states, lease releases or old stop markers.

2. Prepare only the reviewed digest:

   ```sh
   rtk proxy node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-epoch-closure.ts prepare --config /absolute/path/to/private/config.json --expected-digest <reviewed-inspection-digest>
   ```

   Save the returned `result.id`, `result.generation`, manifest and digest privately. Preparation establishes an instance dispatch fence for new protected dispatch. It does not stop existing processes, create namespace drain receipts or rewrite historical runs. A changed cohort or unsupported current lifetime must fail closed; never use a force flag or remove the fence through direct database edits.

3. Check the exact record before a host transition:

   ```sh
   rtk proxy node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-epoch-closure.ts status --config /absolute/path/to/private/config.json --id <prepared-id> --generation <prepared-generation>
   ```

   Identify and checkpoint affected workloads, services and active sessions. Prepare a recoverable handoff and obtain explicit approval for the host change. Do not infer approval from source repair authorization or a question about restarting WSL. This CLI never reboots, signals processes, wakes tasks or deletes locks. Restarting Paperclip alone does not change the kernel boot epoch.

4. Only after the approved host change, reconnect to the same authoritative database and original instance. Read the exact status, then close with all saved selectors:

   ```sh
   rtk proxy node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-epoch-closure.ts close --config /absolute/path/to/private/config.json --id <prepared-id> --generation <prepared-generation> --expected-digest <reviewed-inspection-digest>
   ```

   Closure requires a different observed kernel boot ID, unchanged UID/database identity and unchanged captured history. Stale selectors, relocated databases, history drift, new attempts or unsupported processes must fail. Preserve the output and error if rejected; do not edit histories, restore deleted source directories or manufacture proof to make closure pass. A successful close discounts only its authenticated exact cohort and retains every other ownership protection.

5. Independently qualify actual work in the original Polaris source directory. Run one fresh bounded employee task with a versioned report filename. Verify real tool execution and output, v2 digest, drain/release, work-product registration and human review. Historical completed implementation is not replayed, and host closure alone does not establish Polaris delivery.

## Evidence and recovery

Keep inspection, prepared record, exact status, approved workload handoff, post-transition closure and later qualification evidence separately identifiable. Preserve historical runs, ledgers, leases and issue records. Unexpected errors leave the recorded uncertainty unresolved; inspect the exact status before any next action. There is no operator shortcut that supplies a boot ID, declares namespace drain or clears the fence by force.

## Explicitly authorized manual reconciliation

The user's 2026-10-07 instruction to manually open the deadlock authorizes an audited, scoped operator decision based on a preserved backup and live audit. This is a separate policy decision; unresolved host and namespace proof remains recorded. It does not establish zero residual risk, change the kernel epoch, manufacture a drain receipt, alter historical rows or disable global protection.

Inspect the exact authorized company and original physical source root with the separate entry:

```sh
rtk proxy node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-reconcile.ts inspect --config /absolute/path/to/private/config.json --company-id <authorized-company-id> --cwd /absolute/path/to/original/source
```

Save and review the complete inspection and source scope in private diagnostic storage. Bind existing backup/live-audit evidence by its actual file SHA-256, preserve its original path, and record the explicit reason for choosing manual reconciliation. Apply only the reviewed digest and source scope:

```sh
rtk proxy node cli/node_modules/tsx/dist/cli.mjs scripts/workspace-legacy-reconcile.ts reconcile --config /absolute/path/to/private/config.json --company-id <authorized-company-id> --cwd /absolute/path/to/original/source --expected-digest <reviewed-inspection-digest> --reason "Explicit authorized manual decision after backup and live audit; host and namespace proof remains unresolved" --evidence-file /absolute/path/to/private/audit-evidence.json --evidence-sha256 <actual-evidence-file-sha256>
```

The reconciliation record applies only to its exact reviewed cohort, target company and current physical source identity. Other companies, source roots, new attempts, source/history drift and unrelated ownership protections remain governed by ordinary admission. No command reboots, kills processes, wakes a task, increases limits or accepts source work. After the recorded decision, independently verify safe release and actually resume the authorized original Polaris task; tool execution, real output, release, work-product evidence and human acceptance remain required.
