import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { expect, it } from "vitest";
import { companies, createDb, documents, documentRevisions, issueDocuments, issues } from "@paperclipai/db";
import { startEmbeddedPostgresTestDatabase } from "../__tests__/helpers/embedded-postgres.js";
import { getTaskPlanContext } from "./task-plan-context.js";

it("reads the approved immutable revision after a newer draft changes and enforces company scope", async () => {
  const temporary = await startEmbeddedPostgresTestDatabase("paperclip-plan-revision-");
  const db = createDb(temporary.connectionString);
  try {
    const companyId = randomUUID(), issueId = randomUUID(), documentId = randomUUID(), approved = randomUUID(), draft = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Pinned plan", issuePrefix: "PIN" });
    await db.insert(issues).values({ id: issueId, companyId, title: "Approved task" });
    await db.insert(documents).values({ id: documentId, companyId, latestBody: "New draft", latestRevisionId: draft, latestRevisionNumber: 2 });
    await db.insert(documentRevisions).values([{ id: approved, companyId, documentId, revisionNumber: 1, body: "MUST preserve approved scope" }, { id: draft, companyId, documentId, revisionNumber: 2, body: "New draft" }]);
    await db.insert(issueDocuments).values({ companyId, issueId, documentId, key: "plan" });
    await db.update(documents).set({ latestBody: "Draft changed again" }).where(eq(documents.id, documentId));
    expect(await getTaskPlanContext({ db, companyId, issueId, approvedRevisionId: approved })).toMatchObject({ revisionId: approved, revisionNumber: 1, body: "MUST preserve approved scope" });
    expect(await getTaskPlanContext({ db, companyId: randomUUID(), issueId, approvedRevisionId: approved })).toBeNull();
  } finally { await temporary.cleanup(); }
}, 20_000);
