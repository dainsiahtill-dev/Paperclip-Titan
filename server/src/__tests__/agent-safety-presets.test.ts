import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, createDb } from "@paperclipai/db";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
const support = await getEmbeddedPostgresTestSupport();
const suite = support.supported ? describe : describe.skip;
suite("server-owned safety presets", () => {
  let db: ReturnType<typeof createDb>;
  let started: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => { started = await startEmbeddedPostgresTestDatabase("safety-presets"); db = createDb(started.connectionString); }, 60000);
  afterAll(async () => { await started?.cleanup(); });
  async function company() {
    const nonce = randomUUID().slice(0, 8);
    return (await db.insert(companies).values({ name: nonce, issuePrefix: `P${nonce.toUpperCase()}`, requireBoardApprovalForNewAgents: false }).returning())[0]!;
  }
  function app(actor: Express.Request["actor"]) {
    const a = express(); a.use(express.json()); a.use((req, _res, next) => { req.actor = actor; next(); }); a.use("/api", agentRoutes(db)); a.use(errorHandler); return a;
  }
  it("minimal direct service create persists one slot and sandbox enabled", async () => {
    const co = await company();
    const created = await agentService(db).create(co.id, { name: "new", adapterType: "codex_local" });
    expect(created.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 1 } });
    expect(created.adapterConfig).toMatchObject({ dangerouslyBypassApprovalsAndSandbox: false });
  });
  it("rejects contradictory audit create before persistence", async () => {
    const co = await company(); const board = app({ type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" });
    const result = await request(board).post(`/api/companies/${co.id}/agents`).send({ name: "unsafe", adapterType: "codex_local", runtimeConfig: { safetyPreset: "audit" }, adapterConfig: { dangerouslyBypassApprovalsAndSandbox: true } });
    expect(result.status, JSON.stringify(result.body)).toBe(422);
  });
  it("minimal public create persists safe defaults", async () => {
    const co = await company();
    const result = await request(app({ type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" })).post(`/api/companies/${co.id}/agents`).send({ name: "new", adapterType: "codex_local" });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 1 } });
    expect(result.body.adapterConfig).toMatchObject({ dangerouslyBypassApprovalsAndSandbox: false });
  });
  it("public audit create persists enforced profile and board can deliberately leave audit", async () => {
    const co = await company(); const board = app({ type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" });
    const result = await request(board).post(`/api/companies/${co.id}/agents`).send({ name: "audit", adapterType: "codex_local", runtimeConfig: { safetyPreset: "audit" } });
    expect(result.status, JSON.stringify(result.body)).toBe(201);
    expect(result.body.adapterConfig).toMatchObject({ engine: "cli", sandboxMode: "read-only", dangerouslyBypassApprovalsAndSandbox: false });
    const updated = await request(board).patch(`/api/agents/${result.body.id}`).send({ runtimeConfig: {}, adapterConfig: { sandboxMode: "workspace-write", dangerouslyBypassApprovalsAndSandbox: true } });
    expect(updated.status, JSON.stringify(updated.body)).toBe(200);
    expect(updated.body.runtimeConfig.safetyPreset).toBeUndefined();
  });
  it("preserves explicit service/import values", async () => {
    const co = await company();
    const created = await agentService(db).create(co.id, { name: "legacy", adapterType: "codex_local", adapterConfig: { dangerouslyBypassSandbox: true }, runtimeConfig: { heartbeat: { maxConcurrentRuns: 20 } } });
    expect(created.adapterConfig.dangerouslyBypassSandbox).toBe(true);
    expect(created.runtimeConfig).toMatchObject({ heartbeat: { maxConcurrentRuns: 20 } });
  });
  it("direct service audit create enforces actual CLI mode", async () => {
    const co = await company();
    const created = await agentService(db).create(co.id, { name: "audit", adapterType: "codex_local", runtimeConfig: { safetyPreset: "audit" } });
    expect(created.adapterConfig).toMatchObject({ engine: "cli", sandboxMode: "read-only", dangerouslyBypassApprovalsAndSandbox: false });
    await expect(agentService(db).update(created.id, { adapterConfig: { ...created.adapterConfig, dangerouslyBypassSandbox: true } })).rejects.toThrow(/Audit/);
  });
  it.each([{}, { safetyPreset: "implementation" }])("own configuration cannot remove audit using runtime replacement %j", async (runtimeConfig) => {
    const co = await company();
    const [agent] = await db.insert(agents).values({ companyId: co.id, name: "audit", adapterType: "codex_local", adapterConfig: { engine: "cli", sandboxMode: "read-only", dangerouslyBypassApprovalsAndSandbox: false }, runtimeConfig: { safetyPreset: "audit" } }).returning();
    const result = await request(app({ type: "agent", companyId: co.id, agentId: agent!.id, source: "agent_key" })).patch(`/api/agents/${agent!.id}`).send({ runtimeConfig });
    expect(result.status, JSON.stringify(result.body)).toBe(403);
  });
  it("own rollback cannot remove operator-managed audit", async () => {
    const co = await company(); const svc = agentService(db);
    const created = await svc.create(co.id, { name: "old", adapterType: "codex_local" });
    await svc.update(created.id, { title: "snapshot" }, { recordRevision: { createdByUserId: "board" } });
    const revisions = await svc.listConfigRevisions(created.id);
    await svc.update(created.id, { adapterConfig: { engine: "cli", sandboxMode: "read-only" }, runtimeConfig: { safetyPreset: "audit" } });
    const result = await request(app({ type: "agent", companyId: co.id, agentId: created.id, source: "agent_key" })).post(`/api/agents/${created.id}/config-revisions/${revisions[0]!.id}/rollback`).send({});
    expect(result.status, JSON.stringify(result.body)).toBe(403);
  });
});
