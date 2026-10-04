import { and, desc, eq, gt, inArray, isNotNull, isNull, ne, sql } from "drizzle-orm";
import { costEvents, heartbeatRunEvents, heartbeatRuns, issueComments, issues, issueThreadInteractions, type Db } from "@paperclipai/db";
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

/** The adapter name alone does not distinguish CLI accounting from ACP windows. */
function invokedAcpProducer(command: unknown, adapterType: unknown) {
  if (typeof command !== "string") return null;
  const executable = command.trim().split(/[\\/]/).at(-1);
  if (executable === "codex-acp" && adapterType === "codex_local") return "codex_session_cumulative_delta";
  if (executable === "claude-agent-acp" && adapterType === "claude_local") return "claude_prompt_usage";
  return null;
}

function hasCompleteAcpUsage(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "usageJson" | "resultJson" | "runnerProfileJson">, producer: string) {
  const usage = object(run.usageJson);
  const accounting = object(usage.usageAccounting ?? object(run.resultJson).usageAccounting);
  const pin = object(object(run.runnerProfileJson).legacyUsageScope);
  return usage.usageUnknown === false && usage.usageSource === "per_run"
    && typeof usage.totalTokens === "number" && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= 0
    && accounting.version === 1 && accounting.source === producer && accounting.completeness === "complete"
    && accounting.bindingVerified === true && accounting.runId === run.id && accounting.boundary === "typed_prompt_reply"
    && typeof accounting.sessionId === "string" && Boolean(accounting.sessionId.trim()) && accounting.sessionId.length <= 200
    && typeof accounting.scopeHash === "string" && /^[a-f0-9]{64}$/.test(accounting.scopeHash)
    && (producer === "codex_session_cumulative_delta" ? accounting.baselineVerified === true
      : accounting.baselineSource === "producer_prompt_usage_reset")
    && (pin.version !== 1 || (pin.source === producer && pin.sessionId === accounting.sessionId && pin.scopeHash === accounting.scopeHash));
}

