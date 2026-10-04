import { createHash } from "node:crypto";
import { and, desc, eq } from "drizzle-orm";
import { assets, documents, documentRevisions, heartbeatRuns, issueAttachments, issueDocuments, issueWorkProducts, type Db } from "@paperclipai/db";
import { workspaceFileResourceService } from "./workspace-file-resources.js";

export function deliveryCanonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
    ? Object.fromEntries(Object.entries(item).sort(([left], [right]) => left.localeCompare(right))) : item);
}
export function deliveryDigest(value: unknown): string {
  return createHash("sha256").update(deliveryCanonicalJson(value)).digest("hex");
}

export function workProductMaterialIdentity(row: Partial<typeof issueWorkProducts.$inferSelect>) {
  const metadata = row.metadata ?? {};
  const ref = metadata.resourceRef && typeof metadata.resourceRef === "object" ? metadata.resourceRef as Record<string, unknown> : null;
  const resourceRef = ref ? Object.fromEntries(["kind", "issueId", "projectId", "workspaceKind", "workspaceId", "relativePath"].filter((key) => ref[key] !== undefined).map((key) => [key, ref[key]])) : null;
  const managed = Boolean(metadata.attachmentId || metadata.documentId || resourceRef);
  return {
    type: row.type ?? null, provider: row.provider ?? null, externalId: row.externalId ?? null,
    url: row.url ?? null, summary: managed ? null : row.summary ?? null,
    executionWorkspaceId: row.executionWorkspaceId ?? null, runtimeServiceId: row.runtimeServiceId ?? null,
    materialReferences: { attachmentId: metadata.attachmentId ?? null, documentId: metadata.documentId ?? null, resourceRef },
  };
}

export async function workProductMaterialSnapshot(db: Db, row: typeof issueWorkProducts.$inferSelect) {
  if (row.deletedAt) return null;
  const metadata = row.metadata ?? {};
  const guid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
  if (metadata.attachmentId != null && (typeof metadata.attachmentId !== "string" || !guid.test(metadata.attachmentId))) return null;
  const attachmentId = typeof metadata.attachmentId === "string" ? metadata.attachmentId : null;
  const producers = new Set<string>([row.producerActorType === "agent" ? row.producerActorId : null, row.producerAgentId].filter((id): id is string => Boolean(id)));
  let contentWriterId: string | null = row.materialWriterActorType === "agent" ? row.materialWriterActorId : row.materialWriterAgentId;
  let managedContent: Record<string, unknown> | null = null;
  if (attachmentId) {
    const [asset] = await db.select({ sha256: assets.sha256, assetId: assets.id, attachmentId: issueAttachments.id, producerAgentId: assets.createdByAgentId })
      .from(issueAttachments).innerJoin(assets, eq(assets.id, issueAttachments.assetId)).where(and(eq(issueAttachments.id, attachmentId), eq(issueAttachments.companyId, row.companyId), eq(issueAttachments.issueId, row.issueId), eq(assets.companyId, row.companyId)));
    if (!asset) return null;
    if (asset.producerAgentId) producers.add(asset.producerAgentId);
    const { producerAgentId: _producer, ...content } = asset;
    managedContent = content;
  }
  const resource = metadata.resourceRef && typeof metadata.resourceRef === "object" ? metadata.resourceRef as Record<string, unknown> : null;
  if (resource) {
    if (resource.kind !== "workspace_file" || typeof resource.relativePath !== "string" || (resource.issueId && resource.issueId !== row.issueId)) return null;
    try {
      const content = await workspaceFileResourceService(db).readContent(row.issueId, {
        path: resource.relativePath,
        workspace: resource.workspaceKind === "project_workspace" ? "project" : "execution",
        ...(resource.workspaceKind === "project_workspace" && typeof resource.projectId === "string" && typeof resource.workspaceId === "string" ? { projectId: resource.projectId, workspaceId: resource.workspaceId } : {}),
      });
      if (content.resource.workspaceId !== resource.workspaceId) return null;
      const bytes = Buffer.from(content.content.data, content.content.encoding === "base64" ? "base64" : "utf8");
      managedContent = { ...(managedContent ?? {}), workspaceId: content.resource.workspaceId, sha256: createHash("sha256").update(bytes).digest("hex"), byteSize: bytes.length };
    } catch (error) {
      // A disappearing, remote, oversized or denied file has no current proof.
      // Use the existing workspace resolver's company, path and secret gates.
      if (error instanceof Error && "status" in error) return null;
      throw error;
    }
  }
  if (metadata.documentId != null && (typeof metadata.documentId !== "string" || !guid.test(metadata.documentId))) return null;
  if (typeof metadata.documentId === "string") {
    if (!guid.test(metadata.documentId)) return null;
    const [document] = await db.select({ id: documents.id, format: documents.format, body: documents.latestBody, producerAgentId: documents.createdByAgentId, writerAgentId: documents.updatedByAgentId })
      .from(issueDocuments).innerJoin(documents, eq(documents.id, issueDocuments.documentId)).where(and(eq(issueDocuments.companyId, row.companyId), eq(issueDocuments.issueId, row.issueId), eq(documents.companyId, row.companyId), eq(documents.id, metadata.documentId)));
    if (!document) return null;
    if (document.producerAgentId) producers.add(document.producerAgentId);
    const revisions = await db.select({ body: documentRevisions.body, format: documentRevisions.format, agentId: documentRevisions.createdByAgentId }).from(documentRevisions).where(and(eq(documentRevisions.companyId, row.companyId), eq(documentRevisions.documentId, document.id))).orderBy(desc(documentRevisions.revisionNumber));
    // The first writer of the current contiguous body/format owns its content.
    // Saving an unchanged body or renaming its display title does not create a
    // new material author or invalidate prior independent byte acceptance.
    let author = document.writerAgentId;
    for (const revision of revisions) {
      if (revision.body !== document.body || revision.format !== document.format) break;
      author = revision.agentId;
    }
    contentWriterId = author;
    managedContent = { ...(managedContent ?? {}), documentId: document.id, format: document.format, body: document.body };
  }
  // A mutable remote URL or service reference is not a content snapshot. Its
  // inspected output must be attached, a current issue document, or a readable
  // registered workspace file before it can receive authoritative acceptance.
  if (!managedContent && (row.type !== "document" || row.url || row.runtimeServiceId || !row.summary?.trim())) return null;
  const runId = row.materialUpdatedByRunId ?? row.createdByRunId;
  const [writer] = runId ? await db.select({ agentId: heartbeatRuns.agentId }).from(heartbeatRuns).where(and(eq(heartbeatRuns.companyId, row.companyId), eq(heartbeatRuns.id, runId))) : [];
  if (writer?.agentId && !row.materialWriterActorType) contentWriterId ??= writer.agentId;
  if (contentWriterId) producers.add(contentWriterId);
  return {
    contentText: typeof managedContent?.body === "string" ? managedContent.body : null,
    workProductId: row.id,
    materialVersion: String(row.materialVersion),
    contentDigest: deliveryDigest({ version: 1, material: workProductMaterialIdentity(row), managedContent }),
    producerAgentIds: [...producers],
    producerAgentId: row.producerAgentId ?? [...producers][0] ?? null,
    materialWriterAgentId: contentWriterId,
  };
}
