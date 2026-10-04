import { and, desc, eq, inArray, isNull, sql } from "drizzle-orm";
import { agents, completionContracts, heartbeatRuns, issues, issueThreadInteractions, issueWorkProducts, projects, type Db } from "@paperclipai/db";
import { issueDeliveryDecisions } from "@paperclipai/db/schema/issue_delivery_decisions";
import type { DeliveryAssessment, DeliveryCriterion, DeliveryDecisionInput, DeliveryPolicy } from "@paperclipai/shared/types/delivery";
import { deliveryDecisionSchema, deliveryPolicySchema } from "@paperclipai/shared/validators/delivery";
import { conflict, forbidden, notFound, unprocessable } from "../errors.js";
import { logActivity, publishActivity, type ActivityPublication } from "./activity-log.js";
import { assertIssueReviewVerdictActorAllowed } from "./issue-review-policy.js";
import { normalizeIssueExecutionPolicy, parseIssueExecutionState } from "./issue-execution-policy.js";
import { issueService } from "./issues.js";
import { resolveTaskWatchdogMutationScope } from "./task-watchdog-scope.js";
import { deliveryCanonicalJson, deliveryDigest, workProductMaterialSnapshot } from "./work-product-material.js";

type Issue = typeof issues.$inferSelect;
export type DeliveryActor = { type: string; actorType?: string; actorId?: string; userId?: string | null; agentId?: string | null; companyId?: string | null; runId?: string | null };
export function rethrowDeliveryInputLock(error: unknown): never {
  let cause: unknown = error;
  for (let depth = 0; depth < 5 && cause && typeof cause === "object"; depth++, cause = (cause as { cause?: unknown }).cause) {
    if ((cause as { code?: string }).code === "55P03") throw conflict("Delivery inputs are changing; retry after the current mutation finishes");
  }
  throw error;
}
function record(value: unknown): Record<string, unknown> { return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}; }
export function parseDeliveryPolicy(value: unknown): DeliveryPolicy | null { const parsed = deliveryPolicySchema.safeParse(value); return parsed.success ? parsed.data : null; }
function policyForIssue(issue: Issue) { return parseDeliveryPolicy(record(issue.executionPolicy).deliveryPolicy); }
function typedReviewers(issue: Issue) {
  const stages = record(issue.executionPolicy).stages;
  if (!Array.isArray(stages)) return [];
  return stages.filter((stage) => record(stage).type === "review").flatMap((stage) => {
    const participants = record(stage).participants;
    return Array.isArray(participants) ? participants.filter((entry) => record(entry).type === "agent" && typeof record(entry).agentId === "string").map((entry) => record(entry).agentId as string) : [];
  });
}

export async function resolveDeliveryDefinition(db: Db, companyId: string, issueId: string, candidate?: Issue) {
  const issue = candidate ?? (await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).limit(1))[0];
  if (!issue) throw notFound("Issue not found");
  const chain: Issue[] = [issue], seen = new Set([issue.id]); let current = issue;
  while (current.parentId && chain.length < 100) {
    if (seen.has(current.parentId)) throw conflict("Delivery scope ancestry is cyclic");
    seen.add(current.parentId);
    const [parent] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, current.parentId)));
    if (!parent) break; chain.push(parent); current = parent;
  }
  if (current.parentId && chain.length >= 100) throw conflict("Delivery ancestry exceeds the bounded verification scope");
  const projectIds = [...new Set(chain.flatMap((entry) => entry.projectId ? [entry.projectId] : []))];
  const projectRows = projectIds.length ? await db.select().from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, projectIds))) : [];
  const projectPolicies = projectIds.flatMap((id) => { const parsed = parseDeliveryPolicy(projectRows.find((project) => project.id === id)?.deliveryPolicy); return parsed ? [parsed] : []; });
  const projectPolicy = projectPolicies.find((policy) => policy.mode === "verified_delivery") ?? projectPolicies[0] ?? null;
  const own = policyForIssue(issue), policies = chain.flatMap((entry) => policyForIssue(entry) ? [policyForIssue(entry)!] : []);
  const inherited = [...policies, ...projectPolicies];
  const mode = inherited.some((policy) => policy.mode === "verified_delivery") ? "verified_delivery" as const : "agent_claim_policy" as const;
  const configured = own?.reviewerAgentIds?.length ? own.reviewerAgentIds : inherited.find((policy) => policy.reviewerAgentIds?.length)?.reviewerAgentIds;
  const reviewers = [...new Set(configured?.length ? configured : typedReviewers(issue))].sort();
  const managers = [...new Set(inherited.flatMap((policy) => policy.managerAgentIds ?? []))].sort();
  const authority = { issueId, companyId, projectId: issue.projectId, mode, reviewPolicy: issue.reviewPolicy ?? "anyone", reviewerAgentIds: reviewers };
  const authorityHash = deliveryDigest(authority);
  return { issue, mode, own, projectPolicy, projectIds, reviewerAgentIds: reviewers, managerAgentIds: managers, authorityHash,
    hasExplicitCriteria: Boolean(own?.criteria?.length || projectPolicy?.criteria?.length),
    criteria: own?.criteria?.length ? own.criteria : projectPolicy?.criteria?.length ? projectPolicy.criteria : [{ id: "objective", requirement: issue.description?.trim() || `Complete: ${issue.title}`, scope: "issue" as const }] };
}

