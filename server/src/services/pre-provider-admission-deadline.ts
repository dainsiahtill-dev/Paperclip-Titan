import { and, eq, sql } from "drizzle-orm";
import { costEvents, heartbeatRunEvents, heartbeatRuns, type Db } from "@paperclipai/db";
import { isVerifiedPreProviderAdmission } from "./pre-provider-admission.js";

type Run = typeof heartbeatRuns.$inferSelect;
export class PreProviderDeadlineUnverifiedError extends Error {
  readonly code = "resource_run_deadline_unverified";
  constructor() { super("The execution deadline could not be verified from its retry history."); }
}
const record = (value: unknown): Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const parentId = (run: Run) => run.retryOfRunId ?? (typeof run.contextSnapshot?.retryOfRunId === "string" ? run.contextSnapshot.retryOfRunId : null);
const clock = (value: unknown) => {
  const deadline = record(value).deadlineAt;
  return typeof deadline === "string" && Number.isFinite(Date.parse(deadline)) ? Date.parse(deadline) : null;
};

/** The first real execution owns the existing policy allowance. A server-proven
 * pre-provider admission wait is not execution, even across several retries.
 * Actual/unknown ancestors and same-run work retain their original clocks. */
export async function resolvePreProviderAdmissionDeadline(db: Db, input: {
  run: Run; issueId: string | null; context: Record<string, unknown>; maxRunSeconds: number; authorizedSupersession: boolean;
}): Promise<number> {
  const { run } = input;
  const prior = record(input.context.resourceDeadline);
  const own = prior.runId === run.id ? clock(prior) : null;
  const fresh = (run.startedAt?.getTime() ?? Date.now()) + input.maxRunSeconds * 1000;
  if (input.authorizedSupersession) return own ?? fresh;
  const sourceId = parentId(run) ?? (typeof input.context.retryOfRunId === "string" ? input.context.retryOfRunId : null);
  if (!sourceId) return own ?? fresh;

  const seen = new Set([run.id]), clocks: number[] = own === null ? [] : [own];
  let id: string | null = sourceId, entirelyPreProvider = true;
  // Bound both corrupted cycles and very deep legacy chains. Exceeding the
  // bound retains the observed strict clock; it never grants a new allowance.
  for (let depth = 0; id && depth < 64; depth++) {
    if (seen.has(id)) { entirelyPreProvider = false; break; }
    seen.add(id);
    const [source] = await db.select().from(heartbeatRuns).where(and(
      eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.id, id),
      sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId') = ${input.issueId}`,
    ));
    if (!source) { entirelyPreProvider = false; break; }
    const inherited = clock(source.contextSnapshot?.resourceDeadline);
    if (inherited !== null) clocks.push(inherited);
    if (!await isVerifiedPreProviderAdmission(db, { companyId: run.companyId, agentId: run.agentId, runId: source.id })) {
      entirelyPreProvider = false;
    }
    id = parentId(source);
  }
  if (id) entirelyPreProvider = false;
  if (entirelyPreProvider) {
    // The current ID can also resume. Recheck its durable facts instead of
    // treating a carried false marker or a caller's deadline as fresh authority.
    const [current] = await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, run.companyId), eq(heartbeatRuns.agentId, run.agentId), eq(heartbeatRuns.id, run.id)));
    const [invocation] = await db.select({ id: heartbeatRunEvents.id }).from(heartbeatRunEvents).where(and(eq(heartbeatRunEvents.runId, run.id), eq(heartbeatRunEvents.eventType, "adapter.invoke"))).limit(1);
    const [cost] = await db.select({ id: costEvents.id }).from(costEvents).where(eq(costEvents.heartbeatRunId, run.id)).limit(1);
    if (current?.runtimeMode === "legacy" && current.processPid === null && current.processGroupId === null && current.processStartedAt === null
      && (current.usageJson === null || Object.keys(current.usageJson).length === 0) && !invocation && !cost) return fresh;
  }
  if (clocks.length) return Math.min(...clocks);
  throw new PreProviderDeadlineUnverifiedError();
}
