import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import { and, eq, isNull } from "drizzle-orm";
import { companies, legacyWorkspaceEpochClosures, type Db } from "@paperclipai/db";
import { z } from "zod";
import { persistActivity } from "./activity-log.js";
import { legacyClosureError, readLegacyWorkspaceHost } from "./legacy-workspace-host.js";
import { legacyEpochCohortUnchanged, legacyWorkspaceEpochClosureService, readLegacyEpochCapture } from "./legacy-workspace-epoch-closure.js";
import { physicalWorkspaceIdentity, type PhysicalWorkspaceIdentity } from "./workspace-physical-identity.js";
import { nativeSha256 } from "./native-runtime/canonical.js";

const hash = (value: unknown) => nativeSha256(JSON.parse(JSON.stringify(value)));
const sha = z.string().regex(/^[a-f0-9]{64}$/);
const sourceSchema = z.object({ root: z.string(), device: z.string(), inode: z.string(), realm: sha, resourceKey: sha }).strict();
const scopeSchema = z.object({ companyId: z.string().uuid(), source: sourceSchema }).strict();
const evidenceSchema = z.object({ path: z.string().min(1), sha256: sha }).strict();
const decisionSchema = z.object({ kind: z.literal("LEGACY_WORKSPACE_OPERATOR_RECONCILIATION"), version: z.literal(1),
  proof: z.literal("operator_decision"), namespaceDrained: z.literal(false),
  acceptedUncertainty: z.literal("historical_namespace_exit_not_proven"),
  id: z.string().uuid(), generation: z.string().uuid(), preparedDigest: sha, reviewedDigest: sha,
  scope: scopeSchema, reason: z.string().trim().min(20).max(4000), evidence: evidenceSchema,
  operatorUid: z.number().int().nonnegative(), at: z.string().datetime() }).strict();
const inputScope = z.object({ companyId: z.string().uuid(), cwd: z.string().min(1) }).strict();
const reconcileSchema = inputScope.extend({ expectedDigest: sha, reason: decisionSchema.shape.reason, evidence: evidenceSchema }).strict();
const reviewedDigest = (cohortDigest: string, scope: z.infer<typeof scopeSchema>) => hash({ cohortDigest, scope });

/** Explicit owner disposition, not a namespace/host exit proof. It is deliberately
 * separate from automatic epoch closure and applies only to one physical source
 * and company. All later writers still require ordinary guarded drain/release. */