/** Server-observed lower bounds remain distinct from complete billing totals. */
export function readTrustedLegacyUsageCheckpoint(run: Pick<typeof heartbeatRuns.$inferSelect,
  "id" | "companyId" | "agentId" | "controllerBootId" | "runtimeMode" | "runnerProfileJson" | "resultJson">) {
  const checkpoint = object(object(run.resultJson).legacyUsageCheckpoint);
  const pin = object(object(run.runnerProfileJson).legacyUsageScope);
  const source = checkpoint.source;
  const supportedSource = (source === "codex_session_cumulative_delta" && checkpoint.adapterType === "codex_local")
    || (source === "claude_prompt_usage" && checkpoint.adapterType === "claude_local");
  if (run.runtimeMode !== "legacy" || !run.controllerBootId || !supportedSource
      || checkpoint.version !== 1 || pin.version !== 1
      || checkpoint.bindingVerified !== true || checkpoint.baselineVerified !== true
      || checkpoint.runId !== run.id || checkpoint.companyId !== run.companyId || checkpoint.agentId !== run.agentId
      || checkpoint.controllerBootId !== run.controllerBootId
      || typeof checkpoint.sessionId !== "string" || !checkpoint.sessionId.trim() || checkpoint.sessionId.length > 200
      || typeof checkpoint.scopeHash !== "string" || !/^[a-f0-9]{64}$/.test(checkpoint.scopeHash)
      || pin.source !== source || pin.sessionId !== checkpoint.sessionId || pin.scopeHash !== checkpoint.scopeHash
      || typeof checkpoint.observedTotalTokens !== "number" || !Number.isSafeInteger(checkpoint.observedTotalTokens) || checkpoint.observedTotalTokens < 0
      || typeof checkpoint.usageUnknown !== "boolean"
      || typeof checkpoint.observedAt !== "string" || !Number.isFinite(Date.parse(checkpoint.observedAt))) return null;
  return { version: 1 as const, source: source as "codex_session_cumulative_delta" | "claude_prompt_usage",
    sessionId: checkpoint.sessionId, scopeHash: checkpoint.scopeHash,
    observedTotalTokens: checkpoint.observedTotalTokens, usageUnknown: checkpoint.usageUnknown,
    companyId: run.companyId, agentId: run.agentId, runId: run.id, controllerBootId: run.controllerBootId,
  };
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
  /** Reuse this exact ledger accounting for server-authored continuation budgets. */
  onObservedPolicy?: (snapshot: { issueId: string; limits: IssueResourceLimits; usage: ResourceUsage }) => void;
}) {
  const policies = await readIssueResourcePolicies(db, input.companyId, input.issueId);
  for (const policy of policies) {
    if (!policy.limits.maxTokensPerIssue && !policy.limits.maxAutomaticRuns && !policy.limits.maxNoProgressRuns) continue;
    const ids = sql`(${subtree(input.companyId, policy.issueId)})`;
    const runIssue = sql`coalesce(${heartbeatRuns.nativeIssueId}::text, ${heartbeatRuns.contextSnapshot}->>'issueId')`;
    const runIds = sql`(select id::text from ${ids} resource_run_scope)`;
    // Drizzle removes Column qualifiers in a single-table select list. A
    // correlated inner ledger query must keep these explicit outer identities.
    const outerRunId = sql`${sql.identifier("heartbeat_runs")}.${sql.identifier("id")}`;
    const outerCompanyId = sql`${sql.identifier("heartbeat_runs")}.${sql.identifier("company_id")}`;
    const hasLegacyCheckpoint = sql`(${heartbeatRuns.runtimeMode} = 'legacy' and jsonb_typeof(${heartbeatRuns.resultJson}->'legacyUsageCheckpoint') is not null)`;
    const [tokens] = policy.limits.maxTokensPerIssue ? await db.select({
      totalTokens: sql<number>`coalesce(sum(${costEvents.totalTokens}), 0)::double precision`,
      unknownUsageCount: sql<number>`count(*) filter (where ${costEvents.totalTokens} is null)::int`,
    }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), inArray(costEvents.issueId, ids))) : [{ totalTokens: 0, unknownUsageCount: 0 }];
    const [unreported] = policy.limits.maxTokensPerIssue ? await db.select({
      totalTokens: sql<number>`coalesce(sum(case when jsonb_typeof(${heartbeatRuns.usageJson}->'totalTokens') = 'number'
        then greatest(0, (${heartbeatRuns.usageJson}->>'totalTokens')::numeric - coalesce((
          select sum(recorded.total_tokens) from cost_events recorded
          where recorded.company_id = ${outerCompanyId} and recorded.heartbeat_run_id = ${outerRunId}
            and recorded.issue_id in ${ids}
        ), 0)) else 0 end), 0)::double precision`,
      unknownUsageCount: sql<number>`count(*) filter (where jsonb_typeof(${heartbeatRuns.usageJson}->'totalTokens') is distinct from 'number'
        and ((${heartbeatRuns.resultJson}->'nativeUsageCheckpoint'->>'version') = '1'
          or not exists (select 1 from cost_events recorded where recorded.company_id = ${outerCompanyId}
            and recorded.heartbeat_run_id = ${outerRunId} and recorded.issue_id in ${ids}
            and recorded.total_tokens is not null)))::int`,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds),
      isNotNull(heartbeatRuns.startedAt),
      sql`not ${hasLegacyCheckpoint}`,
      sql`(${heartbeatRuns.finishedAt} is not null or (${heartbeatRuns.resultJson}->'nativeUsageCheckpoint'->>'version') = '1')`,
      sql`((${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted') is distinct from 'false'
        or (${heartbeatRuns.resultJson}->'nativeUsageCheckpoint'->>'version') = '1')`,
    )) : [{ totalTokens: 0, unknownUsageCount: 0 }];
    const legacyRows = policy.limits.maxTokensPerIssue ? await db.select({
      id: heartbeatRuns.id, companyId: heartbeatRuns.companyId, agentId: heartbeatRuns.agentId,
      controllerBootId: heartbeatRuns.controllerBootId, runtimeMode: heartbeatRuns.runtimeMode,
      runnerProfileJson: heartbeatRuns.runnerProfileJson, resultJson: heartbeatRuns.resultJson, usageJson: heartbeatRuns.usageJson,
    }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds),
      isNotNull(heartbeatRuns.startedAt), hasLegacyCheckpoint)) : [];
    const legacyLedger = legacyRows.length ? await db.select({ runId: costEvents.heartbeatRunId,
      total: sql<number>`coalesce(sum(${costEvents.totalTokens}), 0)::double precision`,
    }).from(costEvents).where(and(eq(costEvents.companyId, input.companyId), inArray(costEvents.issueId, ids),
      inArray(costEvents.heartbeatRunId, legacyRows.map(row => row.id)))).groupBy(costEvents.heartbeatRunId) : [];
    const legacyRecorded = new Map(legacyLedger.map(row => [row.runId, Number(row.total)]));
    let legacyTotal = 0, legacyUnknown = 0;
    for (const row of legacyRows) {
      const checkpoint = readTrustedLegacyUsageCheckpoint(row);
      if (!checkpoint) { legacyUnknown += 1; continue; }
      const usage = object(row.usageJson);
      const total = typeof usage.totalTokens === "number" && Number.isSafeInteger(usage.totalTokens) && usage.totalTokens >= checkpoint.observedTotalTokens
        && usage.usageUnknown === false ? usage.totalTokens : null;
      // Count the highwater above the same scoped ledger only once. Partial
      // observations never erase their uncertainty or borrow native authority.
      legacyTotal += Math.max(0, Math.max(total ?? 0, checkpoint.observedTotalTokens) - (legacyRecorded.get(row.id) ?? 0));
      if (total === null) legacyUnknown += 1;
    }
    // Older ACP adapters published the latest context window as a numeric
    // per-run total. Neither that number nor its cost row establishes complete
    // consumption. The immutable server invocation binds the actual producer;
    // keep historical rows/dollars intact and hold only aggregate admission.
    const acpInvocations = policy.limits.maxTokensPerIssue ? await db.select({
      id: heartbeatRuns.id, usageJson: heartbeatRuns.usageJson, resultJson: heartbeatRuns.resultJson,
      runnerProfileJson: heartbeatRuns.runnerProfileJson,
      command: sql<string | null>`${heartbeatRunEvents.payload}->>'command'`,
      adapterType: sql<string | null>`${heartbeatRunEvents.payload}->>'adapterType'`,
    }).from(heartbeatRuns).innerJoin(heartbeatRunEvents, and(eq(heartbeatRunEvents.runId, heartbeatRuns.id),
      eq(heartbeatRunEvents.companyId, heartbeatRuns.companyId), eq(heartbeatRunEvents.agentId, heartbeatRuns.agentId)))
      .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds),
        eq(heartbeatRuns.runtimeMode, "legacy"), isNotNull(heartbeatRuns.startedAt), isNotNull(heartbeatRuns.finishedAt),
        eq(heartbeatRunEvents.eventType, "adapter.invoke"), eq(heartbeatRunEvents.stream, "system"),
        isNull(heartbeatRunEvents.sourceEventId), isNull(heartbeatRunEvents.sourceInstanceId), isNull(heartbeatRunEvents.sourceSeq),
        sql`(${heartbeatRuns.resultJson}->'executionRecovery'->>'providerWorkStarted') is distinct from 'false'`)) : [];
    const unqualifiedAcpRuns = new Set<string>();
    for (const row of acpInvocations) {
      const producer = invokedAcpProducer(row.command, row.adapterType);
      if (producer && !hasCompleteAcpUsage(row, producer)) unqualifiedAcpRuns.add(row.id);
    }
    const [runs] = policy.limits.maxAutomaticRuns ? await db.select({ count: sql<number>`count(*)::int` }).from(heartbeatRuns)
      .where(and(eq(heartbeatRuns.companyId, input.companyId), inArray(runIssue, runIds), isNotNull(heartbeatRuns.startedAt),
        // A caller-supplied manual label is not authority. Only an original
        // operator wake receipt bound to this company/Agent/run is exempt;
        // automatic retries and continuations still spend automatic attempts.
        sql`not coalesce((
          ${heartbeatRuns.invocationSource} = 'on_demand'
          and ${heartbeatRuns.triggerDetail} = 'manual'
          and coalesce(${heartbeatRuns.contextSnapshot}->>'retryOfRunId', '') = ''
          and coalesce(${heartbeatRuns.contextSnapshot}->>'scheduledRetryAttempt', '0') = '0'
          and coalesce(${heartbeatRuns.contextSnapshot}->>'continuationAttempt', '0') = '0'
          and exists (select 1 from agent_wakeup_requests manual_wake
            where manual_wake.id = ${heartbeatRuns.wakeupRequestId}
              and manual_wake.company_id = ${heartbeatRuns.companyId}
              and manual_wake.agent_id = ${heartbeatRuns.agentId}
              and manual_wake.run_id = ${heartbeatRuns.id}
              and manual_wake.requested_by_actor_type = 'user'
              and manual_wake.requested_by_actor_id is not null
              and btrim(manual_wake.requested_by_actor_id) <> ''
              and manual_wake.source = 'on_demand'
              and manual_wake.trigger_detail = 'manual')
        ), false)`, input.excludeRunId ? ne(heartbeatRuns.id, input.excludeRunId) : undefined)) : [{ count: 0 }];
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
    const usage: ResourceUsage = { totalTokens: Number(tokens?.totalTokens ?? 0) + Number(unreported?.totalTokens ?? 0) + legacyTotal,
      unknownUsageCount: Number(tokens?.unknownUsageCount ?? 0) + Number(unreported?.unknownUsageCount ?? 0) + legacyUnknown + unqualifiedAcpRuns.size, automaticRuns: Number(runs?.count ?? 0),
      noProgressRuns, boundedWait, newHumanInput: humanComments.length > 0 || humanResponses.length > 0 };
    input.onObservedPolicy?.({ issueId: policy.issueId, limits: policy.limits, usage });
    const decision = evaluateIssueResourceLimits(policy.limits, usage);
    if (decision.blocked) return { ...decision, resourceIssueId: policy.issueId, title: policy.title };
  }
  return null;
}