export async function assertDeliveryPolicyCreation(db: Db, issue: Issue) {
  const policy = policyForIssue(issue);
  if (policy) {
    await assertManagersAndReviewers(db, issue.companyId, policy);
    if (issue.createdByAgentId) {
      const withoutOwn = { ...issue, executionPolicy: { ...record(issue.executionPolicy), deliveryPolicy: null } } as Issue;
      const inherited = await resolveDeliveryDefinition(db, issue.companyId, issue.id, withoutOwn);
      if (!inherited.managerAgentIds.includes(issue.createdByAgentId) || policy.managerAgentIds?.length || (inherited.mode === "verified_delivery" && policy.mode !== "verified_delivery")) throw forbidden("An agent cannot create its own delivery authority or manager grants");
    }
  }
  if (issue.status === "done") await deliveryAuthorityService(db, true).assertCanComplete(issue.companyId, issue.id);
}

async function assertReviewer(db: Db, definition: Awaited<ReturnType<typeof resolveDeliveryDefinition>>, actor: DeliveryActor, material?: Awaited<ReturnType<typeof workProductMaterialSnapshot>>) {
  const actorType = actor.type === "board" || actor.type === "user" ? "user" : actor.type === "agent" ? "agent" : null;
  const actorId = actorType === "user" ? actor.userId ?? actor.actorId : actor.agentId;
  if (!actorType || !actorId) throw forbidden("Authenticated delivery reviewer required");
  if (actorType === "agent") {
    const [run] = actor.runId ? await db.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, definition.issue.companyId), eq(heartbeatRuns.agentId, actorId), eq(heartbeatRuns.id, actor.runId))) : [];
    if (!run || run.status !== "running") throw forbidden("Reviewer run must be registered and current");
    if ((await resolveTaskWatchdogMutationScope(db, { type: "agent", agentId: actorId, companyId: definition.issue.companyId, runId: actor.runId })).kind !== "none") throw forbidden("Watchdog capacity cannot grant delivery acceptance authority");
    const state = parseIssueExecutionState(definition.issue.executionState);
    const executor = state?.returnAssignee?.type === "agent" ? state.returnAssignee.agentId : definition.issue.assigneeAgentId;
    if ([executor, material?.producerAgentId, material?.materialWriterAgentId, ...(material?.producerAgentIds ?? [])].includes(actorId)) throw forbidden("Executor or material producer cannot accept their own deliverable");
    if (!definition.reviewerAgentIds.includes(actorId)) throw forbidden("Delivery reviewer must be configured independently for this scope");
    const [reviewer] = await db.select({ status: agents.status }).from(agents).where(and(eq(agents.companyId, definition.issue.companyId), eq(agents.id, actorId)));
    if (!reviewer || !["active", "idle", "running"].includes(reviewer.status)) throw forbidden("Delivery reviewer is not available");
  }
  await assertIssueReviewVerdictActorAllowed(db, { issue: definition.issue, actor: { type: actorType, id: actorId } });
  return { actorType, actorId };
}

