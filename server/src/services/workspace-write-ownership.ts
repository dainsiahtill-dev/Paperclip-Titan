import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, eq, isNull, ne, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRuns, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { workspaceNamespaceDrained, type WorkspaceLaunchIdentity, type WorkspaceProcessGuard } from "@paperclipai/adapter-utils/workspace-process-guard";

type Owner = typeof workspaceWriteOwners.$inferSelect;
export type WorkspaceOwnerHandle = Pick<Owner, "id" | "companyId" | "runId" | "generation">;
const overlaps = (a: string, b: string) => { const rel = path.relative(a, b); return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const privateResources = (owner: Owner) => owner.history.flatMap(event => event.event === "private_roots_reserved" && Array.isArray(event.roots)
  ? event.roots as Array<{ root: string; resourceKey: string }> : []);

export async function physicalWorkspaceIdentity(cwd: string) {
  if (process.platform !== "linux") throw new Error("workspace_write_ownership_unsupported_host");
  const root = await fs.realpath(cwd);
  const stat = await fs.stat(root);
  if (!stat.isDirectory() || root === "/") throw new Error("workspace_write_ownership_invalid_root");
  // One local storage realm; company/project/PID namespace never partition it.
  const machine = (await fs.readFile("/etc/machine-id", "utf8")).trim();
  if (!/^[a-f0-9]{32}$/.test(machine)) throw new Error("workspace_write_ownership_unverified_realm");
  const realm = createHash("sha256").update(`linux-local:${machine}`).digest("hex");
  const device = String(stat.dev), inode = String(stat.ino);
  const resourceKey = createHash("sha256").update(`${realm}:${device}:${inode}`).digest("hex");
  return { root, device, inode, realm, resourceKey };
}

export function workspaceWriteOwnershipService(db: Db) {
  const selector = (handle: WorkspaceOwnerHandle) => and(eq(workspaceWriteOwners.id, handle.id), eq(workspaceWriteOwners.companyId, handle.companyId), eq(workspaceWriteOwners.runId, handle.runId), eq(workspaceWriteOwners.generation, handle.generation), isNull(workspaceWriteOwners.releasedAt));
  async function transition(handle: WorkspaceOwnerHandle, event: string, change: (owner: Owner) => Partial<Owner> | null) {
    return db.transaction(async tx => {
      const owner = (await tx.select().from(workspaceWriteOwners).where(selector(handle)).for("update"))[0];
      if (!owner) throw new Error("workspace_write_owner_generation_mismatch");
      const update = change(owner);
      if (!update) throw new Error("workspace_write_owner_transition_rejected");
      const at = new Date();
      const [row] = await tx.update(workspaceWriteOwners).set({ ...update, updatedAt: at,
        history: [...owner.history, { event, at: at.toISOString(), generation: owner.generation, launchId: update.launchId ?? owner.launchId }],
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
        const held = await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.realm, identity.realm), isNull(workspaceWriteOwners.releasedAt)));
        const conflicts = held.filter(owner => owner.resourceKey === identity.resourceKey || overlaps(owner.canonicalRoot, identity.root) || overlaps(identity.root, owner.canonicalRoot)
          || privateResources(owner).some(root => root.resourceKey === identity.resourceKey || overlaps(root.root, identity.root) || overlaps(identity.root, root.root)));
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
          const proven = await tx.select({ runId: workspaceWriteOwners.runId }).from(workspaceWriteOwners)
            .where(eq(workspaceWriteOwners.realm, identity.realm));
          const tracked = new Set(proven.map(row => row.runId));
          for (const candidate of local) {
            if (tracked.has(candidate.run.id) || (!candidate.run.processPid && candidate.run.runtimeMode !== "native")) continue;
            const snapshot = candidate.run.contextSnapshot as Record<string, unknown> | null;
            const workspace = snapshot?.paperclipWorkspace as Record<string, unknown> | undefined;
            const raw = candidate.cwd ?? (typeof workspace?.cwd === "string" ? workspace.cwd : null);
            // Missing path/deleted root cannot prove disjointness. Logical
            // terminal, parent PID absence, and expired leases are irrelevant.
            if (!raw) return { outcome: "busy" as const };
            const prior = await physicalWorkspaceIdentity(raw).catch(() => null);
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
        if (roots.some(root => held.some(row => row.resourceKey === root.resourceKey || overlaps(row.canonicalRoot, root.root) || overlaps(root.root, row.canonicalRoot)))) throw new Error("workspace_write_private_root_source_overlap");
        await tx.update(workspaceWriteOwners).set({ history: [...owner.history, { event: "private_roots_reserved", roots, at: new Date().toISOString() }] }).where(selector(handle));
      });
    },
    async bindLaunch(handle: WorkspaceOwnerHandle, identity: WorkspaceLaunchIdentity) {
      await transition(handle, "launch_bound", owner => owner.state === "launching" && owner.launchId === identity.launchId ? { state: "active", launchIdentity: identity } : null);
    },
    async markStopping(handle: WorkspaceOwnerHandle) {
      await transition(handle, "stopping", owner => ["launching", "active", "stopping"].includes(owner.state) ? { state: "stopping" } : null);
    },
    async markUnknown(handle: WorkspaceOwnerHandle, launchId: string) {
      await transition(handle, "unknown", owner => owner.launchId === launchId ? { state: "unknown" } : null);
    },
    async recordDrain(handle: WorkspaceOwnerHandle, identity: WorkspaceLaunchIdentity) {
      if (!await workspaceNamespaceDrained(identity)) throw new Error("workspace_write_namespace_drain_unverified");
      await transition(handle, "namespace_drained", owner => ["active", "stopping"].includes(owner.state) && owner.launchId === identity.launchId
        && Object.entries(identity).every(([key, value]) => owner.launchIdentity?.[key] === value)
        ? { state: "reserved", stopReceipt: { ...identity, generation: owner.generation, observedAt: new Date().toISOString() } } : null);
    },
    async releaseIfStopped(handle: WorkspaceOwnerHandle) {
      await transition(handle, "released", owner => owner.state === "reserved" && (!owner.launchId || owner.stopReceipt?.launchId === owner.launchId)
        ? { state: "released", releasedAt: new Date() } : null);
    },
    guard(owner: Owner, signal?: AbortSignal, privateRoots?: string[]): WorkspaceProcessGuard {
      return { root: owner.canonicalRoot, device: owner.device, inode: owner.inode, signal, privateRoots,
        beforeLaunch: async () => { await service.reservePrivateRoots(owner, privateRoots ?? []); return service.beforeLaunch(owner); }, bindLaunch: identity => service.bindLaunch(owner, identity),
        recordDrain: identity => service.recordDrain(owner, identity), markUnknown: launchId => service.markUnknown(owner, launchId),
        markStopping: () => service.markStopping(owner),
      };
    },
  };
  return service;
}
