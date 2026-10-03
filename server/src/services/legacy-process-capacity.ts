import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { environmentLeases, environments, heartbeatRunEvents, heartbeatRuns, issues, type Db } from "@paperclipai/db";
import { z } from "zod";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";
import { environmentService } from "./environments.js";
import { persistActivity } from "./activity-log.js";

const IDENTITY = "legacy.process_identity_recorded";
const STOPPED = "legacy.local_process_stopped";
type Run = typeof heartbeatRuns.$inferSelect;
let localNamespace: Promise<string | null> | undefined;

/** A controller UUID changes on service restart; the OS/PID namespace does not. */
export function legacyLocalProcessNamespace(): Promise<string | null> {
  return localNamespace ??= (async () => {
    if (process.platform !== "linux") return null;
    try {
      const [boot, namespace] = await Promise.all([
        readFile("/proc/sys/kernel/random/boot_id", "utf8"),
        readlink("/proc/self/ns/pid"),
      ]);
      return createHash("sha256").update(`${boot.trim()}\n${namespace}`).digest("hex");
    } catch {
      // Unknown namespace must never grant authority over another host's PID.
      return null;
    }
  })();
}

function identity(run: Run): Record<string, unknown> {
  return {
    controllerBootId: run.controllerBootId,
    processPid: run.processPid,
    processGroupId: run.processGroupId,
    processStartedAt: run.processStartedAt?.toISOString() ?? null,
  };
}

function matches(run: Run, payload: Record<string, unknown> | null): boolean {
  return payload !== null && Object.entries(identity(run)).every(([key, value]) => payload[key] === value);
}

function absent(pid: number | null): boolean {
  if (pid === null) return true;
  if (!Number.isSafeInteger(pid) || pid === 0 || Math.abs(pid) <= 1) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    // EPERM and unexpected failures are not stop evidence.
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

async function latest(db: Db, run: Run) {
  const [event] = await db.select({ seq: heartbeatRunEvents.seq, eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
    .from(heartbeatRunEvents).where(and(
      eq(heartbeatRunEvents.companyId, run.companyId),
      eq(heartbeatRunEvents.runId, run.id),
      eq(heartbeatRunEvents.agentId, run.agentId),
      isNull(heartbeatRunEvents.sourceEventId),
      inArray(heartbeatRunEvents.eventType, [IDENTITY, STOPPED]),
    )).orderBy(desc(heartbeatRunEvents.seq)).limit(1);
  return event;
}

/** Called by the server's spawn callback in the process metadata transaction. */
async function localEnvironment(db: Db, run: Run): Promise<boolean> {
  const leases = await db.select({ provider: environmentLeases.provider }).from(environmentLeases)
    .where(and(eq(environmentLeases.companyId, run.companyId), eq(environmentLeases.heartbeatRunId, run.id)));
  return leases.every(lease => lease.provider === "local");
}

export async function recordLegacyProcessIdentity(db: Db, run: Run, localProcess = true): Promise<void> {
  if (run.runtimeMode !== "legacy") return;
  const local = localProcess && await localEnvironment(db, run);
  await appendHeartbeatRunEvent(db, {
    companyId: run.companyId, runId: run.id, agentId: run.agentId,
    eventType: IDENTITY, stream: "system", level: "info",
    message: "Legacy process identity recorded; prior stop evidence no longer applies.",
    payload: { ...identity(run), localProcess: local, localNamespace: local ? await legacyLocalProcessNamespace() : null },
  });
}

/** Durable stop proof survives a service restart and cannot cover a later launch. */
export async function legacyProcessStopConfirmed(db: Db, run: Run): Promise<boolean> {
  if (run.runtimeMode !== "legacy") return false;
  const event = await latest(db, run);
  return event?.eventType === STOPPED && matches(run, event.payload);
}

/** Observe only owned local PIDs. A foreign controller needs exact host evidence. */
export async function recordLegacyLocalProcessStop(db: Db, observed: Run): Promise<boolean> {
  if (observed.runtimeMode !== "legacy") return false;
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    const [run] = await transaction.select().from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, observed.companyId), eq(heartbeatRuns.id, observed.id)))
      .for("update").limit(1);
    if (!run || run.runtimeMode !== "legacy" || !matches(run, identity(observed)) ||
        !await localEnvironment(tx, run)) return false;
    const event = await latest(tx, run);
    if (event?.eventType === STOPPED && matches(run, event.payload)) return true;
    // Remote SSH can have no environment lease. Explicit dispatch provenance
    // still forbids treating its PID as a process on this controller's host.
    if (event?.eventType === IDENTITY && matches(run, event.payload) &&
        event.payload?.localProcess !== true) return false;
    if (run.controllerBootId !== legacyControllerBootId) {
      const namespace = await legacyLocalProcessNamespace();
      if (!namespace || event?.eventType !== IDENTITY || !matches(run, event.payload) ||
          event.payload?.localNamespace !== namespace ||
          !run.controllerLeaseExpiresAt || run.controllerLeaseExpiresAt.getTime() > Date.now()) return false;
    }
    if (!absent(run.processPid) || !absent(run.processGroupId === null ? null : -run.processGroupId)) return false;
    await appendHeartbeatRunEvent(tx, {
      companyId: run.companyId, runId: run.id, agentId: run.agentId,
      eventType: STOPPED, stream: "system", level: "info",
      message: "Verified legacy process and process group stopped; capacity can be released.",
      payload: { ...identity(run), localProcess: true, localNamespace: await legacyLocalProcessNamespace() },
    });
    return true;
  });
}

