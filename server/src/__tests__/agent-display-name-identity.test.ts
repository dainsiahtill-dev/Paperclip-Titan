import { randomUUID } from "node:crypto";
import express from "express";
import request from "supertest";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { agents, companies, createDb, invites, joinRequests, issues, heartbeatRuns, routines, companySecrets, companySecretBindings } from "@paperclipai/db";
import { deriveAgentUrlKey } from "@paperclipai/shared";
import { startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";
import { agentService } from "../services/agents.js";
import { agentRoutes } from "../routes/agents.js";
import { errorHandler } from "../middleware/index.js";
import { companyPortabilityService } from "../services/company-portability.js";
import { resolvePortableExportAgentSelection } from "../services/company-portability-agent-selection.js";
import { accessRoutes } from "../routes/access.js";
import { routineService } from "../services/routines.js";
import { secretService } from "../services/secrets.js";

describe("exact agent display names and stable identity", () => {
  let db: ReturnType<typeof createDb>;
  let temporary: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  beforeAll(async () => {
    temporary = await startEmbeddedPostgresTestDatabase("agent-display-name-");
    db = createDb(temporary.connectionString);
  }, 60_000);
  afterAll(async () => { await temporary?.cleanup(); });
  async function company() {
    const nonce = randomUUID().slice(0, 8);
    return (await db.insert(companies).values({ name: nonce, issuePrefix: `N${nonce.toUpperCase()}`, requireBoardApprovalForNewAgents: false }).returning())[0]!;
  }
  function app() {
    const a = express();
    a.use(express.json());
    a.use((req, _res, next) => { req.actor = { type: "board", userId: "local-board", isInstanceAdmin: true, source: "local_implicit" }; next(); });
    a.use("/api", agentRoutes(db));
    a.use("/api", accessRoutes(db, { deploymentMode: "local_trusted", deploymentExposure: "private", bindHost: "127.0.0.1", allowedHostnames: [] }));
    a.use(errorHandler); return a;
  }
  it("persists distinct Chinese display names byte-for-byte through create and hire", async () => {
    const co = await company(); const a = app();
    const names = ["模型与 ContextOS 主管", "ContextOS 与上下文存储工程师"];
    const first = await request(a).post(`/api/companies/${co.id}/agents`).send({ name: names[0], adapterType: "process" });
    const second = await request(a).post(`/api/companies/${co.id}/agent-hires`).send({ name: names[1], adapterType: "process" });
    expect(first.status, JSON.stringify(first.body)).toBe(201);
    expect(second.status, JSON.stringify(second.body)).toBe(201);
    expect(first.body.name).toBe(names[0]); expect(second.body.agent.name).toBe(names[1]);
    const rows = await db.select().from(agents).where(eq(agents.companyId, co.id));
    expect(rows.map(row => row.name).sort()).toEqual([...names].sort());
    for (const agent of [first.body, second.body.agent]) {
      expect(agent.urlKey).toBe(agent.id);
      expect(deriveAgentUrlKey(agent.name, agent.id)).toBe(agent.id);
    }
  });
  it("keeps canonical URLs stable through rename and resolves unique legacy aliases", async () => {
    const co = await company(); const svc = agentService(db);
    const created = await svc.create(co.id, { name: "Legacy Engineer" });
    expect((await svc.resolveByReference(co.id, "legacy-engineer")).agent?.id).toBe(created.id);
    expect(await svc.resolveByReference(co.id, "未知 Legacy Engineer")).toEqual({ agent: null, ambiguous: false });
    const renamed = await svc.update(created.id, { name: "精确的新姓名" });
    expect(renamed).toMatchObject({ id: created.id, name: "精确的新姓名", urlKey: created.id });
    expect((await svc.resolveByReference(co.id, created.urlKey)).agent?.id).toBe(created.id);
    const foreign = await company();
    expect(await svc.resolveByReference(foreign.id, created.id)).toEqual({ agent: null, ambiguous: false });
  });
  it("rejects ambiguous legacy aliases with HTTP409 and keeps UUID access", async () => {
    const co = await company(); const svc = agentService(db); const a = app();
    const one = await svc.create(co.id, { name: "模型与 ContextOS 主管" });
    const two = await svc.create(co.id, { name: "ContextOS 与上下文存储工程师" });
    expect(await svc.resolveByReference(co.id, "contextos")).toEqual({ agent: null, ambiguous: true });
    expect((await request(a).get(`/api/agents/contextos?companyId=${co.id}`)).status).toBe(409);
    expect((await request(a).get(`/api/agents/${one.id}`)).body.id).toBe(one.id);
    expect((await request(a).get(`/api/agents/${two.id}`)).body.id).toBe(two.id);
  });
  it("rejects true duplicates using trim NFC and lowercase while retaining spelling", async () => {
    const co = await company(); const svc = agentService(db);
    const spelling = "  CAFE\u0301 工程师  ";
    const original = await svc.create(co.id, { name: spelling });
    expect(original.name).toBe(spelling);
    const duplicate = await request(app()).post(`/api/companies/${co.id}/agents`).send({ name: "café 工程师" });
    expect(duplicate.status, JSON.stringify(duplicate.body)).toBe(409);
    expect(duplicate.body.code).toBe("agent_name_conflict");
    const other = await svc.create(co.id, { name: "Different" });
    await expect(svc.update(other.id, { name: "CAFÉ 工程师" })).rejects.toMatchObject({ status: 409, details: { code: "agent_name_conflict" } });
    expect((await svc.getById(other.id))?.name).toBe("Different");
    await expect(svc.update(original.id, { name: "café 工程师" })).resolves.toMatchObject({ name: "café 工程师" });
    const foreign = await company();
    await expect(svc.create(foreign.id, { name: "café 工程师" })).resolves.toMatchObject({ name: "café 工程师" });
  });
  it.each(["create/create", "rename/rename", "create/rename"])("serializes concurrent %s duplicate checks", async (scenario) => {
    const co = await company(); const svc = agentService(db);
    const first = await svc.create(co.id, { name: "First" });
    const second = await svc.create(co.id, { name: "Second" });
    const operations = scenario === "create/create"
      ? [() => svc.create(co.id, { name: "并发姓名" }), () => svc.create(co.id, { name: "并发姓名" })]
      : scenario === "rename/rename"
        ? [() => svc.update(first.id, { name: "并发姓名" }), () => svc.update(second.id, { name: "并发姓名" })]
        : [() => svc.create(co.id, { name: "并发姓名" }), () => svc.update(second.id, { name: "并发姓名" })];
    const results = await Promise.allSettled(operations.map(operation => operation()));
    expect(results.filter(result => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find(result => result.status === "rejected")).toMatchObject({ reason: { status: 409, details: { code: "agent_name_conflict" } } });
    const rows = await db.select().from(agents).where(eq(agents.companyId, co.id));
    expect(rows.filter(row => row.name === "并发姓名")).toHaveLength(1);
    expect(rows.some(row => row.name === "并发姓名 2")).toBe(false);
  });
  it("preserves historical suffixes and allows names belonging only to terminated agents", async () => {
    const co = await company(); const svc = agentService(db);
    const historical = await svc.create(co.id, { name: "ContextOS 工程师 2" });
    await svc.create(co.id, { name: "ContextOS 工程师" });
    expect((await svc.getById(historical.id))?.name).toBe("ContextOS 工程师 2");
    const retired = await svc.create(co.id, { name: "Retired" });
    await svc.update(retired.id, { status: "terminated" });
    await expect(svc.create(co.id, { name: "Retired" })).resolves.toMatchObject({ name: "Retired" });
  });
  it.each(["ContextOS 与上下文存储工程师", "  ContextOS 与上下文存储工程师  "])("preserves a distinct Chinese import name even when an explicit rename policy encounters a package slug collision (%s)", async (name) => {
    const co = await company();
    await agentService(db).create(co.id, { name: "模型与 ContextOS 主管" });
    const input = {
      source: { type: "inline" as const, rootPath: "name-fixture", files: {
        "COMPANY.md": '---\nschema: "agentcompanies/v1"\nname: "Name fixture"\n---\n',
        "agents/contextos/AGENTS.md": `---\nname: "${name}"\n---\nExact display fixture.\n`,
        ".paperclip.yaml": 'schema: "paperclip/v1"\nagents:\n  contextos:\n    adapterType: "process"\n',
      } },
      include: { company: false, agents: true, projects: false, issues: false, skills: false },
      target: { mode: "existing_company" as const, companyId: co.id },
      agents: "all" as const, collisionStrategy: "rename" as const,
    };
    const svc = companyPortabilityService(db);
    const preview = await svc.previewImport(input);
    expect(preview.errors).toEqual([]);
    expect(preview.plan.agentPlans[0]?.plannedName).toBe(name);
    const imported = await svc.importBundle(input, "local-board");
    expect(imported.agents[0]?.name).toBe(name);
    expect((await agentService(db).getById(imported.agents[0]!.id))?.name).toBe(name);
    // A second intentional rename handles a genuine human-name collision.
    const second = await svc.importBundle(input, "local-board");
    expect(second.agents[0]?.name).toBe(`${name} 2`);
  });
  it("fails closed when package export selectors use ambiguous legacy aliases", () => {
    const rows = [
      { id: randomUUID(), name: "模型与 ContextOS 主管", status: "idle", metadata: null },
      { id: randomUUID(), name: "ContextOS 与上下文存储工程师", status: "idle", metadata: null },
    ];
    expect(() => resolvePortableExportAgentSelection(rows, ["contextos"], true)).toThrow(/ambiguous/i);
    expect(resolvePortableExportAgentSelection(rows, [rows[0]!.id], true).agents).toEqual([rows[0]]);
  });
  it("approves invites with exact names and leaves duplicate requests pending", async () => {
    const co = await company(); const svc = agentService(db); const a = app();
    await svc.create(co.id, { name: "模型与 ContextOS 主管", role: "ceo", runtimeConfig: { heartbeat: { enabled: false } } });
    async function join(name: string) {
      const [invite] = await db.insert(invites).values({ companyId: co.id, tokenHash: randomUUID(), allowedJoinTypes: "agent", expiresAt: new Date(Date.now() + 60_000) }).returning();
      return (await db.insert(joinRequests).values({ companyId: co.id, inviteId: invite!.id, requestType: "agent", requestIp: "127.0.0.1", agentName: name, adapterType: "process" }).returning())[0]!;
    }
    const exactName = "ContextOS 与上下文存储工程师";
    const pending = await join(exactName);
    const approved = await request(a).post(`/api/companies/${co.id}/join-requests/${pending.id}/approve`).send({});
    expect(approved.status, JSON.stringify(approved.body)).toBe(200);
    expect((await svc.getById(approved.body.createdAgentId))?.name).toBe(exactName);
    const duplicate = await join(exactName);
    const denied = await request(a).post(`/api/companies/${co.id}/join-requests/${duplicate.id}/approve`).send({});
    expect(denied.status, JSON.stringify(denied.body)).toBe(409);
    expect(denied.body.code).toBe("agent_name_conflict");
    expect((await db.select().from(joinRequests).where(eq(joinRequests.id, duplicate.id)))[0]?.status).toBe("pending_approval");
    expect((await svc.list(co.id)).filter(row => row.name === exactName)).toHaveLength(1);
  });
  it("rejects ambiguous existing import assignee aliases before writing an issue", async () => {
    const co = await company(); const svc = agentService(db);
    await svc.create(co.id, { name: "模型与 ContextOS 主管" });
    await svc.create(co.id, { name: "ContextOS 与上下文存储工程师" });
    await expect(companyPortabilityService(db).importBundle({
      source: { type: "inline", rootPath: "alias-fixture", files: {
        "COMPANY.md": '---\nschema: "agentcompanies/v1"\nname: "Alias fixture"\n---\n',
        "tasks/alias-task/TASK.md": '---\nname: "Alias fixture task"\nassignee: "contextos"\n---\nDo not arbitrate employees.\n',
      } },
      include: { company: false, agents: false, projects: false, issues: true, skills: false },
      target: { mode: "existing_company", companyId: co.id },
      collisionStrategy: "rename",
    }, "local-board")).rejects.toMatchObject({ status: 409, details: { code: "agent_reference_ambiguous" } });
    expect(await db.select().from(issues).where(eq(issues.companyId, co.id))).toEqual([]);
  });
  it("keeps reporting, issue, run, routine, secret and scheduler references on the same identity after rename", async () => {
    const co = await company(); const svc = agentService(db);
    const manager = await svc.create(co.id, { name: "Legacy Manager" });
    const child = await svc.create(co.id, { name: "Child", reportsTo: manager.id });
    const [issue] = await db.insert(issues).values({ companyId: co.id, title: "Identity fixture", assigneeAgentId: manager.id }).returning();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: co.id, agentId: manager.id, invocationSource: "on_demand", status: "succeeded" }).returning();
    const [routine] = await db.insert(routines).values({ companyId: co.id, title: "Identity fixture", assigneeAgentId: manager.id, status: "paused" }).returning();
    const [secret] = await db.insert(companySecrets).values({ companyId: co.id, name: "Fixture placeholder", key: "FIXTURE", provider: "local_encrypted", externalRef: "unused" }).returning();
    await db.insert(companySecretBindings).values({ companyId: co.id, secretId: secret!.id, targetType: "agent", targetId: manager.id, configPath: "env.FIXTURE" });
    await svc.update(manager.id, { name: "精确中文主管" });
    expect((await svc.getById(child.id))?.reportsTo).toBe(manager.id);
    expect((await db.select().from(issues).where(eq(issues.id, issue!.id)))[0]?.assigneeAgentId).toBe(manager.id);
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run!.id)))[0]?.agentId).toBe(manager.id);
    expect((await routineService(db).getDetail(routine!.id))?.assignee).toMatchObject({ id: manager.id, name: "精确中文主管", urlKey: manager.id });
    expect((await secretService(db).listBindingReferences(co.id, secret!.id))[0]?.target).toMatchObject({ id: manager.id, href: `/agents/${manager.id}` });
    const scheduler = await request(app()).get("/api/instance/scheduler-heartbeats");
    expect(scheduler.status, JSON.stringify(scheduler.body)).toBe(200);
    expect(scheduler.body.find((row: { id: string }) => row.id === manager.id)).toMatchObject({ id: manager.id, agentName: "精确中文主管", agentUrlKey: manager.id });
  });
});
