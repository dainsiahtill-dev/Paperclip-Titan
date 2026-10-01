import { createHash } from "node:crypto";
import { readFile, readlink } from "node:fs/promises";
import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import { environmentLeases, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { appendHeartbeatRunEvent } from "./heartbeat-run-events.js";
import { legacyControllerBootId } from "./legacy-controller-lease.js";

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
  const [event] = await db.select({ eventType: heartbeatRunEvents.eventType, payload: heartbeatRunEvents.payload })
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