export async function assertManagersAndReviewers(db: Db, companyId: string, policy: DeliveryPolicy) {
  const ids = [...new Set([...(policy.managerAgentIds ?? []), ...(policy.reviewerAgentIds ?? [])])];
  if (!ids.length) return;
  const found = await db.select({ id: agents.id, status: agents.status }).from(agents).where(and(eq(agents.companyId, companyId), inArray(agents.id, ids)));
  if (found.length !== ids.length || found.some((agent) => ["terminated", "pending_approval"].includes(agent.status))) throw unprocessable("Delivery managers and reviewers must be eligible same-company agents");
}

export async function assertDeliveryPolicyMutation(db: Db, before: Issue, after: Issue, actor: { agentId?: string | null; userId?: string | null }) {
  const previous = policyForIssue(before), next = policyForIssue(after);
  if (deliveryCanonicalJson(previous) === deliveryCanonicalJson(next)) return;
  if (next) await assertManagersAndReviewers(db, before.companyId, next);
  if (!actor.agentId) return;
  const definition = await resolveDeliveryDefinition(db, before.companyId, before.id, before);
  if (!definition.managerAgentIds.includes(actor.agentId)) throw forbidden("Delivery criteria and policy are managed by the board or configured managers");
  if (definition.mode === "verified_delivery" && (!next || next.mode !== "verified_delivery")) throw forbidden("An agent cannot erase a verified-delivery policy");
  if (deliveryCanonicalJson(previous?.managerAgentIds ?? []) !== deliveryCanonicalJson(next?.managerAgentIds ?? [])) throw forbidden("Delivery manager grants are board-managed");
}

export async function assertDeliveryScopeMutation(db: Db, before: Issue, after: Issue, agentId?: string | null) {
  if (!agentId || (before.parentId === after.parentId && before.projectId === after.projectId)) return;
  const old = await resolveDeliveryDefinition(db, before.companyId, before.id, before);
  if (old.mode !== "verified_delivery") return;
  const next = await resolveDeliveryDefinition(db, before.companyId, before.id, after);
  if (next.mode !== "verified_delivery" || old.authorityHash !== next.authorityHash || deliveryCanonicalJson(old.criteria) !== deliveryCanonicalJson(next.criteria)) throw forbidden("An agent cannot relocate work to escape a verified-delivery scope");
}

