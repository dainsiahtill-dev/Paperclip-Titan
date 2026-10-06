import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { workspaceNamespaceDrained, type WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { readLegacyWorkspaceHost, legacyClosureError } from "./legacy-workspace-host.js";
import { physicalWorkspaceIdentity } from "./workspace-physical-identity.js";
import { validWorkspaceNamespaceIdentity, workspaceRunHasTrackedOwner } from "./workspace-owner-provenance.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { persistActivity } from "./activity-log.js";

type Request = { companyId: string; cwd: string; ownerId: string; generation: string; launchId: string };
/** Local operator evidence reconciliation. Never accepts a supplied namespace,
 * changes run state, signals a process, deletes history or dispatches work. */
export function workspaceNamespaceClosureService(db: Db, options: { databaseDirectory?: string } = {}) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  const fail = (code: string): never => { throw legacyClosureError(code); };
  async function observed(tx: Tx, request: Request) {
    const host = await readLegacyWorkspaceHost(tx);
    if (options.databaseDirectory && host.database.directory !== options.databaseDirectory) fail("namespace_instance_mismatch");
    const raw = (await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.companyId, request.companyId), eq(workspaceWriteOwners.id, request.ownerId))))[0];
    if (!raw) fail("namespace_owner_missing");
    const run = (await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, request.companyId), eq(heartbeatRuns.id, raw.runId))).for("share"))[0];
    if (!run || !["succeeded", "failed", "timed_out", "interrupted", "cancelled"].includes(run.status)) fail("namespace_run_not_terminal");
    const source = await physicalWorkspaceIdentity(request.cwd);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${source.realm}, 0))`);
    const owner = (await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.companyId, request.companyId), eq(workspaceWriteOwners.id, request.ownerId))).for("update"))[0];
    if (!owner || owner.generation !== request.generation || owner.launchId !== request.launchId || owner.runId !== run.id ||
      owner.canonicalRoot !== source.root || owner.realm !== source.realm || owner.resourceKey !== source.resourceKey || owner.device !== source.device || owner.inode !== source.inode)
      fail("namespace_identity_mismatch");
    const identity = owner.launchIdentity as WorkspaceLaunchIdentity | null;
    if (!identity || !validWorkspaceNamespaceIdentity(identity, owner.launchId)) return fail("namespace_identity_unverified");
    const leases = await tx.select().from(environmentLeases).where(and(eq(environmentLeases.companyId, request.companyId), eq(environmentLeases.heartbeatRunId, run.id))).orderBy(asc(environmentLeases.id)).for("share");
    if (leases.some(lease => !lease.releasedAt || lease.status === "pending_cleanup" || ["pending", "failed"].includes(lease.cleanupStatus ?? ""))) fail("namespace_cleanup_unverified");
    const events = await tx.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, request.companyId), eq(heartbeatRunEvents.runId, run.id))).orderBy(asc(heartbeatRunEvents.seq));
    const stableHost = { uid: host.uid, bootId: host.bootId, pidNamespace: host.pidNamespace, mountNamespace: host.mountNamespace, database: host.database };
    const digest = nativeSha256(JSON.parse(JSON.stringify({ stableHost, source, owner, run, leases, events })));
    let tracked = await workspaceRunHasTrackedOwner(tx, run, source, [owner], request.cwd);
    let originalControllerBootId = run.controllerBootId;
    if (!tracked && run.status === "failed" && run.errorCode === "process_lost") {
      // The reaper claims the row with its new controller ID. Authenticate the
      // retained original launch against its latest host-only event, without
      // rewriting the run or weakening ordinary workspace admission.
      const [original] = await tx.select().from(heartbeatRunEvents).where(and(
        eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.agentId, run.agentId),
        eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, "legacy.process_identity_recorded"),
        eq(heartbeatRunEvents.stream, "system"), isNull(heartbeatRunEvents.sourceEventId),
      )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
      const controller = original?.payload?.controllerBootId;
      if (typeof controller === "string" && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(controller)) {
        tracked = await workspaceRunHasTrackedOwner(tx, { ...run, controllerBootId: controller }, source, [owner], request.cwd);
        if (tracked) originalControllerBootId = controller;
      }
    }
    if (!tracked) fail("namespace_provenance_unverified");
    if (owner.state === "released" && owner.stopReceipt?.verification === "local_operator" &&
      owner.stopReceipt.generation === owner.generation && owner.stopReceipt.launchId === owner.launchId &&
      Object.entries(identity).every(([key, value]) => owner.stopReceipt?.[key] === value) &&
      owner.history.some(event => event.event === "namespace_drained" && event.generation === owner.generation && event.launchId === owner.launchId) &&
      owner.history.some(event => event.event === "released" && event.generation === owner.generation && event.launchId === owner.launchId))
      return { owner, run, identity, host, source, digest, originalControllerBootId, namespaceDrained: true, alreadyClosed: true };
    // A controller lost before its final journal can leave an active owner
    // beside a terminal run. The same exact kernel/provenance checks apply.
    if (!["unknown", "active"].includes(owner.state) || owner.releasedAt || owner.stopReceipt) fail("namespace_provenance_unverified");
    if (identity.bootId !== host.bootId || identity.observerNamespace !== host.pidNamespace || identity.observerMountNamespace !== host.mountNamespace)
      fail("namespace_observer_mismatch");
    return { owner, run, identity, host, source, digest, originalControllerBootId, namespaceDrained: await workspaceNamespaceDrained(identity), alreadyClosed: false };
  }
  return {
    inspect: (request: Request) => db.transaction(async tx => {
      const result = await observed(tx, request);
      return { ...request, digest: result.digest, namespaceDrained: result.namespaceDrained, state: result.owner.state };
    }),
    close: (request: Request & { expectedDigest: string }) => db.transaction(async tx => {
      const result = await observed(tx, request), { owner, identity, host } = result;
      if (result.alreadyClosed) {
        if (owner.stopReceipt?.inputDigest !== request.expectedDigest) fail("namespace_reconciliation_conflict");
        // A completed receipt survives later annotations on the original run.
        // This branch only reads that receipt; it performs no new release.
        return { ...request, state: "released", proof: "namespace_drained" as const, alreadyClosed: true };
      }
      if (result.digest !== request.expectedDigest) fail("namespace_evidence_changed");
      if (!result.namespaceDrained || !await workspaceNamespaceDrained(identity)) fail("namespace_exit_unverified");
      const current = await physicalWorkspaceIdentity(request.cwd);
      if (nativeSha256(current) !== nativeSha256(result.source)) fail("namespace_source_changed");
      const at = new Date();
      await tx.update(workspaceWriteOwners).set({ state: "released", releasedAt: at, updatedAt: at,
        stopReceipt: { ...identity, generation: owner.generation, observedAt: at.toISOString(), verification: "local_operator", inputDigest: request.expectedDigest, originalControllerBootId: result.originalControllerBootId },
        history: [...owner.history, { event: "namespace_drained", at: at.toISOString(), generation: owner.generation, launchId: owner.launchId, verification: "local_operator", inputDigest: request.expectedDigest, originalControllerBootId: result.originalControllerBootId },
          { event: "released", at: at.toISOString(), generation: owner.generation, launchId: owner.launchId }],
      }).where(and(eq(workspaceWriteOwners.id, owner.id), eq(workspaceWriteOwners.generation, owner.generation), eq(workspaceWriteOwners.launchId, request.launchId)));
      await persistActivity(tx as unknown as Db, { companyId: request.companyId, actorType: "system", actorId: `local_workspace_operator:${host.uid}`,
        action: "workspace.namespace_drain_reconciled", entityType: "workspace_write_owner", entityId: owner.id,
        details: { runId: owner.runId, generation: owner.generation, launchId: owner.launchId, inputDigest: request.expectedDigest, proof: "namespace_drained" } });
      return { ...request, state: "released", proof: "namespace_drained" as const, alreadyClosed: false };
    }),
  };
}
