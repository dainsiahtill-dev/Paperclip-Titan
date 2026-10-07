import { randomUUID } from "node:crypto";
import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { z } from "zod";
import { environmentLeases, executionWorkspaces, heartbeatRunEvents, heartbeatRuns, legacyWorkspaceEpochClosures,
  projectWorkspaces, workspaceRuntimeServices, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { persistActivity } from "./activity-log.js";
import { legacyClosureError, readLegacyWorkspaceHost, type LegacyWorkspaceHost } from "./legacy-workspace-host.js";
import { nativeSha256 } from "./native-runtime/canonical.js";
import { physicalWorkspaceIdentity } from "./workspace-physical-identity.js";
import { workspaceRunHasTrackedOwner } from "./workspace-owner-provenance.js";

const KIND = "LEGACY_WORKSPACE_EPOCH_CLOSURE";
const hash = (value: unknown) => nativeSha256(JSON.parse(JSON.stringify(value)));
const same = (a: unknown, b: unknown) => hash(a) === hash(b);
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const hostSchema = z.object({ uid: z.number().int().nonnegative(), bootId: z.string().uuid(),
  pidNamespace: z.string().regex(/^pid:\[\d+\]$/), mountNamespace: z.string().regex(/^mnt:\[\d+\]$/),
  database: z.object({ cluster: z.string().min(1), name: z.string().min(1), directory: z.string().min(1), device: z.string(), inode: z.string() }).strict(),
  witness: z.object({ backendPid: z.number().int().min(2), backendStartTicks: z.string().regex(/^\d+$/), backendStartedAt: z.string(),
    postmasterPid: z.number().int().min(2), postmasterStartTicks: z.string().regex(/^\d+$/) }).strict() }).strict();
const sourceSchema = z.object({ leaseId: z.string().uuid(), executionWorkspaceId: z.string().uuid().nullable(),
  projectWorkspaceId: z.string().uuid().nullable(), cwd: z.string().nullable(),
  sourceUnavailable: z.enum(["no_cwd", "missing_root", "access_denied", "invalid_root", "source_unverified"]) }).strict();
const entrySchema = z.object({ runId: z.string().uuid(), companyId: z.string().uuid(), agentId: z.string().uuid(),
  process: z.object({ controllerBootId: z.string().uuid().nullable(), processPid: z.number().int().min(2).nullable(),
    processGroupId: z.number().int().min(2).nullable(), processStartedAt: z.string().nullable() }).strict(),
  snapshotCwd: z.string().nullable(), sources: z.array(sourceSchema).nonempty(),
  runDigest: sha, leaseDigest: sha, ledgerDigest: sha, workspaceDigest: sha }).strict();
const manifestSchema = z.object({ kind: z.literal(KIND), version: z.literal(1), event: z.literal("prepared"),
  id: z.string().uuid(), generation: z.string().uuid(), realm: sha, host: hostSchema,
  cohort: z.array(entrySchema).nonempty(), digest: sha, at: z.string().datetime() }).strict();
const closureSchema = z.object({ kind: z.literal(KIND), version: z.literal(1), event: z.literal("host_epoch_closed"),
  proof: z.literal("host_epoch_closed"), id: z.string().uuid(), generation: z.string().uuid(), realm: sha,
  preparedDigest: sha, host: hostSchema, at: z.string().datetime() }).strict();
const selectorSchema = z.object({ id: z.string().uuid(), generation: z.string().uuid() }).strict();
const prepareSchema = z.object({ expectedDigest: sha }).strict();
const closeSchema = selectorSchema.extend({ expectedDigest: sha }).strict();
type Entry = z.infer<typeof entrySchema>;
type Row = typeof legacyWorkspaceEpochClosures.$inferSelect;
const stableHost = (host: LegacyWorkspaceHost) => ({ uid: host.uid, bootId: host.bootId, pidNamespace: host.pidNamespace,
  mountNamespace: host.mountNamespace, database: host.database });
const sameInstance = (a: LegacyWorkspaceHost, b: LegacyWorkspaceHost) => a.uid === b.uid && same(a.database, b.database);
const digest = (realm: string, host: LegacyWorkspaceHost, cohort: Entry[]) => hash({ realm, host: stableHost(host), cohort });
const terminal = (status: string) => ["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(status);

function snapshotCwd(run: typeof heartbeatRuns.$inferSelect) {
  const workspace = run.contextSnapshot?.paperclipWorkspace;
  return typeof workspace === "object" && workspace !== null && "cwd" in workspace && typeof workspace.cwd === "string" ? workspace.cwd : null;
}

async function unavailable(cwd: string | null): Promise<Entry["sources"][number]["sourceUnavailable"] | null> {
  if (!cwd) return "no_cwd";
  try { await physicalWorkspaceIdentity(cwd); return null; }
  catch (error) {
    const code = error instanceof Error && "code" in error ? error.code : undefined;
    if (code === "ENOENT" || code === "ENOTDIR") return "missing_root";
    if (code === "EACCES" || code === "EPERM") return "access_denied";
    if (error instanceof Error && error.message === "workspace_write_ownership_invalid_root") return "invalid_root";
    return "source_unverified";
  }
}

/** All run/lease/event history and workspace source bindings are sealed.
 * Workspace display/runtime metadata can change independently of an exited
 * writer; it is not lifetime evidence. Admission reuses unavailability facts:
 * recreating a path
 * cannot revive a lifetime ended by the independently witnessed host epoch. */
async function readEntry(tx: Db, runId: string, captured?: Entry): Promise<Entry | null> {
  // FK lease inserts acquire KEY SHARE on the run. SHARE is compatible and
  // permits a phantom lease after this snapshot; UPDATE serializes insertion
  // and the normal ledger allocator through the entire sealing transaction.
  const [run] = await tx.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, runId)).for("update");
  if (!run) throw legacyClosureError("historical_execution_unverified");
  const leases = await tx.select().from(environmentLeases).where(eq(environmentLeases.heartbeatRunId, runId)).orderBy(asc(environmentLeases.id)).for("share");
  if (!leases.length || leases.some(lease => lease.companyId !== run.companyId || lease.provider !== "local" || lease.providerLeaseId !== null))
    throw legacyClosureError("historical_execution_unverified");
  const workspaces: Array<{ leaseId: string; execution: unknown; project: unknown }> = [];
  const sources: Entry["sources"] = [];
  let availableCount = 0;
  const rawSnapshot = snapshotCwd(run);
  for (const lease of leases) {
    const [execution] = lease.executionWorkspaceId ? await tx.select().from(executionWorkspaces).where(eq(executionWorkspaces.id, lease.executionWorkspaceId)).for("share") : [];
    if ((lease.executionWorkspaceId && !execution) || (execution && execution.companyId !== run.companyId)) throw legacyClosureError("historical_execution_unverified");
    const [project] = execution?.projectWorkspaceId ? await tx.select().from(projectWorkspaces).where(eq(projectWorkspaces.id, execution.projectWorkspaceId)).for("share") : [];
    if ((execution?.projectWorkspaceId && !project) || (project && project.companyId !== run.companyId)) throw legacyClosureError("historical_execution_unverified");
    workspaces.push({ leaseId: lease.id,
      execution: execution ? { id: execution.id, companyId: execution.companyId, projectId: execution.projectId,
        projectWorkspaceId: execution.projectWorkspaceId, cwd: execution.cwd, providerType: execution.providerType, providerRef: execution.providerRef } : null,
      project: project ? { id: project.id, companyId: project.companyId, projectId: project.projectId, sourceType: project.sourceType,
        cwd: project.cwd, repoUrl: project.repoUrl, repoRef: project.repoRef, remoteProvider: project.remoteProvider,
        remoteWorkspaceRef: project.remoteWorkspaceRef, sharedWorkspaceKey: project.sharedWorkspaceKey } : null });
    const cwd = execution?.cwd ?? rawSnapshot;
    const prior = captured?.sources.find(source => source.leaseId === lease.id);
    const reason = captured ? prior?.sourceUnavailable : await unavailable(cwd);
    if (!reason) { availableCount++; continue; }
    sources.push({ leaseId: lease.id, executionWorkspaceId: lease.executionWorkspaceId,
      projectWorkspaceId: execution?.projectWorkspaceId ?? null, cwd, sourceUnavailable: reason });
  }
  if (availableCount === leases.length && !captured) return null;
  if (availableCount || sources.length !== leases.length || run.runtimeMode !== "legacy" || !terminal(run.status))
    throw legacyClosureError("historical_execution_unverified");
  const events = await tx.select().from(heartbeatRunEvents).where(eq(heartbeatRunEvents.runId, runId)).orderBy(asc(heartbeatRunEvents.seq), asc(heartbeatRunEvents.id)).for("share");
  if (events.some(event => event.companyId !== run.companyId || event.agentId !== run.agentId)) throw legacyClosureError("historical_execution_unverified");
  return { runId, companyId: run.companyId, agentId: run.agentId, snapshotCwd: rawSnapshot, sources,
    process: { controllerBootId: run.controllerBootId, processPid: run.processPid, processGroupId: run.processGroupId, processStartedAt: run.processStartedAt?.toISOString() ?? null },
    runDigest: hash(run), leaseDigest: hash(leases), ledgerDigest: hash(events), workspaceDigest: hash(workspaces) };
}

