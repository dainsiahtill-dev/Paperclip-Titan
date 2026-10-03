import { createHash } from "node:crypto";
import { and, eq } from "drizzle-orm";
import { documentRevisions, documents, issueDocuments, issueExecutionDecisions,
  issueRelations, issues, issueWorkProducts, type Db } from "@paperclipai/db";

type RecordValue = Record<string, unknown>;
export interface MaterialFacts {
  documents: Array<{ key: string; body: string; [key: string]: unknown }>;
  products: Array<{ type: string; provider: string; externalId?: string | null; url?: string | null; metadata?: RecordValue | null; [key: string]: unknown }>;
  blockers: Array<{ id: string; status: string }>;
  decisions: Array<{ stageId: string; outcome: string }>;
  complete?: boolean;
}
export interface MaterialProgressSnapshot {
  version: 1; fingerprint: string; document: string; artifact: string;
  dependency: string; decision: string; complete: boolean;
}
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const normalizedSet = (values: unknown[]) => [...new Set(values.map((value) => JSON.stringify(value)))].sort();

/** Hashes meaningful source content; recency, counts, narration and display approval carry no weight. */
export function materialProgressSnapshot(facts: MaterialFacts): MaterialProgressSnapshot {
  const document = hash(normalizedSet(facts.documents.filter((row) => !row.key.startsWith("system-")).map((row) => [row.key, hash(row.body)])));
  const artifact = hash(normalizedSet(facts.products.map((row) => {
    const metadata = row.metadata ?? {};
    return [row.type, row.provider, row.externalId ?? null, row.url ?? null,
      ...["sha256", "contentDigest", "commitSha", "revision", "attachmentId", "resourceRef"].map((key) => metadata[key] ?? null)];
  })));
  const dependency = hash(normalizedSet(facts.blockers.map((row) => [row.id, ["done", "cancelled"].includes(row.status) ? "ready" : "waiting"])));
  const decision = hash(normalizedSet(facts.decisions.map((row) => [row.stageId, row.outcome])));
  return { version: 1, document, artifact, dependency, decision,
    fingerprint: hash([document, artifact, dependency, decision]), complete: facts.complete !== false };
}

export function compareMaterialProgress(before: MaterialProgressSnapshot | null, after: MaterialProgressSnapshot) {
  if (!before || before.version !== 1 || !before.complete || !after.complete) return { state: "unknown" as const, kind: "none" as const };
  for (const kind of ["document", "artifact", "dependency", "decision"] as const) {
    if (before[kind] !== after[kind]) return { state: "advanced" as const, kind };
  }
  return { state: "unchanged" as const, kind: "none" as const };
}

/** Bounded, company-scoped observation; an incomplete sample never proves progress. */
export async function readIssueMaterialProgress(db: Db, companyId: string, issueId: string) {
  const bound = 513;
  const [documentRows, productRows, blockerRows, decisionRows] = await Promise.all([
    db.select({ key: issueDocuments.key, body: documentRevisions.body }).from(issueDocuments)
      .innerJoin(documents, eq(documents.id, issueDocuments.documentId))
      .innerJoin(documentRevisions, eq(documentRevisions.id, documents.latestRevisionId))
      .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId),
        eq(documents.companyId, companyId), eq(documentRevisions.companyId, companyId))).limit(bound),
    db.select().from(issueWorkProducts).where(and(eq(issueWorkProducts.companyId, companyId), eq(issueWorkProducts.issueId, issueId))).limit(bound),
    db.select({ id: issues.id, status: issues.status }).from(issueRelations)
      .innerJoin(issues, eq(issues.id, issueRelations.issueId))
      .where(and(eq(issueRelations.companyId, companyId), eq(issueRelations.relatedIssueId, issueId), eq(issues.companyId, companyId))).limit(bound),
    db.select({ stageId: issueExecutionDecisions.stageId, outcome: issueExecutionDecisions.outcome })
      .from(issueExecutionDecisions).where(and(eq(issueExecutionDecisions.companyId, companyId), eq(issueExecutionDecisions.issueId, issueId))).limit(bound),
  ]);
  return materialProgressSnapshot({ documents: documentRows, products: productRows,
    blockers: blockerRows, decisions: decisionRows,
    complete: [documentRows, productRows, blockerRows, decisionRows].every((rows) => rows.length < bound) });
}