export const stoppedLegacyLocalLeaseSelectorSchema = z.object({
  companyId: z.string().uuid(),
  issueId: z.string().uuid(),
  agentId: z.string().uuid(),
  runId: z.string().uuid(),
  leaseId: z.string().uuid(),
  stopReceiptSeq: z.number().int().nonnegative(),
  expectedStopIdentity: z.object({
    controllerBootId: z.string().uuid(),
    processPid: z.number().int().min(2).max(2_147_483_647).nullable(),
    processGroupId: z.number().int().min(2).max(2_147_483_647).nullable(),
    processStartedAt: z.string().datetime({ offset: true }),
    localNamespace: z.string().regex(/^[a-f0-9]{64}$/),
  }).strict().refine(value => value.processPid !== null || value.processGroupId !== null),
}).strict();

export type StoppedLegacyLocalLeaseSelector = z.infer<typeof stoppedLegacyLocalLeaseSelectorSchema>;
export type LocalLeaseReconciliationRefusal =
  | "selector_mismatch" | "execution_not_terminal_legacy" | "stop_receipt_mismatch"
  | "host_namespace_unverified" | "controller_active" | "provider_process_not_stopped"
  | "lease_not_local_bookkeeping" | "lease_not_active" | "release_failed";

export class LocalLeaseReconciliationError extends Error {
  constructor(readonly code: LocalLeaseReconciliationRefusal) {
    super(code);
    this.name = "LocalLeaseReconciliationError";
  }
}

export interface LocalLeaseReconciliationResult {
  outcome: "eligible" | "released" | "already_released";
  companyId: string;
  issueId: string;
  agentId: string;
  runId: string;
  leaseId: string;
  stopReceiptSeq: number;
  leaseStatus: string;
  cleanupStatus: string | null;
  releasedAt: string | null;
}

/** Host maintenance only: retire one Local bookkeeping lease using an existing
 * exact stop receipt. No process signal, provider cleanup, task mutation or wake. */