export function deliveryAuthorityService(db: Db, inTransaction = false) {
  async function lockInputs(companyId: string, issueId: string, candidate?: Issue, forMutation = false) {
    const definition = await resolveDeliveryDefinition(db, companyId, issueId, candidate);
    const scope = await productScope(companyId, issueId, "subtree");
    const ids = new Set(scope);
    let ancestor = definition.issue;
    for (let depth = 0; ancestor.parentId && depth < 99; depth++) {
      ids.add(ancestor.parentId);
      const [parent] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, ancestor.parentId)));
      if (!parent) break; ancestor = parent;
    }
    try {
      // These stable parents also fence product insertion/promotion. NOWAIT
      // rejects a conflicting mutation without reversing another row owner's
      // lock order. No company-wide table lock or provider cancellation.
      await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, [...ids]))).orderBy(issues.id).for(forMutation ? "update" : "share", { noWait: true });
      if (definition.projectIds.length) await db.select({ id: projects.id }).from(projects).where(and(eq(projects.companyId, companyId), inArray(projects.id, definition.projectIds))).orderBy(projects.id).for("share", { noWait: true });
      await db.select({ id: issueWorkProducts.id }).from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId), inArray(issueWorkProducts.issueId, scope))).orderBy(issueWorkProducts.id).for("share", { noWait: true });
    } catch (error) {
      rethrowDeliveryInputLock(error);
    }
  }
  async function materializeContract(companyId: string, issueId: string, candidate?: Issue): Promise<{ definition: Awaited<ReturnType<typeof resolveDeliveryDefinition>>; row: typeof completionContracts.$inferSelect; criteria: Array<DeliveryCriterion & { criterionDigest: string }> }> {
    if (!inTransaction) return db.transaction((tx) => deliveryAuthorityService(tx as unknown as Db, true).materializeContract(companyId, issueId, candidate));
    const definition = await resolveDeliveryDefinition(db, companyId, issueId, candidate);
    await db.execute(sql`select pg_advisory_xact_lock(hashtextextended(${`paperclip:native-completion-contract:${companyId}:${issueId}`},0))`);
    const [latest] = await db.select().from(completionContracts).where(and(eq(completionContracts.companyId, companyId), eq(completionContracts.issueId, issueId))).orderBy(desc(completionContracts.revision)).limit(1);
    const priorDelivery = record(latest?.contractJson.delivery);
    // A default criterion is frozen once materialized for this authority scope.
    // Display title/description edits cannot rewrite its acceptance conditions.
    const criteria = !definition.hasExplicitCriteria && priorDelivery.authorityHash === definition.authorityHash && Array.isArray(priorDelivery.criteria)
      ? priorDelivery.criteria as DeliveryCriterion[] : definition.criteria;
    const fingerprints = criteria.map((criterion) => ({ ...criterion, criterionDigest: deliveryDigest({ authorityHash: definition.authorityHash, criterion: { id: criterion.id, requirement: criterion.requirement, artifactType: criterion.artifactType ?? null, scope: criterion.scope ?? "issue" } }) }));
    const delivery = { version: 1, mode: definition.mode, authorityHash: definition.authorityHash, reviewerAgentIds: definition.reviewerAgentIds, criteria: fingerprints };
    const semantic = { objective: definition.issue.title, delivery };
    if (latest && deliveryCanonicalJson(record(latest.contractJson).delivery) === deliveryCanonicalJson(delivery)) return { definition, row: latest, criteria: fingerprints };
    const revision = (latest?.revision ?? 0) + 1;
    const json = { revision: String(revision), objective: semantic.objective, criteria: criteria.map((criterion) => ({ id: criterion.id, requirement: criterion.requirement })), delivery };
    const hash = deliveryDigest({ schemaVersion: "paperclip.completion-contract.v1", policyVersion: "verified-delivery-v1", contract: json });
    const [row] = await db.insert(completionContracts).values({ companyId, issueId, revision, schemaVersion: "paperclip.completion-contract.v1", policyVersion: "verified-delivery-v1", risk: definition.mode === "verified_delivery" ? "standard" : "low", completionAuthority: definition.mode === "verified_delivery" ? "server_arbiter" : "agent_claim_policy", incompleteCriteriaPolicy: "preserve_non_terminal", contractJson: json, canonicalSha256: hash, createdByActorType: "system", createdByActorId: "delivery-authority", supersedesContractId: latest?.id ?? null }).returning();
    if (!row) throw new Error("Delivery contract was not persisted");
    return { definition, row, criteria: fingerprints };
  }

  async function productScope(companyId: string, issueId: string, scope: "issue" | "subtree") {
    if (scope !== "subtree") return [issueId];
    const rows = await db.execute(sql`with recursive tree as (select id,0 depth from issues where company_id=${companyId} and id=${issueId} union all select child.id,tree.depth+1 from issues child join tree on child.parent_id=tree.id where child.company_id=${companyId} and child.origin_kind<>'task_watchdog' and tree.depth<99) select id from tree`);
    return [...new Set((rows as unknown as Array<{ id: string }>).map((row) => row.id))];
  }

  async function assessment(companyId: string, issueId: string, candidate?: Issue, forMutation = false): Promise<DeliveryAssessment> {
    if (!inTransaction) return db.transaction((tx) => deliveryAuthorityService(tx as unknown as Db, true).assessment(companyId, issueId, candidate, forMutation));
    await lockInputs(companyId, issueId, candidate, forMutation);
    const current = await materializeContract(companyId, issueId, candidate);
    const criteria = await Promise.all(current.criteria.map(async (criterion) => {
      const ids = await productScope(companyId, issueId, criterion.scope ?? "issue");
      const [product] = await db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId), isNull(issueWorkProducts.deletedAt), inArray(issueWorkProducts.issueId, ids), ...(criterion.artifactType ? [eq(issueWorkProducts.type, criterion.artifactType)] : [])))
        .orderBy(desc(issueWorkProducts.isPrimary), desc(issueWorkProducts.createdAt), desc(issueWorkProducts.id)).limit(1);
      const material = product ? await workProductMaterialSnapshot(db, product) : null;
      const [decision] = await db.select().from(issueDeliveryDecisions).where(and(eq(issueDeliveryDecisions.companyId, companyId), eq(issueDeliveryDecisions.issueId, issueId), eq(issueDeliveryDecisions.criterionId, criterion.id)))
        .orderBy(desc(issueDeliveryDecisions.createdAt), desc(issueDeliveryDecisions.id)).limit(1);
      const valid = Boolean(material && decision && decision.workProductId === material.workProductId && decision.criterionDigest === criterion.criterionDigest && decision.materialVersion === material.materialVersion && decision.contentDigest === material.contentDigest);
      const [reviewer] = valid && decision?.agentId ? await db.select({ name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, decision.agentId))) : [];
      return { ...criterion, state: valid ? decision!.verdict as "accepted" | "rejected" : decision ? "stale" as const : "missing" as const,
        workProductId: material?.workProductId ?? null, materialVersion: material?.materialVersion ?? null, contentDigest: material?.contentDigest ?? null,
        workProductIssueId: material ? product?.issueId ?? null : null,
        decisionId: valid ? decision!.id : null, reason: valid ? decision!.reason : null,
        provenance: valid ? { decisionId: decision!.id, actorType: decision!.actorType, actorId: decision!.actorId, agentId: decision!.agentId, runId: decision!.runId, createdAt: decision!.createdAt.toISOString(), reviewerName: reviewer?.name ?? (decision!.actorType === "user" ? "Board" : null) } : null };
    }));
    return { version: 1, mode: current.definition.mode, contractId: current.row.id, contractRevision: current.row.revision, contractHash: current.row.canonicalSha256, criteria, canComplete: current.definition.mode === "agent_claim_policy" || (criteria.length > 0 && criteria.every((criterion) => criterion.state === "accepted")), reviewerAgentIds: current.definition.reviewerAgentIds };
  }

  async function recordDecision(companyId: string, issueId: string, actor: DeliveryActor, raw: DeliveryDecisionInput, options: { beforeCommit?: (transaction: Db) => Promise<void> } = {}) {
    const input = deliveryDecisionSchema.parse(raw), requestDigest = deliveryDigest(input);
    const publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      const typed = tx as unknown as Db;
      const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
      if (!issue) throw notFound("Issue not found");
      const actorType = actor.type === "board" || actor.type === "user" ? "user" : actor.type === "agent" ? "agent" : null;
      const actorId = actorType === "user" ? actor.userId ?? actor.actorId : actor.agentId;
      if (!actorType || !actorId) throw forbidden("Authenticated delivery reviewer required");
      const [previous] = await tx.select().from(issueDeliveryDecisions).where(and(eq(issueDeliveryDecisions.companyId, companyId), eq(issueDeliveryDecisions.issueId, issueId), eq(issueDeliveryDecisions.requestId, input.requestId)));
      if (previous) {
        if (previous.requestDigest !== requestDigest || previous.actorType !== actorType || previous.actorId !== actorId) throw conflict("Delivery decision request ID was already used for different content");
        return { decision: previous, created: false, nextOwnerId: null };
      }
      if (actorType === "agent") {
        try {
          const [run] = actor.runId ? await tx.select().from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, companyId), eq(heartbeatRuns.agentId, actorId), eq(heartbeatRuns.id, actor.runId))).for("update", { noWait: true }) : [];
          if (!run || run.status !== "running") throw forbidden("Reviewer run must be registered and current");
        } catch (error) { rethrowDeliveryInputLock(error); }
      }
      const definition = await resolveDeliveryDefinition(typed, companyId, issueId);
      const [product] = await tx.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId), isNull(issueWorkProducts.deletedAt), eq(issueWorkProducts.id, input.workProductId))).for("update");
      if (!product) throw notFound("Work product not found");
      const material = await workProductMaterialSnapshot(typed, product);
      if (!material) throw conflict("Work product has no verifiable current material");
      await assertReviewer(typed, definition, actor, material);
      if (input.reviewInteractionId) {
        const [interaction] = await tx.select().from(issueThreadInteractions).where(and(eq(issueThreadInteractions.companyId, companyId), eq(issueThreadInteractions.issueId, issueId), eq(issueThreadInteractions.id, input.reviewInteractionId)));
        if (!interaction || interaction.status !== "resolved" || (actorType === "agent" ? interaction.resolvedByAgentId !== actorId || interaction.resolvedByRunId !== actor.runId : interaction.resolvedByUserId !== actorId)) throw forbidden("Review interaction must be an actual resolved verdict by this reviewer in this scope");
      }
      const current = await deliveryAuthorityService(typed, true).assessment(companyId, issueId, undefined, true);
      const criterion = current.criteria.find((entry) => entry.id === input.criterionId);
      if (!criterion) throw unprocessable("Unknown delivery criterion");
      if (current.contractHash !== input.expectedContractHash || criterion.criterionDigest !== input.expectedCriterionDigest || criterion.workProductId !== product.id || material.materialVersion !== input.expectedMaterialVersion || material.contentDigest !== input.expectedContentDigest) throw conflict("Delivery decision is stale; inspect the current criterion and material again");
      await options.beforeCommit?.(typed);
      const [decision] = await tx.insert(issueDeliveryDecisions).values({ companyId, issueId, requestId: input.requestId, requestDigest,
        contractId: current.contractId, contractRevision: current.contractRevision, contractHash: current.contractHash,
        criterionId: input.criterionId, criterionDigest: criterion.criterionDigest, workProductId: product.id, materialVersion: material.materialVersion, contentDigest: material.contentDigest,
        verdict: input.verdict, reason: input.reason, actorType, actorId, agentId: actorType === "agent" ? actorId : null, runId: actorType === "agent" ? actor.runId : null, reviewInteractionId: input.reviewInteractionId ?? null }).returning();
      if (!decision) throw new Error("Delivery decision was not persisted");
      const state = parseIssueExecutionState(issue.executionState);
      const nextOwnerId = input.verdict === "rejected"
        ? state?.returnAssignee?.type === "agent" ? state.returnAssignee.agentId : material.producerAgentId ?? issue.assigneeAgentId
        : issue.assigneeAgentId;
      if (input.verdict === "rejected") {
        await deliveryAuthorityService(typed, true).invalidateMaterialScopes(companyId, issueId, publications);
        const [owner] = nextOwnerId ? await tx.select({ name: agents.name }).from(agents).where(and(eq(agents.companyId, companyId), eq(agents.id, nextOwnerId))) : [];
        await issueService(typed).addComment(issueId,
          `验收未通过：${criterion.requirement}\n\n${input.reason}\n\n下一步：${owner?.name ?? "当前任务负责人"} 修改本任务的交付产物，再提交这一项验收。`,
          actorType === "agent" ? { agentId: actorId, runId: actor.runId } : { userId: actorId },
          { authorizationReason: "independent_delivery_verdict" }, tx);
      }
      await logActivity(typed, { companyId, actorType, actorId, agentId: actorType === "agent" ? actorId : null, runId: actorType === "agent" ? actor.runId : null, action: `issue.delivery_criterion_${input.verdict}`, entityType: "issue", entityId: issueId,
        details: { decisionId: decision.id, criterionId: decision.criterionId, criterionDigest: decision.criterionDigest, contractHash: decision.contractHash, workProductId: product.id, materialVersion: material.materialVersion, contentDigest: material.contentDigest, verdict: decision.verdict, nextOwnerId } }, publications);
      return { decision, created: true, nextOwnerId };
    });
    for (const publication of publications) publishActivity(publication);
    return result;
  }

  async function permissions(companyId: string, issueId: string, actor: DeliveryActor) {
    const definition = await resolveDeliveryDefinition(db, companyId, issueId);
    let canReview = false;
    try { await assertReviewer(db, definition, actor); canReview = true; } catch (error) { if (!(error instanceof Error && "status" in error && error.status === 403)) throw error; }
    return { canReview, canManagePolicy: actor.type === "board" || actor.type === "user" || Boolean(actor.agentId && definition.managerAgentIds.includes(actor.agentId)) };
  }

  async function updatePolicy(companyId: string, issueId: string, actor: DeliveryActor, raw: DeliveryPolicy) {
    const policy = deliveryPolicySchema.parse(raw), publications: ActivityPublication[] = [];
    const result = await db.transaction(async (tx) => {
      const typed = tx as unknown as Db;
      const [issue] = await tx.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, issueId))).for("update");
      if (!issue) throw notFound("Issue not found");
      const actorType = actor.type === "board" || actor.type === "user" ? "user" : "agent";
      const actorId = actorType === "user" ? actor.userId ?? actor.actorId : actor.agentId;
      if (!actorId) throw forbidden("Authenticated delivery policy manager required");
      const executionPolicy = normalizeIssueExecutionPolicy({ ...record(issue.executionPolicy), stages: record(issue.executionPolicy).stages ?? [], deliveryPolicy: policy }) as unknown as Record<string, unknown>;
      await assertDeliveryPolicyMutation(typed, issue, { ...issue, executionPolicy }, { agentId: actorType === "agent" ? actorId : null, userId: actorType === "user" ? actorId : null });
      await issueService(typed).update(issueId, { executionPolicy, actorAgentId: actorType === "agent" ? actorId : null, actorUserId: actorType === "user" ? actorId : null, companyGuard: companyId }, typed, publications);
      await logActivity(typed, { companyId, actorType, actorId, agentId: actorType === "agent" ? actorId : null, runId: actorType === "agent" ? actor.runId : null, action: "issue.delivery_policy_updated", entityType: "issue", entityId: issueId, details: { mode: policy.mode, criterionIds: policy.criteria?.map((criterion) => criterion.id) ?? [] } }, publications);
      return deliveryAuthorityService(typed, true).assessment(companyId, issueId);
    });
    for (const publication of publications) publishActivity(publication);
    return { ...result, permissions: await permissions(companyId, issueId, actor) };
  }

  async function assertCanComplete(companyId: string, issueId: string, candidate?: Issue) {
    const definition = await resolveDeliveryDefinition(db, companyId, issueId, candidate);
    if (definition.mode !== "verified_delivery") return;
    const current = await assessment(companyId, issueId, candidate, true);
    if (!current.canComplete) throw conflict("Verified delivery requires current independent acceptance for every criterion", { code: "delivery_acceptance_required", criteria: current.criteria.filter((criterion) => criterion.state !== "accepted").map((criterion) => ({ id: criterion.id, state: criterion.state })) });
  }
  async function invalidateMaterialScopes(companyId: string, issueId: string, publications: ActivityPublication[]) {
    const seen = new Set<string>(); let currentId: string | null = issueId;
    while (currentId && seen.size < 100) {
      if (seen.has(currentId)) throw conflict("Delivery material ancestry is cyclic");
      seen.add(currentId);
      const [issue] = await db.select().from(issues).where(and(eq(issues.companyId, companyId), eq(issues.id, currentId)));
      if (!issue) break;
      if (issue.status === "done" && (await resolveDeliveryDefinition(db, companyId, issue.id)).mode === "verified_delivery") {
        await issueService(db).update(issue.id, { updatedAt: new Date(), companyGuard: companyId }, db, publications);
      }
      currentId = issue.parentId;
    }
  }
  async function invalidateProjectScopes(companyId: string, projectId: string, publications: ActivityPublication[]) {
    const scoped = await db.execute(sql`with recursive scope as (select id from issues where company_id=${companyId} and project_id=${projectId} union select child.id from issues child join scope on child.parent_id=scope.id where child.company_id=${companyId}) select id from scope`);
    const ids = (scoped as unknown as Array<{id: string}>).map((row) => row.id);
    if (!ids.length) return;
    try { await db.select({ id: issues.id }).from(issues).where(and(eq(issues.companyId, companyId), inArray(issues.id, ids))).orderBy(issues.id).for("update", { noWait: true }); }
    catch (error) { rethrowDeliveryInputLock(error); }
    for (const id of ids) await invalidateMaterialScopes(companyId, id, publications);
  }
  return { assessment, recordDecision, materializeContract, assertCanComplete, permissions, updatePolicy, invalidateMaterialScopes, invalidateProjectScopes };
}
