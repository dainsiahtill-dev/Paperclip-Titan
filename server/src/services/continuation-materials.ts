import { and, asc, eq } from "drizzle-orm";
import { assets, documents, issueAttachments, issueDocuments, type Db } from "@paperclipai/db";
import type { ExecutionCheckpointEnvelope } from "@paperclipai/shared";
import { nativeSha256 } from "./native-runtime/canonical.js";

/** Registered immutable asset digests and current linked document bodies; no model claims or remote URL trust. */
export async function readContinuationMaterials(db: Db, companyId: string, issueId: string): Promise<ExecutionCheckpointEnvelope["materials"]> {
  const documentRows = await db.select({ id: documents.id, body: documents.latestBody, revision: documents.latestRevisionNumber })
    .from(issueDocuments).innerJoin(documents, and(eq(documents.id, issueDocuments.documentId), eq(documents.companyId, companyId)))
    .where(and(eq(issueDocuments.companyId, companyId), eq(issueDocuments.issueId, issueId))).orderBy(asc(documents.id));
  const attachmentRows = await db.select({ id: issueAttachments.id, sha256: assets.sha256 })
    .from(issueAttachments).innerJoin(assets, and(eq(assets.id, issueAttachments.assetId), eq(assets.companyId, companyId)))
    .where(and(eq(issueAttachments.companyId, companyId), eq(issueAttachments.issueId, issueId))).orderBy(asc(issueAttachments.id));
  return [...documentRows.map(row => ({ kind: "document" as const, id: row.id, revision: row.revision, sha256: nativeSha256(row.body) })),
    ...attachmentRows.map(row => ({ kind: "attachment" as const, id: row.id, sha256: row.sha256 }))];
}
