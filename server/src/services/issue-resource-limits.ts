import { and, desc, eq, gt, inArray, isNotNull, ne, sql } from "drizzle-orm";
import { costEvents, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
import { issueResourceLimitsSchema, type IssueResourceLimits } from "@paperclipai/shared/validators/issue-resources";

export interface ResourceUsage {
  totalTokens: number; unknownUsageCount: number; automaticRuns: number; noProgressRuns: number;
  boundedWait?: boolean; newHumanInput?: boolean;
}
export function evaluateIssueResourceLimits(limits: IssueResourceLimits, usage: ResourceUsage) {
  if (limits.maxTokensPerIssue && usage.unknownUsageCount > 0) return { blocked: true, code: "issue_token_usage_unknown" };
  if (limits.maxTokensPerIssue && usage.totalTokens >= limits.maxTokensPerIssue) return { blocked: true, code: "issue_token_limit" };
  if (limits.maxAutomaticRuns && usage.automaticRuns >= limits.maxAutomaticRuns) return { blocked: true, code: "issue_automatic_run_limit" };
  if (limits.maxNoProgressRuns && !usage.boundedWait && !usage.newHumanInput && usage.noProgressRuns >= limits.maxNoProgressRuns) return { blocked: true, code: "issue_no_progress_limit" };
  return { blocked: false, code: null };
}

/** Clearing a timer never declares an in-flight stop complete. */
export function armIssueRunDeadline(input: {
  deadlineAt: number; stop: () => Promise<void>; onError?: () => void;
}) {
  let stopping: Promise<void> | null = null;
  const timer = setTimeout(() => {
    stopping = Promise.resolve().then(input.stop).catch(() => { input.onError?.(); });
  }, Math.max(0, input.deadlineAt - Date.now()));
  timer.unref?.();
  return { clear: () => clearTimeout(timer), drain: async () => { if (stopping) await stopping; } };
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

export async function readIssueResourcePolicies(db: Db, companyId: string, issueId: string) {
  const policies: Array<{ issueId: string; title: string; status: string; executionState: unknown; monitorPolicy: unknown; limits: IssueResourceLimits }> = [];
  const visited = new Set<string>();
  let current: string | null = issueId;
  while (current) {
    if (visited.has(current) || visited.size >= 100) throw new Error("issue_resource_scope_invalid");
    visited.add(current);
    const row: Pick<typeof issues.$inferSelect, "id" | "parentId" | "title" | "status" | "executionPolicy" | "executionState"> | null = await db.select({ id: issues.id, parentId: issues.parentId, title: issues.title,
      status: issues.status, executionPolicy: issues.executionPolicy, executionState: issues.executionState })
      .from(issues).where(and(eq(issues.id, current), eq(issues.companyId, companyId))).limit(1).then((rows) => rows[0] ?? null);
    if (!row) throw new Error("issue_resource_scope_missing");
    const raw = object(row.executionPolicy).resourceLimits;
    if (raw != null) {
      const parsed = issueResourceLimitsSchema.safeParse(raw);
      if (!parsed.success) throw new Error("issue_resource_policy_invalid");
      policies.push({ issueId: row.id, title: row.title, status: row.status, executionState: row.executionState,
        monitorPolicy: object(row.executionPolicy).monitor, limits: parsed.data });
    }
    current = row.parentId;
  }
  return policies;
}

function subtree(companyId: string, issueId: string) {
  return sql`with recursive resource_subtree as (
    select id, array[id] as path from issues where id = ${issueId}::uuid and company_id = ${companyId}::uuid
    union all select child.id, parent.path || child.id from issues child join resource_subtree parent on child.parent_id = parent.id
    where child.company_id = ${companyId}::uuid and not child.id = any(parent.path) and cardinality(parent.path) < 100
  ) select id from resource_subtree`;
}

export async function getIssueResourceBlock(db: Db, input: {
  companyId: string; issueId: string; excludeRunId?: string | null;
}) {
  const policies = await readIssueResourcePolicies(db, input.companyId, input.issueId);
  for (const policy of policies) {
    if (!policy.limits.maxTokensPerIssue && !policy.limits.maxAutomaticRuns && !policy.limits.maxNoProgressRuns) continue;
    const ids = sql`(${subtree(input.companyId, policy.issueId)})`;
    const runIssue = sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`;
    const runIds = sql`(select id::text from ${ids} resource_run_scope)`;
    const [tokens] = policy.limits.maxTokensPerIssue ? await db.select({
      totalTokens: sql<number>`coalesce(sum(${costEvents.totalTokens}), 0)::double precision`,
      unknownUsageCount: sql<number>`count(*) filter (where ${costEvents.totalTokens} is null)::int`,
    }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), inArray(costEvents.issueId, ids))) : [{ totalTokens: 0, unknownUsageCount: 0 }];
    const [unreported] = policy.limits.maxTokensPerIssue ? await db.select({
      totalTokens: sql<number>`coalesce(sum(case when jsonb_typeof(${heartbeatRuns.usageJson}->'totalTokens') = 'number' then (${heartbeatRuns.usageJson}->>'totalTokens')::numeric else 0 end), 0)::double precision`,
      unknownUsageCount: sql<number>`count(*) filter (where jsonb_typeof(${heartbeatRuns.usageJson}->'totalTokens') is distinct from 'number')::int`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds),
      isNotNull(heartbeatRuns.startedAt), isNotNull(heartbeatRuns.finishedAt),
      sql`(${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted') is distinct from 'false'`,
      sql`not exists (select 1 from cost_events recorded where recorded.company_id = ${heartbeatRuns.companyId} and recorded.heartbeat_run_id = ${heartbeatRuns.id})`,
    )) : [{ totalTokens: 0, unknownUsageCount: 0 }];
    const [runs] = policy.limits.maxAutomaticRuns ? await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds), isNotNull(heartbeatRuns.startedAt),
        ne(heartbeatRuns.invocationSource, "manual"), input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : undefined)) : [{ count: 0 }];
    const recent = policy.limits.maxNoProgressRuns ? await db.select({ status: heartbeatRuns.status,
      livenessState: heartbeatRuns.livenessState, finishedAt: heartbeatRuns.finishedAt }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds), isNotNull(heartbeatRuns.finishedAt)))
      .orderBy(desc(heartbeatRuns.finishedAt)).limit(policy.limits.maxNoProgressRuns) : [];
    let noProgressRuns = 0;
    for (const run of recent) {
      if (run.status !== "succeeded" || ["advanced", "completed", "blocked"].includes(run.livenessState ?? "")) break;
      noProgressRuns += 1;
    }
    const lastFinished = recent[0]?.finishedAt;
    const humanComments = lastFinished ? await db.select({ id: issueComments.id }).from(issueComments)
      .where(and(eq(issueComments.companyId, input.companyId), inArray(issueComments.issueId, ids),
        isNotNull(issueComments.authorUserId), gt(issueComments.createdAt, lastFinished))).limit(1) : [];
    const humanResponses = lastFinished ? await db.select({ id: issueThreadInteractions.id }).from(issueThreadInteractions)
      .where(and(eq(issueThreadInteractions.companyId, input.companyId), inArray(issueThreadInteractions.issueId, ids),
        isNotNull(issueThreadInteractions.resolvedByUserId), gt(issueThreadInteractions.updatedAt, lastFinished))).limit(1) : [];
    const monitor = object(object(policy.executionState).monitor);
    const monitorPolicy = object(policy.monitorPolicy);
    const boundedWait = ["blocked", "in_review"].includes(policy.status)
      || (monitor.status === "scheduled" && typeof monitor.nextCheckAt === "string"
        && Number.isFinite(Date.parse(monitor.nextCheckAt))
        && ((typeof monitorPolicy.timeoutAt === "string" && Date.parse(monitorPolicy.timeoutAt) > Date.now())
          || (typeof monitorPolicy.maxAttempts === "number" && monitorPolicy.maxAttempts > Number(monitor.attemptCount ?? 0))));
    const decision = evaluateIssueResourceLimits(policy.limits, { totalTokens: Number(tokens?.totalTokens ?? 0) + Number(unreported?.totalTokens ?? 0),
      unknownUsageCount: Number(tokens?.unknownUsageCount ?? 0) + Number(unreported?.unknownUsageCount ?? 0), automaticRuns: Number(runs?.count ?? 0),
      noProgressRuns, boundedWait, newHumanInput: humanComments.length > 0 || humanResponses.length > 0 });
    if (decision.blocked) return { ...decision, resourceIssueId: policy.issueId, title: policy.title };
  }
  return null;
}