export function readLegacyEpochCapture(row: Row) {
  const result = manifestSchema.safeParse(row.manifest);
  if (!result.success) throw legacyClosureError("closure_record_unverified");
  const value = result.data;
  if (value.id !== row.id || value.generation !== row.generation || value.realm !== row.realm || value.digest !== row.digest
    || value.digest !== digest(value.realm, value.host, value.cohort) || new Set(value.cohort.map(entry => entry.runId)).size !== value.cohort.length
    || !["prepared", "closed", "operator_reconciled"].includes(row.state)) throw legacyClosureError("closure_record_unverified");
  if (row.state === "prepared" && (row.closure !== null || row.closedAt !== null)) throw legacyClosureError("closure_record_unverified");
  return value;
}
const manifest = readLegacyEpochCapture;

function ending(row: Row, origin: ReturnType<typeof manifest>) {
  const parsed = closureSchema.safeParse(row.closure);
  if (row.state !== "closed" || !row.closedAt || !parsed.success) throw legacyClosureError("closure_record_unverified");
  const value = parsed.data;
  if (value.id !== row.id || value.generation !== row.generation || value.realm !== row.realm || value.preparedDigest !== row.digest
    || !sameInstance(origin.host, value.host) || origin.host.bootId === value.host.bootId || value.at !== row.closedAt.toISOString())
    throw legacyClosureError("closure_record_unverified");
  return value;
}

