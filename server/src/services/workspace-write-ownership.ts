import { createHash, randomUUID } from "node:crypto";
import path from "node:path";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, projectWorkspaces, workspaceRuntimeServices, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { workspaceNamespaceDrained, type WorkspaceLaunchIdentity, type WorkspaceProcessGuard, type WorkspaceStopObservation } from "@paperclipai/adapter-utils/workspace-process-guard";
import { physicalWorkspaceIdentity } from "./workspace-physical-identity.js";
import { legacyWorkspaceCandidateClosed } from "./legacy-workspace-closure.js";
import { workspaceRunHasTrackedOwner } from "./workspace-owner-provenance.js";
export { physicalWorkspaceIdentity } from "./workspace-physical-identity.js";

type Owner = typeof workspaceWriteOwners.$inferSelect;
export type WorkspaceOwnerHandle = Pick<Owner, "id" | "companyId" | "runId" | "generation">;
const overlaps = (a: string, b: string) => { const rel = path.relative(a, b); return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const privateResources = (owner: Owner) => owner.history.flatMap(event => event.event === "private_roots_reserved" && Array.isArray(event.roots)
  ? event.roots as Array<{ root: string; resourceKey: string }> : []);
const serviceResources = (owner: Owner) => owner.history.flatMap(event => event.kind === "UNPROTECTED_SERVICE" && Array.isArray(event.roots) ? event.roots as Array<{ root: string; resourceKey: string }> : []);
type Resource = { root: string; resourceKey: string };
const sameResource = (a: Resource, b: Resource) => a.root === b.root && a.resourceKey === b.resourceKey;
const rootsConflict = (a: Resource, b: Resource) => a.resourceKey === b.resourceKey || overlaps(a.root, b.root) || overlaps(b.root, a.root);
const ownerResources = (owner: Owner) => [{ root: owner.canonicalRoot, resourceKey: owner.resourceKey }, ...privateResources(owner), ...serviceResources(owner)];
const resourceConflict = (owner: Owner, root: Resource) => ownerResources(owner).some(held => rootsConflict(held, root));

export function workspaceWriteOwnershipService(db: Db) {
  type Tx = Parameters<Parameters<Db["transaction"]>[0]>[0];
  type Identity = Awaited<ReturnType<typeof physicalWorkspaceIdentity>>;
  const selector = (handle: WorkspaceOwnerHandle) => and(eq(workspaceWriteOwners.id, handle.id), eq(workspaceWriteOwners.companyId, handle.companyId), eq(workspaceWriteOwners.runId, handle.runId), eq(workspaceWriteOwners.generation, handle.generation), isNull(workspaceWriteOwners.releasedAt));
  async function observeServiceInTx(tx: Tx, input: { companyId: string; serviceId: string; serviceKey: string; roots: Identity[] }) {
    const identity = input.roots[0]!;
    const held = await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.realm, identity.realm), isNull(workspaceWriteOwners.releasedAt))).for("update");
    const conflicts = held.filter(owner => input.roots.some(root => resourceConflict(owner, root)));
    // Service control authorization remains upstream. This lane records only
    // coexistence of uncontained services, never a protected writer capability.
    if (conflicts.some(owner => owner.state !== "unprotected_service" || !owner.history.some(event => event.kind === "UNPROTECTED_SERVICE"))) return false;
    const event = { kind: "UNPROTECTED_SERVICE", event: "service_lifetime_observed", companyId: input.companyId,
      serviceId: input.serviceId, serviceKey: input.serviceKey, roots: input.roots, at: new Date().toISOString() };
    if (conflicts.length) {
      const owner = conflicts[0]!;
      if (!owner.history.some(prior => prior.kind === event.kind && prior.companyId === input.companyId && prior.serviceId === input.serviceId && prior.serviceKey === input.serviceKey
        && Array.isArray(prior.roots) && prior.roots.length === event.roots.length && prior.roots.every((root: { root: string; resourceKey: string }, index: number) => root.root === event.roots[index]?.root && root.resourceKey === event.roots[index]?.resourceKey))) {
        await tx.update(workspaceWriteOwners).set({ history: [...owner.history, event], updatedAt: new Date() }).where(eq(workspaceWriteOwners.id, owner.id));
      }
    } else {
      await tx.insert(workspaceWriteOwners).values({ resourceKey: identity.resourceKey, realm: identity.realm, canonicalRoot: identity.root,
        device: identity.device, inode: identity.inode, companyId: input.companyId, runId: input.serviceId,
        state: "unprotected_service", history: [event] });
    }
    return true;
  }
  async function transition(handle: WorkspaceOwnerHandle, event: string, change: (owner: Owner, tx: Tx) => Partial<Owner> | null | Promise<Partial<Owner> | null>) {
    return db.transaction(async tx => {
      const owner = (await tx.select().from(workspaceWriteOwners).where(selector(handle)).for("update"))[0];
      if (!owner) throw new Error("workspace_write_owner_generation_mismatch");
      const update = await change(owner, tx);
      if (!update) throw new Error("workspace_write_owner_transition_rejected");
      const at = new Date();
      const [row] = await tx.update(workspaceWriteOwners).set({ ...update, updatedAt: at,
        history: [...(update.history ?? owner.history), { event, at: at.toISOString(), generation: owner.generation, launchId: update.launchId ?? owner.launchId }],
      }).where(selector(handle)).returning();
      return row!;
    });
  }
  const service = {
    async claim(input: { cwd: string; companyId: string; issueId?: string | null; runId: string; observeUnprotected?: boolean }): Promise<{ outcome: "busy" } | { outcome: "claimed"; owner: Owner }> {
      const identity = await physicalWorkspaceIdentity(input.cwd);
      return db.transaction(async tx => {
        // Realm-wide short transaction lock also prevents parent/subdirectory
        // claims from creating separate writing lanes over the same files.
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.realm}, 0))`);
        if (!input.observeUnprotected) {
          // Pre-PC06/Board services may have no initiating run or environment
          // lease. Preserve their uncertain lifetime before deciding admission.
          const services = await tx.select({ service: workspaceRuntimeServices, executionCwd: executionWorkspaces.cwd, projectCwd: projectWorkspaces.cwd })
            .from(workspaceRuntimeServices).leftJoin(executionWorkspaces, eq(workspaceRuntimeServices.executionWorkspaceId, executionWorkspaces.id))
            .leftJoin(projectWorkspaces, eq(workspaceRuntimeServices.projectWorkspaceId, projectWorkspaces.id))
            .where(eq(workspaceRuntimeServices.provider, "local_process"));
          for (const historical of services) {
            const actual = historical.service.cwd ? await physicalWorkspaceIdentity(historical.service.cwd).catch(() => null) : null;
            const declaredPath = historical.executionCwd ?? historical.projectCwd;
            const declared = declaredPath ? await physicalWorkspaceIdentity(declaredPath).catch(() => null) : null;
            const unknown = { ...identity, root: "/", device: "unverified", inode: "unverified",
              resourceKey: createHash("sha256").update(`${identity.realm}:unknown-service:${historical.service.id}`).digest("hex") };
            const roots = actual ? [actual, ...(declared ? [declared] : [])] : [unknown];
            const observed = await observeServiceInTx(tx, { companyId: historical.service.companyId, serviceId: historical.service.id,
              serviceKey: `historical:${historical.service.id}`, roots });
            if (!observed) {
              // A historical process already exists; this is not permission
              // to launch into the protected lane. Retain a separate hazard
              // tombstone so deleting its old service row cannot erase it.
              const first = roots[0]!;
              await tx.insert(workspaceWriteOwners).values({ resourceKey: createHash("sha256").update(`${identity.realm}:historical-service:${historical.service.id}`).digest("hex"),
                realm: identity.realm, canonicalRoot: first.root, device: first.device, inode: first.inode,
                companyId: historical.service.companyId, runId: historical.service.id, state: "unprotected_service",
                history: [{ kind: "UNPROTECTED_SERVICE", event: "historical_service_hazard", serviceId: historical.service.id, roots, at: new Date().toISOString() }],
              }).onConflictDoNothing();
            }
            if (!actual || actual.resourceKey === identity.resourceKey || overlaps(actual.root, identity.root) || overlaps(identity.root, actual.root)
              || (declared && (overlaps(declared.root, identity.root) || overlaps(identity.root, declared.root)))) return { outcome: "busy" as const };
          }
        }
        const held = await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.realm, identity.realm), isNull(workspaceWriteOwners.releasedAt)));
        const conflicts = held.filter(owner => resourceConflict(owner, identity));
        // Native/unsupported isolated lifetimes retain an observation without
        // changing native controller ownership. Same task may reconnect; no
        // protected writer can reinterpret that observation as physical drain.
        if (input.observeUnprotected && conflicts.length === 1) {
          const owner = conflicts[0]!;
          if (owner.state === "unprotected" && owner.resourceKey === identity.resourceKey && owner.companyId === input.companyId && ((owner.issueId && owner.issueId === input.issueId) || owner.runId === input.runId)) return { outcome: "claimed" as const, owner };
        }
        if (conflicts.length) return { outcome: "busy" as const };
        if (!input.observeUnprotected) {
          const local = await tx.select({ run: heartbeatRuns, cwd: executionWorkspaces.cwd }).from(environmentLeases)
            .innerJoin(heartbeatRuns, eq(environmentLeases.heartbeatRunId, heartbeatRuns.id))
            .leftJoin(executionWorkspaces, eq(environmentLeases.executionWorkspaceId, executionWorkspaces.id))
            .where(and(eq(environmentLeases.provider, "local"), ne(heartbeatRuns.id, input.runId)));
          const proven = await tx.select().from(workspaceWriteOwners)
            .where(eq(workspaceWriteOwners.realm, identity.realm));
          for (const candidate of local) {
            if (!candidate.run.processPid && !candidate.run.processGroupId && !candidate.run.processStartedAt && candidate.run.runtimeMode !== "native") continue;
            const snapshot = candidate.run.contextSnapshot as Record<string, unknown> | null;
            const workspace = snapshot?.paperclipWorkspace as Record<string, unknown> | undefined;
            const raw = candidate.cwd ?? (typeof workspace?.cwd === "string" ? workspace.cwd : null);
            // Missing path/deleted root cannot prove disjointness. Logical
            // terminal, parent PID absence, and expired leases are irrelevant.
            const prior = raw ? await physicalWorkspaceIdentity(raw).catch(() => null) : null;
            if (await workspaceRunHasTrackedOwner(tx as unknown as Db, candidate.run, prior, proven, raw ?? undefined)) continue;
            if (!raw) return { outcome: "busy" as const };
            if (prior && await legacyWorkspaceCandidateClosed(tx as unknown as Db, candidate.run, prior, proven)) continue;
            if (!prior || prior.resourceKey === identity.resourceKey || overlaps(prior.root, identity.root) || overlaps(identity.root, prior.root)) return { outcome: "busy" as const };
          }
        }
        const [owner] = await tx.insert(workspaceWriteOwners).values({ resourceKey: identity.resourceKey, realm: identity.realm,
          canonicalRoot: identity.root, device: identity.device, inode: identity.inode,
          companyId: input.companyId, issueId: input.issueId ?? null, runId: input.runId,
          state: input.observeUnprotected ? "unprotected" : "reserved",
          history: [{ event: input.observeUnprotected ? "unprotected_lifetime_observed" : "claimed", at: new Date().toISOString() }],
        }).returning();
        return { outcome: "claimed" as const, owner: owner! };
      });
    },
    async observeService(input: { cwd: string; workspaceCwd: string; companyId: string; serviceId: string; serviceKey: string }) {
      const actual = await physicalWorkspaceIdentity(input.cwd), source = await physicalWorkspaceIdentity(input.workspaceCwd);
      if (!overlaps(source.root, actual.root)) throw new Error("workspace_write_service_cwd_outside_workspace: configure service cwd inside the selected workspace");
      return db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${source.realm}, 0))`);
        return observeServiceInTx(tx, { ...input, roots: [source, actual] });
      });
    },
    async beforeLaunch(handle: WorkspaceOwnerHandle) {
      const launchId = randomUUID();
      await transition(handle, "launch_reserved", owner => owner.state === "reserved" ? { state: "launching", launchId, launchIdentity: null, stopReceipt: null } : null);
      return launchId;
    },
    async reservePrivateRoots(handle: WorkspaceOwnerHandle, candidates: string[]) {
      const roots = (await Promise.all(candidates.map(candidate => physicalWorkspaceIdentity(candidate).catch(() => null)))).filter((root): root is NonNullable<typeof root> => root !== null);
      if (!roots.length) return;
      await db.transaction(async tx => {
        await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${roots[0]!.realm}, 0))`);
        const held = await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.realm, roots[0]!.realm), isNull(workspaceWriteOwners.releasedAt))).for("update");
        const owner = held.find(row => row.id === handle.id && row.generation === handle.generation && row.companyId === handle.companyId && row.runId === handle.runId);
        if (!owner || owner.state !== "reserved") throw new Error("workspace_write_private_root_owner_unverified");
        const retained = privateResources(owner);
        if (roots.some(root => held.some(row => {
          if (row.id !== owner.id || row.generation !== owner.generation) return resourceConflict(row, root);
          // Only an exact private resource in this generation is reentrant.
          // The owner's source/service roots and nonidentical private overlaps
          // still conflict; other owners always retain their full exclusion.
          return [{ root: row.canonicalRoot, resourceKey: row.resourceKey }, ...serviceResources(row)].some(resource => rootsConflict(resource, root))
            || retained.some(resource => !sameResource(resource, root) && rootsConflict(resource, root));
        }))) throw new Error("workspace_write_private_root_source_overlap");
        const added = roots.filter((root, index) => !retained.some(resource => sameResource(resource, root))
          && roots.findIndex(candidate => sameResource(candidate, root)) === index);
        if (!added.length) return;
        await tx.update(workspaceWriteOwners).set({ history: [...owner.history, { event: "private_roots_reserved", roots: added, at: new Date().toISOString() }] }).where(selector(handle));
      });
    },
    async bindLaunch(handle: WorkspaceOwnerHandle, identity: WorkspaceLaunchIdentity) {
      await transition(handle, "launch_bound", owner => ["launching", "stopping"].includes(owner.state) && owner.launchId === identity.launchId ? { state: owner.state === "stopping" ? "stopping" : "active", launchIdentity: identity } : null);
    },
    async bindPayload(handle: WorkspaceOwnerHandle, identity: WorkspaceLaunchIdentity, expectedAgentId?: string) {
      await transition(handle, "payload_bound", async (owner, tx) => {
        if (!(["active", "stopping"].includes(owner.state) && owner.launchId === identity.launchId &&
        identity.payloadPid && identity.payloadStart && identity.payloadMountNamespace && owner.launchIdentity &&
        Object.entries(owner.launchIdentity).every(([key, value]) => (identity as unknown as Record<string, unknown>)[key] === value))) return null;
        const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, owner.runId)).for("share");
        const matchesRun = run && run.companyId === owner.companyId && run.processPid === identity.pid && run.processGroupId === identity.processGroupId && run.processStartedAt;
        if (expectedAgentId && (!matchesRun || run.agentId !== expectedAgentId)) return null;
        const history = matchesRun ? [...owner.history, { event: "run_process_bound", generation: owner.generation, launchId: owner.launchId,
          binding: { companyId: run.companyId, agentId: run.agentId, runId: run.id, processPid: run.processPid,
            processGroupId: run.processGroupId, processStartedAt: run.processStartedAt!.toISOString() } }] : owner.history;
        return { launchIdentity: identity, history };
      });
    },
    async cancelBeforeSpawn(handle: WorkspaceOwnerHandle, launchId: string) {
      await transition(handle, "cancelled_before_spawn", owner => ["launching", "stopping"].includes(owner.state) && owner.launchId === launchId && !owner.launchIdentity
        ? { state: "reserved", launchId: null, stopReceipt: null } : null);
    },
    async waitForStopped(handle: WorkspaceOwnerHandle, requestId: string, aborted: () => boolean) {
      const deadline = Date.now() + 60_000;
      for (;;) {
        if (!aborted()) throw new Error("workspace_write_stop_not_requested");
        const [owner] = await db.select().from(workspaceWriteOwners).where(selector(handle));
        if (!owner || ["unknown", "unprotected"].includes(owner.state)) throw new Error("workspace_write_stop_unverified");
        if (owner.state === "reserved") return service.confirmStopped(handle, requestId);
        if (Date.now() >= deadline) throw new Error("Execution is still stopping; termination has not been verified.");
        await new Promise(resolve => setTimeout(resolve, 10));
      }
    },
    async confirmStopped(handle: WorkspaceOwnerHandle, requestId: string) {
      return db.transaction(async tx => {
        const [owner] = await tx.select().from(workspaceWriteOwners).where(selector(handle)).for("share");
        if (!owner || owner.state !== "reserved") throw new Error("workspace_write_stop_unverified");
        if (!owner.launchId) return { requestId, ownerId: owner.id, generation: owner.generation, launchId: null, proof: "not_launched" as const };
        const identity = owner.launchIdentity as WorkspaceLaunchIdentity | null;
        if (!identity || owner.stopReceipt?.generation !== owner.generation || owner.stopReceipt?.launchId !== owner.launchId ||
          !Object.entries(identity).every(([key, value]) => owner.stopReceipt?.[key] === value) || !await workspaceNamespaceDrained(identity))
          throw new Error("workspace_write_stop_unverified");
        const observedStop = owner.stopReceipt?.stop as WorkspaceStopObservation | undefined;
        return { requestId, ownerId: owner.id, generation: owner.generation, launchId: owner.launchId, proof: "namespace_drained" as const,
          signal: observedStop?.requestId === requestId ? observedStop.signal : null,
          namespaceForced: observedStop?.requestId === requestId ? observedStop.forced : false };
      });
    },
    async markStopping(handle: WorkspaceOwnerHandle, launchId?: string) {
      await transition(handle, "stopping", owner => ["launching", "active", "stopping"].includes(owner.state) && (!launchId || owner.launchId === launchId) ? { state: "stopping" } : null);
    },
    async markUnknown(handle: WorkspaceOwnerHandle, launchId: string) {
      await transition(handle, "unknown", owner => owner.launchId === launchId ? { state: "unknown" } : null);
    },
    async recordDrain(handle: WorkspaceOwnerHandle, identity: WorkspaceLaunchIdentity, stop?: WorkspaceStopObservation) {
      await transition(handle, "namespace_drained", async owner => {
        if (owner.launchId !== identity.launchId) return null;
        if (!owner.launchIdentity || !Object.entries(identity).every(([key, value]) => owner.launchIdentity?.[key] === value))
          throw new Error("workspace_write_namespace_drain_unverified");
        if (!["active", "stopping"].includes(owner.state)) return null;
        if (!await workspaceNamespaceDrained(identity)) throw new Error("workspace_write_namespace_drain_unverified");
        return { state: "reserved", stopReceipt: { ...identity, generation: owner.generation, ...(stop ? { stop } : {}), observedAt: new Date().toISOString() } };
      });
    },
    async releaseIfStopped(handle: WorkspaceOwnerHandle) {
      await transition(handle, "released", owner => owner.state === "reserved" && (!owner.launchId || owner.stopReceipt?.launchId === owner.launchId)
        ? { state: "released", releasedAt: new Date() } : null);
    },
    guard(owner: Owner, signal?: AbortSignal, privateRoots?: string[], stopPolicy?: WorkspaceProcessGuard["stopPolicy"], expectedAgentId?: string): WorkspaceProcessGuard {
      return { root: owner.canonicalRoot, device: owner.device, inode: owner.inode, signal, privateRoots, stopPolicy,
        beforeLaunch: async () => { await service.reservePrivateRoots(owner, privateRoots ?? []); return service.beforeLaunch(owner); }, bindLaunch: identity => service.bindLaunch(owner, identity),
        bindPayload: identity => service.bindPayload(owner, identity, expectedAgentId),
        cancelBeforeSpawn: launchId => service.cancelBeforeSpawn(owner, launchId),
        recordDrain: (identity, stop) => service.recordDrain(owner, identity, stop), markUnknown: launchId => service.markUnknown(owner, launchId),
        markStopping: launchId => service.markStopping(owner, launchId),
      };
    },
  };
  return service;
}