export async function reconcileStoppedLegacyLocalLease(
  db: Db,
  input: StoppedLegacyLocalLeaseSelector,
  options: { apply?: boolean } = {},
): Promise<LocalLeaseReconciliationResult> {
  const selector = stoppedLegacyLocalLeaseSelectorSchema.parse(input);
  const refuse = (code: LocalLeaseReconciliationRefusal): never => {
    throw new LocalLeaseReconciliationError(code);
  };
  return db.transaction(async transaction => {
    const tx = transaction as unknown as Db;
    await transaction.execute(sql`select set_config('statement_timeout', '15000', true), set_config('lock_timeout', '1000', true)`);
    const [issue] = await transaction.select().from(issues).where(and(
      eq(issues.id, selector.issueId), eq(issues.companyId, selector.companyId),
    )).for("update").limit(1);
    const [run] = await transaction.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.id, selector.runId), eq(heartbeatRuns.companyId, selector.companyId),
    )).for("update").limit(1);
    if (!issue || !run || issue.assigneeAgentId !== selector.agentId || run.agentId !== selector.agentId ||
        (run.nativeIssueId ?? run.contextSnapshot?.issueId) !== selector.issueId) return refuse("selector_mismatch");
    if (run.runtimeMode !== "legacy" || !["succeeded", "failed", "timed_out", "cancelled", "interrupted"].includes(run.status)) {
      return refuse("execution_not_terminal_legacy");
    }
    if (!matches(run, selector.expectedStopIdentity)) return refuse("stop_receipt_mismatch");
    const receipt = await latest(tx, run);
    // Event sequence is supplied by the operator, but the latest event and its
    // process identity come from the immutable server ledger, never the selector.
    if (receipt?.seq !== selector.stopReceiptSeq || receipt.eventType !== STOPPED ||
        receipt.payload?.localProcess !== true || !await legacyProcessStopConfirmed(tx, run)) return refuse("stop_receipt_mismatch");
    const namespace = await legacyLocalProcessNamespace();
    if (!namespace || namespace !== selector.expectedStopIdentity.localNamespace || receipt.payload?.localNamespace !== namespace) {
      return refuse("host_namespace_unverified");
    }
    if (!run.controllerLeaseExpiresAt || run.controllerLeaseExpiresAt.getTime() > Date.now()) return refuse("controller_active");
    if (!absent(run.processPid) || !absent(run.processGroupId === null ? null : -run.processGroupId)) {
      return refuse("provider_process_not_stopped");
    }
    const [lease] = await transaction.select().from(environmentLeases).where(and(
      eq(environmentLeases.id, selector.leaseId), eq(environmentLeases.companyId, selector.companyId),
      eq(environmentLeases.heartbeatRunId, selector.runId), eq(environmentLeases.issueId, selector.issueId),
    )).for("update").limit(1);
    if (!lease || lease.metadata?.agentId !== selector.agentId) return refuse("selector_mismatch");
    const [environment] = lease.environmentId ? await transaction.select().from(environments)
      .where(eq(environments.id, lease.environmentId)).for("update").limit(1) : [];
    if (!environment || environment.driver !== "local" || lease.metadata?.driver !== "local" ||
        (lease.provider !== null && lease.provider !== "local") || lease.providerLeaseId !== null) {
      return refuse("lease_not_local_bookkeeping");
    }
    const result = (outcome: LocalLeaseReconciliationResult["outcome"], status = lease.status,
      cleanupStatus = lease.cleanupStatus, releasedAt = lease.releasedAt): LocalLeaseReconciliationResult => ({
      outcome, companyId: selector.companyId, issueId: selector.issueId, agentId: selector.agentId,
      runId: selector.runId, leaseId: selector.leaseId, stopReceiptSeq: selector.stopReceiptSeq,
      leaseStatus: status, cleanupStatus, releasedAt: releasedAt?.toISOString() ?? null,
    });
    if (lease.status === "released" && lease.cleanupStatus === "success" && lease.releasedAt) return result("already_released");
    if (lease.status !== "active" || lease.releasedAt !== null || lease.cleanupStatus === "failed") return refuse("lease_not_active");
    if (options.apply !== true) return result("eligible");
    const released = await environmentService(tx).releaseLease(lease.id, "released", { cleanupStatus: "success" });
    if (!released?.releasedAt || released.status !== "released" || released.cleanupStatus !== "success") return refuse("release_failed");
    await persistActivity(tx, {
      companyId: selector.companyId, actorType: "system", actorId: "local_lease_maintenance",
      agentId: selector.agentId, runId: selector.runId, action: "environment.local_lease_reconciled",
      entityType: "environment_lease", entityId: selector.leaseId,
      details: { issueId: selector.issueId, environmentId: lease.environmentId, stopReceiptSeq: selector.stopReceiptSeq,
        stopIdentity: selector.expectedStopIdentity, previousStatus: lease.status, status: "released" },
    });
    return result("released", released.status, released.cleanupStatus, released.releasedAt);
  });
}