async function authenticatedRealm(tx: Db, databaseDirectory?: string, lock = false) {
  const initial = await readLegacyWorkspaceHost(tx);
  if (databaseDirectory && initial.database.directory !== databaseDirectory) throw legacyClosureError("host_instance_changed");
  // This identity identifies only the present local realm. It is never recorded
  // as the historical source inode of an unavailable workspace.
  const identity = await physicalWorkspaceIdentity(initial.database.directory);
  if (lock) {
    await tx.execute(sql`select set_config('lock_timeout', '1500', true), set_config('statement_timeout', '30000', true)`);
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${identity.realm}, 0))`);
    const host = await readLegacyWorkspaceHost(tx);
    const current = await physicalWorkspaceIdentity(host.database.directory);
    if (!sameInstance(initial, host) || !same(stableHost(initial), stableHost(host)) || !same(identity, current)) throw legacyClosureError("host_instance_changed");
    return { realm: identity.realm, host };
  }
  return { realm: identity.realm, host: initial };
}

export async function legacyEpochCohortUnchanged(tx: Db, capture: ReturnType<typeof manifest>) {
  const current = await Promise.all(capture.cohort.map(entry => readEntry(tx, entry.runId, entry)));
  return same(current, capture.cohort);
}
const unchanged = legacyEpochCohortUnchanged;

async function closedIds(tx: Db, realm: string, host: LegacyWorkspaceHost) {
  const rows = await tx.select().from(legacyWorkspaceEpochClosures).where(and(eq(legacyWorkspaceEpochClosures.realm, realm), eq(legacyWorkspaceEpochClosures.state, "closed"))).for("share");
  const result = new Set<string>();
  for (const row of rows) {
    try {
      const origin = manifest(row); ending(row, origin);
      if (!sameInstance(origin.host, host) || origin.host.bootId === host.bootId || !await unchanged(tx, origin)) continue;
      for (const entry of origin.cohort) result.add(entry.runId);
    } catch { /* Corrupt or drifted cohorts retain the existing admission block. */ }
  }
  return result;
}

/** Called under the admission realm lock. Only complete verified cohorts count;
 * display activity, logical status and present PID absence are never proof. */
export async function legacyWorkspaceEpochClosedRunIds(tx: Db, realm: string): Promise<Set<string>> {
  try {
    // The common admission path has no epoch proofs and needs no host-operator
    // privileges. Proof SQL errors must roll back their savepoint, never abort
    // the outer admission transaction while appearing to be a harmless miss.
    const rows = await tx.select({ id: legacyWorkspaceEpochClosures.id }).from(legacyWorkspaceEpochClosures)
      .where(and(eq(legacyWorkspaceEpochClosures.realm, realm), eq(legacyWorkspaceEpochClosures.state, "closed"))).limit(1);
    if (!rows.length) return new Set();
    return await tx.transaction(async transaction => {
      const proofTx = transaction as unknown as Db, current = await authenticatedRealm(proofTx);
      if (current.realm !== realm) return new Set();
      return closedIds(proofTx, realm, current.host);
    });
  } catch { return new Set(); }
}

async function quiescent(tx: Db, realm: string) {
  const held = await tx.select().from(workspaceWriteOwners).where(and(eq(workspaceWriteOwners.realm, realm), isNull(workspaceWriteOwners.releasedAt))).for("share");
  if (held.length) throw legacyClosureError("workspace_held");
  const services = await tx.select().from(workspaceRuntimeServices).where(eq(workspaceRuntimeServices.provider, "local_process")).for("share");
  if (services.length) throw legacyClosureError("workspace_service_unverified");
}

async function cohort(tx: Db, realm: string, host: LegacyWorkspaceHost) {
  const owners = await tx.select().from(workspaceWriteOwners).where(eq(workspaceWriteOwners.realm, realm)).for("share");
  const candidates = await tx.select({ run: heartbeatRuns, cwd: executionWorkspaces.cwd }).from(environmentLeases)
    .innerJoin(heartbeatRuns, eq(environmentLeases.heartbeatRunId, heartbeatRuns.id))
    .leftJoin(executionWorkspaces, eq(environmentLeases.executionWorkspaceId, executionWorkspaces.id)).where(eq(environmentLeases.provider, "local"));
  const closed = await closedIds(tx, realm, host), ids = new Set<string>();
  for (const candidate of candidates) {
    if (!candidate.run.processPid && !candidate.run.processGroupId && !candidate.run.processStartedAt && candidate.run.runtimeMode !== "native") continue;
    if (closed.has(candidate.run.id)) continue;
    const raw = candidate.cwd ?? snapshotCwd(candidate.run);
    const source = raw ? await physicalWorkspaceIdentity(raw).catch(() => null) : null;
    if (await workspaceRunHasTrackedOwner(tx, candidate.run, source, owners, raw ?? undefined)) continue;
    if (!terminal(candidate.run.status)) throw legacyClosureError("historical_execution_unverified");
    ids.add(candidate.run.id);
  }
  const entries: Entry[] = [];
  for (const id of [...ids].sort()) { const entry = await readEntry(tx, id); if (entry) entries.push(entry); }
  return entries;
}

async function audit(tx: Db, row: Row, host: LegacyWorkspaceHost, action: string) {
  const capture = manifest(row);
  for (const companyId of [...new Set(capture.cohort.map(entry => entry.companyId))].sort()) {
    await persistActivity(tx, { companyId, actorType: "system", actorId: `local_workspace_operator:${host.uid}`,
      action, entityType: "legacy_workspace_epoch_closure", entityId: row.id,
      details: { generation: row.generation, digest: row.digest,
        runIds: capture.cohort.filter(entry => entry.companyId === companyId).map(entry => entry.runId),
        ...(row.state === "closed" ? { proof: "host_epoch_closed" } : {}) } });
  }
}

export function legacyWorkspaceEpochClosureService(db: Db, options: { databaseDirectory?: string } = {}) {
  const scope = z.object({ databaseDirectory: z.string().min(1).optional() }).strict().parse(options);
  async function selected(tx: Db, request: z.infer<typeof selectorSchema>, current: { realm: string; host: LegacyWorkspaceHost }) {
    const [row] = await tx.select().from(legacyWorkspaceEpochClosures).where(and(eq(legacyWorkspaceEpochClosures.id, request.id), eq(legacyWorkspaceEpochClosures.generation, request.generation))).for("share");
    if (!row) throw legacyClosureError("closure_record_unverified");
    const capture = manifest(row);
    if (current.realm !== row.realm || !sameInstance(capture.host, current.host)) throw legacyClosureError("host_instance_changed");
    if (row.state === "closed") ending(row, capture);
    return { row, capture };
  }
  return {
    async inspect() {
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db, current = await authenticatedRealm(tx, scope.databaseDirectory, true);
        await quiescent(tx, current.realm);
        const entries = await cohort(tx, current.realm, current.host);
        return { ...current, cohort: entries, digest: digest(current.realm, current.host, entries), requiresHostEpochChange: entries.length > 0 };
      });
    },
    async prepare(input: { expectedDigest: string }) {
      const request = prepareSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db, current = await authenticatedRealm(tx, scope.databaseDirectory, true);
        await quiescent(tx, current.realm);
        const entries = await cohort(tx, current.realm, current.host), observed = digest(current.realm, current.host, entries);
        if (!entries.length) throw legacyClosureError("historical_cohort_empty");
        if (observed !== request.expectedDigest) throw legacyClosureError("historical_cohort_changed");
        const prepared = await tx.select().from(legacyWorkspaceEpochClosures).where(and(eq(legacyWorkspaceEpochClosures.realm, current.realm), eq(legacyWorkspaceEpochClosures.state, "prepared"))).for("share");
        if (prepared.length) {
          if (prepared.length !== 1) throw legacyClosureError("closure_record_unverified");
          const existing = prepared[0]!, capture = manifest(existing);
          if (existing.digest !== observed || !sameInstance(capture.host, current.host)) throw legacyClosureError("closure_already_prepared");
          return existing;
        }
        const id = randomUUID(), generation = randomUUID(), at = new Date();
        const [row] = await tx.insert(legacyWorkspaceEpochClosures).values({ id, generation, realm: current.realm, state: "prepared", digest: observed,
          manifest: { kind: KIND, version: 1, event: "prepared", id, generation, realm: current.realm, host: current.host, cohort: entries, digest: observed, at: at.toISOString() } }).returning();
        await audit(tx, row!, current.host, "workspace.legacy_epoch_closure_prepared");
        return row!;
      });
    },
    async close(input: { id: string; generation: string; expectedDigest: string }) {
      const request = closeSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db, current = await authenticatedRealm(tx, scope.databaseDirectory, true);
        const { row, capture } = await selected(tx, request, current);
        if (request.expectedDigest !== row.digest) throw legacyClosureError("historical_cohort_changed");
        if (current.host.bootId === capture.host.bootId) throw legacyClosureError("host_epoch_unchanged");
        if (row.state === "closed") {
          if (!await unchanged(tx, capture)) throw legacyClosureError("historical_cohort_changed");
          return row;
        }
        await quiescent(tx, current.realm);
        const entries = await cohort(tx, current.realm, capture.host);
        if (!same(entries, capture.cohort)) throw legacyClosureError("historical_cohort_changed");
        const at = new Date();
        const [closed] = await tx.update(legacyWorkspaceEpochClosures).set({ state: "closed", updatedAt: at, closedAt: at,
          closure: { kind: KIND, version: 1, event: "host_epoch_closed", proof: "host_epoch_closed", id: row.id, generation: row.generation,
            realm: row.realm, preparedDigest: row.digest, host: current.host, at: at.toISOString() } })
          .where(and(eq(legacyWorkspaceEpochClosures.id, row.id), eq(legacyWorkspaceEpochClosures.generation, row.generation), eq(legacyWorkspaceEpochClosures.state, "prepared"))).returning();
        if (!closed) throw legacyClosureError("closure_record_unverified");
        await audit(tx, closed, current.host, "workspace.legacy_host_epoch_closed");
        return closed;
      });
    },
    async status(input: { id: string; generation: string }) {
      const request = selectorSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db, current = await authenticatedRealm(tx, scope.databaseDirectory);
        return (await selected(tx, request, current)).row;
      });
    },
  };
}
