import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterAll, afterEach, beforeAll, expect, it } from "vitest";
import { eq, sql } from "drizzle-orm";
import { agents, companies, createDb, environmentLeases, heartbeatRuns, legacyWorkspaceEpochClosures, workspaceWriteOwners, type Db } from "@paperclipai/db";
import { workspaceWriteOwnershipService } from "../services/workspace-write-ownership.js";
import { legacyWorkspaceEpochClosedRunIds } from "../services/legacy-workspace-epoch-closure.js";
import { runChildProcess, withWorkspaceProcessGuard } from "@paperclipai/adapter-utils/server-utils";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
let db: Db, root: string;
beforeAll(async () => { temporary = await startEmbeddedPostgresTestDatabase("pc-operator-reconcile-"); db = createDb(temporary.connectionString); root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-operator-reconcile-")); }, 20_000);
afterEach(async () => { await db.execute(sql`truncate companies cascade`); await db.delete(workspaceWriteOwners); await db.delete(legacyWorkspaceEpochClosures); });
afterAll(async () => { await temporary?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });
async function fixture() {
  const oldCompany = randomUUID(), companyId = randomUUID(), agentId = randomUUID(), runId = randomUUID();
  await db.insert(companies).values([{ id: oldCompany, name: "Historical", issuePrefix: "HST" }, { id: companyId, name: "Current", issuePrefix: "CUR" }]);
  await db.insert(agents).values({ id: agentId, companyId: oldCompany, name: "Old", role: "engineer", adapterType: "codex_local" });
  await db.insert(heartbeatRuns).values({ id: runId, companyId: oldCompany, agentId, status: "succeeded", processPid: 2147480000,
    processGroupId: 2147480000, processStartedAt: new Date(0), controllerBootId: randomUUID(), contextSnapshot: { paperclipWorkspace: { cwd: path.join(root, "deleted", runId) } } });
  await db.insert(environmentLeases).values({ companyId: oldCompany, heartbeatRunId: runId, provider: "local", status: "released" });
  const cwd = await fs.mkdtemp(path.join(root, "source-"));
  const evidencePath = path.join(root, `${randomUUID()}.json`), bytes = JSON.stringify({ exactRunId: runId, archivalMatch: true, namespaceProofAvailable: false });
  await fs.writeFile(evidencePath, bytes, { mode: 0o600 });
  const filename = "../services/legacy-workspace-operator-reconciliation.js";
  const module = await import(filename).catch(() => ({} as any));
  expect(module.legacyWorkspaceOperatorReconciliationService).toBeTypeOf("function");
  const service = module.legacyWorkspaceOperatorReconciliationService(db);
  const scope = { companyId, cwd }, inspection = await service.inspect(scope);
  return { service, scope, runId, oldCompany, inspection, request: { ...scope, expectedDigest: inspection.digest,
    reason: "Board explicitly authorizes scoped manual reconciliation after inspecting the retained historical evidence; no namespace proof is asserted.",
    evidence: { path: evidencePath, sha256: createHash("sha256").update(bytes).digest("hex") } } };
}

it("records a scoped manual decision, preserves old history, and permits real writing and a second dispatch", async () => {
  const f = await fixture(), owners = workspaceWriteOwnershipService(db);
  const oldRuns = await db.select().from(heartbeatRuns), oldLeases = await db.select().from(environmentLeases);
  expect(await owners.claim({ ...f.scope, runId: randomUUID() })).toEqual({ outcome: "busy" });
  const decision = await f.service.reconcile(f.request);
  expect(decision.state).toBe("operator_reconciled");
  expect(decision.closure.proof).toBe("operator_decision");
  expect(decision.closure.namespaceDrained).toBe(false);
  expect((await f.service.reconcile(f.request)).id).toBe(decision.id);
  expect(await legacyWorkspaceEpochClosedRunIds(db, decision.realm)).toEqual(new Set());
  const otherRoot = await fs.mkdtemp(path.join(root, "other-"));
  expect(await owners.claim({ companyId: f.scope.companyId, cwd: otherRoot, runId: randomUUID() })).toEqual({ outcome: "busy" });
  expect(await owners.claim({ companyId: f.oldCompany, cwd: f.scope.cwd, runId: randomUUID() })).toEqual({ outcome: "busy" });
  for (const effect of ["first", "second"]) {
    const claim = await owners.claim({ ...f.scope, runId: randomUUID() });
    expect(claim.outcome).toBe("claimed");
    if (claim.outcome !== "claimed") throw new Error("manual scope not admitted");
    const result = await withWorkspaceProcessGuard(owners.guard(claim.owner), () => runChildProcess(effect, "/bin/sh", ["-c", `printf ${effect} > ${effect}`],
      { cwd: f.scope.cwd, env: {}, timeoutSec: 3, graceSec: 1, onLog: async () => {} }));
    expect(result.exitCode).toBe(0);
    expect(await owners.confirmStopped(claim.owner, effect)).toMatchObject({ proof: "namespace_drained" });
    await owners.releaseIfStopped(claim.owner);
    expect(await fs.readFile(path.join(f.scope.cwd, effect), "utf8")).toBe(effect);
  }
  expect(await db.select().from(heartbeatRuns)).toEqual(oldRuns);
  expect(await db.select().from(environmentLeases)).toEqual(oldLeases);
});

it.each(["wrong_digest", "evidence_changed", "missing_reason"])("refuses unreviewed manual reconciliation (%s)", async kind => {
  const f = await fixture();
  if (kind === "wrong_digest") f.request.expectedDigest = "0".repeat(64);
  if (kind === "evidence_changed") await fs.appendFile(f.request.evidence.path, "changed");
  if (kind === "missing_reason") f.request.reason = "";
  await expect(f.service.reconcile(f.request)).rejects.toThrow();
  expect(await db.select().from(legacyWorkspaceEpochClosures)).toEqual([]);
});

it("later history drift revokes the narrow admission exemption", async () => {
  const f = await fixture(); await f.service.reconcile(f.request);
  await db.update(heartbeatRuns).set({ processPid: 2147479999 }).where(eq(heartbeatRuns.id, f.runId));
  expect(await workspaceWriteOwnershipService(db).claim({ ...f.scope, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("replacing the approved directory at the same path does not transfer manual authority", async () => {
  const f = await fixture(); await f.service.reconcile(f.request);
  await fs.rename(f.scope.cwd, `${f.scope.cwd}-original`); await fs.mkdir(f.scope.cwd);
  expect(await workspaceWriteOwnershipService(db).claim({ ...f.scope, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("a new unknown historical run is not covered by the prior manual decision", async () => {
  const f = await fixture(); await f.service.reconcile(f.request);
  const [old] = await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, f.runId));
  const id = randomUUID();
  await db.insert(heartbeatRuns).values({ ...old!, id, processPid: 2147479999 });
  await db.insert(environmentLeases).values({ companyId: old!.companyId, heartbeatRunId: id, provider: "local", status: "released" });
  expect(await workspaceWriteOwnershipService(db).claim({ ...f.scope, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("a manually reconciled row cannot acquire admission by masquerading as a namespace receipt", async () => {
  const f = await fixture(); const row = await f.service.reconcile(f.request);
  await db.update(legacyWorkspaceEpochClosures).set({ closure: { ...row.closure, proof: "namespace_drained", namespaceDrained: true } }).where(eq(legacyWorkspaceEpochClosures.id, row.id));
  expect(await workspaceWriteOwnershipService(db).claim({ ...f.scope, runId: randomUUID() })).toEqual({ outcome: "busy" });
});

it("an active protected writer cannot be replaced by an operator reconciliation", async () => {
  const f = await fixture();
  const claim = await workspaceWriteOwnershipService(db).claim({ ...f.scope, runId: f.runId });
  expect(claim.outcome).toBe("claimed");
  await expect(f.service.reconcile(f.request)).rejects.toThrow("workspace_held");
  expect(await db.select().from(legacyWorkspaceEpochClosures)).toEqual([]);
});