export function legacyWorkspaceOperatorReconciliationService(db: Db, options: { databaseDirectory?: string } = {}) {
  const checkedOptions = z.object({ databaseDirectory: z.string().optional() }).strict().parse(options);
  async function inspect(tx: Db, request: z.infer<typeof inputScope>) {
    const inspection = await legacyWorkspaceEpochClosureService(tx, checkedOptions).inspect();
    const source = await physicalWorkspaceIdentity(request.cwd);
    const [company] = await tx.select({ id: companies.id }).from(companies).where(eq(companies.id, request.companyId)).for("share");
    if (!company || source.realm !== inspection.realm || (await fs.stat(source.root)).uid !== inspection.host.uid)
      throw legacyClosureError("operator_scope_unverified");
    const scope = { companyId: request.companyId, source };
    return { ...inspection, cohortDigest: inspection.digest, scope, digest: reviewedDigest(inspection.digest, scope) };
  }
  return {
    async inspect(input: { companyId: string; cwd: string }) {
      const request = inputScope.parse(input);
      return db.transaction(tx => inspect(tx as unknown as Db, request));
    },
    async reconcile(input: { companyId: string; cwd: string; expectedDigest: string; reason: string; evidence: { path: string; sha256: string } }) {
      const request = reconcileSchema.parse(input);
      return db.transaction(async transaction => {
        const tx = transaction as unknown as Db;
        const current = await inspect(tx, { companyId: request.companyId, cwd: request.cwd });
        if (current.digest !== request.expectedDigest || !current.cohort.length) throw legacyClosureError("historical_cohort_changed");
        const evidencePath = await fs.realpath(request.evidence.path), stat = await fs.stat(evidencePath);
        if (!stat.isFile() || stat.uid !== current.host.uid || stat.size > 10 * 1024 * 1024) throw legacyClosureError("operator_evidence_unverified");
        const bytes = await fs.readFile(evidencePath);
        if (createHash("sha256").update(bytes).digest("hex") !== request.evidence.sha256) throw legacyClosureError("operator_evidence_changed");
        const [open] = await tx.select({ id: legacyWorkspaceEpochClosures.id }).from(legacyWorkspaceEpochClosures)
          .where(and(eq(legacyWorkspaceEpochClosures.realm, current.realm), isNull(legacyWorkspaceEpochClosures.closedAt)));
        if (open) throw legacyClosureError("closure_already_prepared");
        const prior = await tx.select().from(legacyWorkspaceEpochClosures)
          .where(and(eq(legacyWorkspaceEpochClosures.realm, current.realm), eq(legacyWorkspaceEpochClosures.state, "operator_reconciled")));
        for (const row of prior) {
          const parsed = decisionSchema.safeParse(row.closure);
          if (parsed.success && parsed.data.reviewedDigest === current.digest && hash(parsed.data.scope) === hash(current.scope)
            && parsed.data.id === row.id && parsed.data.generation === row.generation
            && parsed.data.preparedDigest === row.digest && parsed.data.operatorUid === current.host.uid
            && row.closedAt?.toISOString() === parsed.data.at
            && parsed.data.reason === request.reason && parsed.data.evidence.sha256 === request.evidence.sha256
            && readLegacyEpochCapture(row).digest === current.cohortDigest
            && readLegacyEpochCapture(row).host.uid === current.host.uid
            && hash(readLegacyEpochCapture(row).host.database) === hash(current.host.database)) return row;
        }
        const id = randomUUID(), generation = randomUUID(), at = new Date();
        const decision = decisionSchema.parse({ kind: "LEGACY_WORKSPACE_OPERATOR_RECONCILIATION", version: 1, proof: "operator_decision",
          namespaceDrained: false, acceptedUncertainty: "historical_namespace_exit_not_proven", id, generation,
          preparedDigest: current.cohortDigest, reviewedDigest: current.digest, scope: current.scope,
          reason: request.reason, evidence: { path: evidencePath, sha256: request.evidence.sha256 }, operatorUid: current.host.uid, at: at.toISOString() });
        const [row] = await tx.insert(legacyWorkspaceEpochClosures).values({ id, generation, realm: current.realm, state: "operator_reconciled",
          digest: current.cohortDigest, closedAt: at, updatedAt: at, closure: decision,
          manifest: { kind: "LEGACY_WORKSPACE_EPOCH_CLOSURE", version: 1, event: "prepared", id, generation, realm: current.realm,
            host: current.host, cohort: current.cohort, digest: current.cohortDigest, at: at.toISOString() } }).returning();
        for (const companyId of new Set([request.companyId, ...current.cohort.map(entry => entry.companyId)])) {
          await persistActivity(tx, { companyId, actorType: "system", actorId: `local_workspace_operator:${current.host.uid}`,
            action: "workspace.legacy_operator_reconciled", entityType: "legacy_workspace_epoch_closure", entityId: id,
            details: { proof: "operator_decision", namespaceDrained: false, reviewedDigest: current.digest,
              runIds: current.cohort.filter(entry => entry.companyId === companyId).map(entry => entry.runId),
              ...(companyId === request.companyId ? { sourceRoot: current.scope.source.root, reason: request.reason } : {}) } });
        }
        return row!;
      });
    },
  };
}

export async function legacyWorkspaceOperatorReconciledRunIds(db: Db, scope: { companyId: string; source: PhysicalWorkspaceIdentity }): Promise<Set<string>> {
  const rows = await db.select().from(legacyWorkspaceEpochClosures).where(and(eq(legacyWorkspaceEpochClosures.realm, scope.source.realm),
    eq(legacyWorkspaceEpochClosures.state, "operator_reconciled")));
  if (!rows.length) return new Set();
  try {
    return await db.transaction(async transaction => {
      const tx = transaction as unknown as Db, host = await readLegacyWorkspaceHost(tx), result = new Set<string>();
      for (const row of rows) {
        const parsed = decisionSchema.safeParse(row.closure);
        if (!parsed.success || !row.closedAt) continue;
        const decision = parsed.data, capture = readLegacyEpochCapture(row);
        if (decision.id !== row.id || decision.generation !== row.generation || decision.preparedDigest !== row.digest
          || decision.at !== row.closedAt.toISOString() || decision.operatorUid !== host.uid || capture.host.uid !== host.uid
          || hash(host.database) !== hash(capture.host.database) || hash(decision.scope) !== hash(scope)
          || decision.reviewedDigest !== reviewedDigest(capture.digest, decision.scope)) continue;
        if (!await legacyEpochCohortUnchanged(tx, capture)) continue;
        for (const entry of capture.cohort) result.add(entry.runId);
      }
      return result;
    });
  } catch { return new Set(); }
}
