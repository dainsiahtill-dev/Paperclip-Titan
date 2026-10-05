import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { environmentLeases, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { z } from "zod";
import { persistActivity } from "./activity-log.js";
import { physicalWorkspaceIdentity, type PhysicalWorkspaceIdentity } from "./workspace-physical-identity.js";
import { legacyClosureError, readLegacyWorkspaceHost, type LegacyWorkspaceHost } from "./legacy-workspace-host.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { isLegacyWorkspaceMigrationOwner, LEGACY_WORKSPACE_MIGRATION_KIND, workspaceRunHasTrackedOwner } from "./workspace-owner-provenance.js";
export { isLegacyWorkspaceMigrationOwner } from "./workspace-owner-provenance.js";

const KIND = LEGACY_WORKSPACE_MIGRATION_KIND;
type Owner = typeof workspaceWriteOwners.$inferSelect;
type Run = typeof heartbeatRuns.$inferSelect;
// Normalize database Dates before canonical key sorting. JSONB may reorder keys.
const hash = (value: unknown) => nativeSha256(JSON.parse(JSON.stringify(value)));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const intersects = (a: string, b: string) => { const rel = path.relative(a, b); return !rel || (rel !== ".." && !rel.startsWith(`..${path.sep}`) && !path.isAbsolute(rel)); };
const overlap = (a: string, b: string) => intersects(a, b) || intersects(b, a);
const sourceSchema = z.object({ root: z.string(), device: z.string(), inode: z.string(), realm: z.string().regex(/^[a-f0-9]{64}$/), resourceKey: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const hostSchema = z.object({ uid: z.number().int().nonnegative(), bootId: z.string().uuid(), pidNamespace: z.string(), mountNamespace: z.string(),
  database: z.object({ cluster: z.string(), name: z.string(), directory: z.string(), device: z.string(), inode: z.string() }).strict(),
  witness: z.object({ backendPid: z.number().int().positive(), backendStartTicks: z.string(), backendStartedAt: z.string(), postmasterPid: z.number().int().positive(), postmasterStartTicks: z.string() }).strict() }).strict();
const entrySchema = z.object({ companyId: z.string().uuid(), agentId: z.string().uuid(), runId: z.string().uuid(), runDigest: z.string(), leaseDigest: z.string(), ledgerDigest: z.string(), source: sourceSchema,
  process: z.object({ controllerBootId: z.string().uuid(), processPid: z.number().int().min(2).nullable(), processGroupId: z.number().int().min(2).nullable(), processStartedAt: z.string() }).strict(),
  identityEventId: z.number().int().positive(), identityEventSeq: z.number().int().nonnegative() }).strict();
const preparedSchema = z.object({ kind: z.literal(KIND), version: z.literal(1), event: z.literal("prepared"), holdId: z.string().uuid(), generation: z.string().uuid(), maintenanceRunId: z.string().uuid(), source: sourceSchema,
  host: hostSchema, cohort: z.array(entrySchema).nonempty(), digest: z.string(), at: z.string() }).strict();
const closedSchema = z.object({ kind: z.literal(KIND), version: z.literal(1), event: z.literal("host_boot_epoch_closed"), proof: z.literal("host_boot_epoch_closed"),
  holdId: z.string().uuid(), generation: z.string().uuid(), preparedDigest: z.string(), host: hostSchema, at: z.string() }).strict();
type Entry = z.infer<typeof entrySchema>;
const requestSchema = z.object({ companyId: z.string().uuid(), cwd: z.string().min(1) }).strict();
const prepareSchema = requestSchema.extend({ expectedDigest: z.string().regex(/^[a-f0-9]{64}$/) }).strict();
const closeSchema = requestSchema.extend({ holdId: z.string().uuid(), generation: z.string().uuid() }).strict();
const stableHost = (host: LegacyWorkspaceHost) => ({ uid: host.uid, bootId: host.bootId, pidNamespace: host.pidNamespace, mountNamespace: host.mountNamespace, database: host.database });
const sameInstance = (a: LegacyWorkspaceHost, b: LegacyWorkspaceHost) => a.uid === b.uid && same(a.database, b.database);
const digest = (source: PhysicalWorkspaceIdentity, host: LegacyWorkspaceHost, cohort: Entry[]) => hash({ source, host: stableHost(host), cohort });

async function lockedSource(tx: Db, cwd: string) {
  const source = await physicalWorkspaceIdentity(cwd);
  await tx.execute(sql`select set_config('lock_timeout', '1500', true), set_config('statement_timeout', '30000', true)`);
  await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${source.realm}, 0))`);
  if (!same(source, await physicalWorkspaceIdentity(cwd))) throw legacyClosureError("source_identity_changed");
  return source;
}

async function readEntry(tx: Db, runId: string, origin: LegacyWorkspaceHost): Promise<Entry> {
  const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("share");
  if (!run || run.runtimeMode !== "legacy" || !["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(run.status)
    || (!run.processPid && !run.processGroupId) || !run.processStartedAt || !run.controllerBootId) throw legacyClosureError("historical_execution_unverified");
  const leases = await tx.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId)).orderBy(asc(environmentLeases.id)).for("share");
  if (!leases.length || leases.some(lease => lease.companyId !== run.companyId || lease.provider !== "local" || lease.providerLeaseId !== null))
    throw legacyClosureError("historical_execution_unverified");
  const events = await tx.select().from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, runId), eq(heartbeatRunEvents.companyId, run.companyId), eq(heartbeatRunEvents.agentId, run.agentId))).orderBy(asc(heartbeatRunEvents.seq));
  const identities = events.filter(event => event.eventType === "legacy.process_identity_recorded" && event.stream === "system" && event.sourceEventId === null);
  const identity = identities.at(-1);
  const process = { controllerBootId: run.controllerBootId, processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt.toISOString() };
  if (!identity || identity.payload?.localProcess !== true || identity.payload.localNamespace !== createHash("sha256").update(`${origin.bootId}\n${origin.pidNamespace}`).digest("hex")
    || !Object.entries(process).every(([key, value]) => identity.payload?.[key] === value)) throw legacyClosureError("historical_host_unverified");
  const sources: PhysicalWorkspaceIdentity[] = [];
  const snapshot = run.contextSnapshot as Record<string, unknown> | null;
  const workspaceSnapshot = snapshot?.paperclipWorkspace;
  const snapshotCwd = typeof workspaceSnapshot === "object" && workspaceSnapshot && "cwd" in workspaceSnapshot && typeof workspaceSnapshot.cwd === "string" ? workspaceSnapshot.cwd : null;
  for (const lease of leases) {
    const [workspace] = lease.executionWorkspaceId ? await tx.select({ cwd: executionWorkspaces.cwd, companyId: executionWorkspaces.companyId }).from(executionWorkspaces).where(eq(executionWorkspaces.id, lease.executionWorkspaceId)).for("share") : [];
    if (workspace && workspace.companyId !== run.companyId) throw legacyClosureError("historical_execution_unverified");
    const raw = workspace?.cwd ?? snapshotCwd;
    if (!raw) throw legacyClosureError("historical_source_unverified");
    sources.push(await physicalWorkspaceIdentity(raw).catch(() => { throw legacyClosureError("historical_source_unverified"); }));
  }
  if (sources.some(source => !same(source, sources[0]))) throw legacyClosureError("historical_source_unverified");
  return { companyId: run.companyId, agentId: run.agentId, runId, process, source: sources[0]!,
    runDigest: hash(run), leaseDigest: hash(leases), ledgerDigest: hash(events), identityEventId: identity.id, identityEventSeq: identity.seq };
}

async function cohort(tx: Db, source: PhysicalWorkspaceIdentity, companyId: string, origin: LegacyWorkspaceHost, ignoredHold?: string) {
  const owners = await tx.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.realm, source.realm));
  const conflicts = owners.filter(owner => !owner.releasedAt && owner.id !== ignoredHold && [owner.canonicalRoot,
    ...owner.history.flatMap(event => Array.isArray(event.roots) ? event.roots.flatMap(root => typeof root === "object" && root && "root" in root && typeof root.root === "string" ? [root.root] : []) : [])].some(root => overlap(root, source.root)));
  if (conflicts.length) throw legacyClosureError("workspace_held");
  const candidates = await tx.select({ id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId, runtimeMode: heartbeatRuns.runtimeMode, controllerBootId: heartbeatRuns.controllerBootId,
    processPid: heartbeatRuns.processPid, processGroupId: heartbeatRuns.processGroupId, processStartedAt: heartbeatRuns.processStartedAt, cwd: executionWorkspaces.cwd,
    snapshotCwd: sql<string | null>`${heartbeatRuns.contextSnapshot}->'paperclipWorkspace'->>'cwd'` })
    .from(environmentLeases).innerJoin(heartbeatRuns, eq(environmentLeases.heartbeatRunId, heartbeatRuns.id))
    .leftJoin(executionWorkspaces, eq(environmentLeases.executionWorkspaceId, executionWorkspaces.id)).where(eq(environmentLeases.provider, "local"));
  const ids = new Set<string>();
  const roots = new Map<string, PhysicalWorkspaceIdentity>();
  for (const candidate of candidates) {
    if (!candidate.processPid && !candidate.processGroupId && !candidate.processStartedAt && candidate.runtimeMode !== "native") continue;
    const raw = candidate.cwd ?? candidate.snapshotCwd;
    const actual = raw ? roots.get(raw) ?? await physicalWorkspaceIdentity(raw).catch(() => null) : null;
    if (await workspaceRunHasTrackedOwner(tx, candidate, actual, owners, raw ?? undefined)) continue;
    if (!raw || !actual) throw legacyClosureError("historical_source_unverified");
    roots.set(raw, actual);
    if (actual.resourceKey !== source.resourceKey && !overlap(actual.root, source.root)) continue;
    if (candidate.companyId !== companyId) throw legacyClosureError("foreign_workspace_execution");
    ids.add(candidate.id);
  }
  return Promise.all([...ids].sort().map(id => readEntry(tx, id, origin)));
}

function prepared(owner: Owner) {
  const value = preparedSchema.safeParse(owner.history[0]);
  if (!value.success || value.data.digest !== digest(value.data.source, value.data.host, value.data.cohort)
    || value.data.holdId !== owner.id || value.data.generation !== owner.generation || value.data.maintenanceRunId !== owner.runId
    || !same(value.data.source, { root: owner.canonicalRoot, device: owner.device, inode: owner.inode, realm: owner.realm, resourceKey: owner.resourceKey })
    || value.data.cohort.some(entry => entry.companyId !== owner.companyId)) throw legacyClosureError("closure_record_unverified");
  return value.data;
}

/** Narrow admission proof. A maintenance row's runId is never writer authority. */
export async function legacyWorkspaceCandidateClosed(tx: Db, run: Run, source: PhysicalWorkspaceIdentity, owners: Owner[]) {
  for (const owner of owners) {
    if (owner.state !== "legacy_migration_closed" || !owner.releasedAt || owner.companyId !== run.companyId || owner.history.length !== 2 || !isLegacyWorkspaceMigrationOwner(owner)) continue;
    try {
      const capture = prepared(owner), ending = closedSchema.parse(owner.history[1]);
      const expected = capture.cohort.find(entry => entry.runId === run.id);
      if (!expected || !same(expected.source, source) || ending.holdId !== owner.id || ending.generation !== owner.generation
        || ending.preparedDigest !== capture.digest || !sameInstance(capture.host, ending.host) || ending.host.bootId === capture.host.bootId) continue;
      const host = await readLegacyWorkspaceHost(tx);
      if (!sameInstance(capture.host, host) || host.bootId === capture.host.bootId || (await fs.stat(source.root)).uid !== host.uid) continue;
      const current = await Promise.all(capture.cohort.map(entry => readEntry(tx, entry.runId, capture.host)));
      if (same(current, capture.cohort)) return true;
    } catch { /* Unknown or drifted proof retains the original busy gate. */ }
  }
  return false;
}

export function legacyWorkspaceClosureService(db: Db, options: { databaseDirectory?: string } = {}) {
  const scope = z.object({ databaseDirectory: z.string().optional() }).strict().parse(options);
  async function operationHost(tx: Db) {
    const host = await readLegacyWorkspaceHost(tx);
    if (scope.databaseDirectory && host.database.directory !== scope.databaseDirectory) throw legacyClosureError("host_instance_changed");
    return host;
  }
  return {
    async inspect(input: { companyId: string; cwd: string }) {
      const request = requestSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const source = await lockedSource(tx, request.cwd), host = await operationHost(tx);
        if ((await fs.stat(source.root)).uid !== host.uid) throw legacyClosureError("host_operator_required");
        const entries = await cohort(tx, source, request.companyId, host);
        return { source, host, cohort: entries, digest: digest(source, host, entries), requiresHostEpochChange: entries.length > 0 };
      });
    },
    async prepare(input: { companyId: string; cwd: string; expectedDigest: string }) {
      const request = prepareSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const source = await lockedSource(tx, request.cwd), host = await operationHost(tx);
        if ((await fs.stat(source.root)).uid !== host.uid) throw legacyClosureError("host_operator_required");
        const entries = await cohort(tx, source, request.companyId, host);
        const observed = digest(source, host, entries);
        if (observed !== request.expectedDigest) throw legacyClosureError("inspection_changed");
        if (!entries.length) throw legacyClosureError("no_historical_execution");
        const at = new Date(), holdId = randomUUID(), generation = randomUUID(), maintenanceRunId = randomUUID();
        const event = preparedSchema.parse({ kind: KIND, version: 1, event: "prepared", holdId, generation, maintenanceRunId, source, host, cohort: entries, digest: observed, at: at.toISOString() });
        const [owner] = await tx.insert(workspaceWriteOwners).values({ id: holdId, generation, companyId: request.companyId, runId: maintenanceRunId, state: "legacy_migration_hold",
          canonicalRoot: source.root, resourceKey: source.resourceKey, realm: source.realm, device: source.device, inode: source.inode, history: [event] }).returning();
        if (!owner) throw legacyClosureError("closure_record_unverified");
        await persistActivity(tx, { companyId: owner.companyId, actorType: "system", actorId: `local_workspace_operator:${host.uid}`,
          action: "workspace.legacy_closure_prepared", entityType: "workspace_write_owner", entityId: owner.id,
          details: { digest: observed, cohortRunIds: entries.map(entry => entry.runId), sourceRoot: source.root, capturedBootId: host.bootId } });
        return owner;
      });
    },
    async close(input: { companyId: string; cwd: string; holdId: string; generation: string }) {
      const request = closeSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const source = await lockedSource(tx, request.cwd), host = await operationHost(tx);
        const [owner] = await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.id, request.holdId), eq(workspaceWriteOwners.companyId, request.companyId), eq(workspaceWriteOwners.generation, request.generation))).for("update");
        if (!owner || !isLegacyWorkspaceMigrationOwner(owner)) throw legacyClosureError("selector_mismatch");
        const capture = prepared(owner);
        if (!same(source, capture.source)) throw legacyClosureError("source_identity_changed");
        if (!sameInstance(capture.host, host)) throw legacyClosureError("host_instance_changed");
        if ((await fs.stat(source.root)).uid !== host.uid) throw legacyClosureError("source_identity_changed");
        if (host.bootId === capture.host.bootId) throw legacyClosureError("host_epoch_unchanged");
        let current: Entry[];
        try { current = await cohort(tx, source, request.companyId, capture.host, owner.id); }
        catch { throw legacyClosureError("cohort_changed"); }
        if (!same(current, capture.cohort)) throw legacyClosureError("cohort_changed");
        if (owner.state === "legacy_migration_closed" && owner.releasedAt && owner.history.length === 2) {
          const ending = closedSchema.safeParse(owner.history[1]);
          if (ending.success && ending.data.holdId === owner.id && ending.data.generation === owner.generation && ending.data.preparedDigest === capture.digest
            && sameInstance(capture.host, ending.data.host) && ending.data.host.bootId !== capture.host.bootId) return owner;
        }
        if (owner.state !== "legacy_migration_hold" || owner.releasedAt || owner.history.length !== 1 || owner.launchId || owner.launchIdentity || owner.stopReceipt)
          throw legacyClosureError("closure_record_unverified");
        const at = new Date(), ending = closedSchema.parse({ kind: KIND, version: 1, event: "host_boot_epoch_closed", proof: "host_boot_epoch_closed",
          holdId: owner.id, generation: owner.generation, preparedDigest: capture.digest, host, at: at.toISOString() });
        const [closed] = await tx.update(workspaceWriteOwners).set({ state: "legacy_migration_closed", releasedAt: at, updatedAt: at, history: [...owner.history, ending] })
          .where(and(eq(workspaceWriteOwners.id, owner.id), eq(workspaceWriteOwners.generation, owner.generation), eq(workspaceWriteOwners.state, "legacy_migration_hold"), isNull(workspaceWriteOwners.releasedAt))).returning();
        if (!closed) throw legacyClosureError("selector_mismatch");
        await persistActivity(tx, { companyId: owner.companyId, actorType: "system", actorId: `local_workspace_operator:${host.uid}`,
          action: "workspace.legacy_host_epoch_closed", entityType: "workspace_write_owner", entityId: owner.id,
          details: { generation: owner.generation, preparedDigest: capture.digest, previousBootId: capture.host.bootId, observedBootId: host.bootId, proof: "host_boot_epoch_closed" } });
        return closed;
      });
    },
  };
}
