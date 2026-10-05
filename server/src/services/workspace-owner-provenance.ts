import { createHash } from "node:crypto";
import path from "node:path";
import type { WorkspaceLaunchIdentity } from "@paperclipai/adapter-utils/workspace-process-guard";
import { and, desc, eq, isNull } from "drizzle-orm";
import { heartbeatRunEvents, type Db, type heartbeatRuns, type workspaceWriteOwners } from "@paperclipai/db";
import type { PhysicalWorkspaceIdentity } from "./workspace-physical-identity.js";

type Owner = typeof workspaceWriteOwners.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
type TrackedRun = Pick<Run, "id" | "companyId" | "agentId" | "runtimeMode" | "controllerBootId" | "processPid" | "processGroupId" | "processStartedAt">;
export const LEGACY_WORKSPACE_MIGRATION_KIND = "LEGACY_WORKSPACE_MIGRATION";

export function isLegacyWorkspaceMigrationOwner(owner: Pick<Owner, "state" | "history">) {
  return owner.state.startsWith("legacy_migration_") || (Array.isArray(owner.history) && owner.history.some(event => event.kind === LEGACY_WORKSPACE_MIGRATION_KIND));
}

/** Registered lifetimes need actual provenance, not a row with the same run ID.
 * An active unprotected observation accounts for a known source root but never
 * proves physical drain or permits another writer into that held root. */
function durableDrain(owner: Owner, identity: WorkspaceLaunchIdentity) {
  return owner.state === "released" && owner.releasedAt && owner.stopReceipt?.generation === owner.generation
    && Number.isSafeInteger(identity.namespacePid) && identity.namespacePid > 1 && /^\d+$/.test(identity.namespaceStart)
    && /^pid:\[\d+\]$/.test(identity.namespace) && identity.namespace !== identity.observerNamespace
    && /^[a-f0-9-]{36}$/.test(identity.bootId)
    && Object.entries(identity).every(([key, value]) => owner.stopReceipt?.[key] === value)
    && owner.history.some(event => event.event === "namespace_drained" && event.generation === owner.generation && event.launchId === owner.launchId)
    && owner.history.some(event => event.event === "released" && event.generation === owner.generation && event.launchId === owner.launchId);
}

async function priorGuardBinding(tx: Pick<Db, "select">, owner: Owner, run: TrackedRun, identity: WorkspaceLaunchIdentity, stamped: boolean) {
  const launch = owner.history.filter(event => event.event === "launch_bound" && event.generation === owner.generation && event.launchId === owner.launchId).at(-1);
  const sealed = owner.history.filter(event => ["payload_bound", "namespace_drained"].includes(String(event.event)) && event.generation === owner.generation && event.launchId === owner.launchId);
  const end = sealed.find(event => event.event === "payload_bound") ?? sealed.at(-1);
  if (typeof launch?.at !== "string" || typeof end?.at !== "string" || identity.pid !== run.processPid || identity.processGroupId !== run.processGroupId || !run.processStartedAt) return false;
  const first = Date.parse(launch.at), last = Date.parse(end.at);
  if (!Number.isFinite(first) || !Number.isFinite(last) || first > last) return false;
  const [event] = await tx.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.agentId, run.agentId),
    eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, "legacy.process_identity_recorded"), eq(heartbeatRunEvents.stream, "system"), isNull(heartbeatRunEvents.sourceEventId))).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  const namespace = createHash("sha256").update(`${identity.bootId}\n${identity.observerNamespace}`).digest("hex");
  return Boolean(event && (stamped || (event.createdAt.getTime() >= first && event.createdAt.getTime() <= last))
    && event.payload?.localProcess === true && event.payload.localNamespace === namespace
    && event.payload.controllerBootId === run.controllerBootId
    && event.payload.processPid === run.processPid && event.payload.processGroupId === run.processGroupId
    && event.payload.processStartedAt === run.processStartedAt!.toISOString());
}

export async function workspaceRunHasTrackedOwner(tx: Pick<Db, "select">, run: TrackedRun, source: PhysicalWorkspaceIdentity | null, owners: Owner[], rawCwd?: string) {
  for (const owner of owners) {
    if (isLegacyWorkspaceMigrationOwner(owner) || owner.companyId !== run.companyId || owner.runId !== run.id) continue;
    const exactSource = source && source.root === owner.canonicalRoot && source.resourceKey === owner.resourceKey && source.realm === owner.realm && source.device === owner.device && source.inode === owner.inode;
    if (source && !exactSource) continue;
    if (owner.state === "unprotected" && !owner.releasedAt && exactSource && owner.history.some(event => event.event === "unprotected_lifetime_observed")) return true;
    if (run.runtimeMode !== "legacy") continue;
    const identity = owner.launchIdentity as WorkspaceLaunchIdentity | null;
    if (!identity || !owner.launchId || identity.launchId !== owner.launchId) continue;
    const drained = durableDrain(owner, identity);
    // A removed original directory cannot resurrect its verified stopped writer.
    // Live/unknown lifetimes still require current physical source identity.
    if (!source && (!drained || !rawCwd || path.resolve(rawCwd) !== owner.canonicalRoot)) continue;
    const binding = owner.history.filter(event => event.event === "run_process_bound" && event.launchId === owner.launchId && event.generation === owner.generation).at(-1)?.binding as Record<string, unknown> | undefined;
    const bound = binding && binding.companyId === run.companyId && binding.agentId === run.agentId && binding.runId === run.id
      && binding.processPid === run.processPid && binding.processGroupId === run.processGroupId && binding.processStartedAt === run.processStartedAt?.toISOString();
    if ((!bound && !drained) || !await priorGuardBinding(tx, owner, run, identity, Boolean(bound))) continue;
    if (!owner.releasedAt && ["active", "stopping", "unknown", "reserved"].includes(owner.state)) return true;
    // This is an already committed exact namespace-drain receipt, not a new
    // observation in the current boot and never a legacy process-group receipt.
    if (drained) return true;
  }
  return false;
}
