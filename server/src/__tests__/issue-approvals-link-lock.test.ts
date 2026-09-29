import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { approvals, companies, createDb, issueApprovals, issues } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { issueApprovalService } from "../services/issue-approvals.js";

const support = await getEmbeddedPostgresTestSupport();
const describeDb = support.supported ? describe : describe.skip;

describeDb("issue approval linking claim fence", () => {
  let tempDb: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>> | null = null;
  let db: ReturnType<typeof createDb>;

  beforeAll(async () => {
    tempDb = await startEmbeddedPostgresTestDatabase("paperclip-issue-approval-fence-");
    db = createDb(tempDb.connectionString);
  }, 30_000);

  afterAll(async () => {
    await tempDb?.cleanup();
  }, 30_000);

  it("waits for the issue claim lock before linking a new pending approval", async () => {
    const companyId = randomUUID();
    const issueId = randomUUID();
    const approvalId = randomUUID();
    await db.insert(companies).values({ id: companyId, name: "Fence", issuePrefix: "FEN", requireBoardApprovalForNewAgents: false });
    await db.insert(issues).values({ id: issueId, companyId, title: "Review me", status: "blocked", priority: "medium" });
    await db.insert(approvals).values({ id: approvalId, companyId, type: "hire_agent", status: "pending", payload: {} });

    let releaseLock!: () => void;
    let signalLocked!: () => void;
    const lockReleased = new Promise<void>((resolve) => { releaseLock = resolve; });
    const locked = new Promise<void>((resolve) => { signalLocked = resolve; });
    const holding = db.transaction(async (tx) => {
      await tx.select({ id: issues.id }).from(issues).where(eq(issues.id, issueId)).for("update");
      signalLocked();
      await lockReleased;
    });
    await locked;
    let linked = false;
    const linking = issueApprovalService(db).link(issueId, approvalId).then(() => { linked = true; });

    try {
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(linked).toBe(false);
      const pending = await db.select({ issueId: issueApprovals.issueId }).from(issueApprovals);
      expect(pending).toEqual([]);
    } finally {
      releaseLock();
      await holding;
      await linking;
    }
    expect(linked).toBe(true);
  }, 30_000);
});
