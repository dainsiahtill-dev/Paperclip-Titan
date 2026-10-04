import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { eq } from "drizzle-orm";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { agents, companies, connectionGrants, createDb, environments, heartbeatRuns, toolApplications, toolCatalogEntries, toolConnections, toolConnectionInstalls, toolProfiles, toolProfileBindings, toolProfileEntries, toolStdioCommandTemplates } from "@paperclipai/db";
import { createToolGatewayService } from "../services/tool-gateway.js";
import { runAgentBasicPreflight } from "../services/agent-basic-preflight.js";
import * as profileBinding from "../services/agent-preflight-profile.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

const support = await getEmbeddedPostgresTestSupport();
describe.runIf(support.supported && Boolean(process.env.PAPERCLIP_TEST_BWRAP))("saved employee basic checks", () => {
  let database: Awaited<ReturnType<typeof startEmbeddedPostgresTestDatabase>>;
  let db: ReturnType<typeof createDb>;
  let root: string;
  beforeAll(async () => { database = await startEmbeddedPostgresTestDatabase("paperclip-basic-"); db = createDb(database.connectionString); root = await fs.mkdtemp(path.join(os.tmpdir(), "pc-basic-")); }, 20_000);
  afterAll(async () => { await database?.cleanup(); if (root) await fs.rm(root, { recursive: true, force: true }); });
  async function fixture(mode = "ok") {
    const [company] = await db.insert(companies).values({ name: "Checks", issuePrefix: `P${randomUUID().slice(0,6)}` }).returning();
    const cwd = path.join(root, randomUUID()); await fs.mkdir(cwd); await fs.writeFile(path.join(cwd, "source.txt"), "original");
    const [agent] = await db.insert(agents).values({ companyId: company.id, name: "Reader", adapterType: "codex_local", adapterConfig: { cwd, engine: "cli", model: "gpt-6.1-sol", modelReasoningEffort: "high", sandboxMode: "read-only" }, runtimeConfig: { safetyPreset: "audit" } }).returning();
    const [application] = await db.insert(toolApplications).values({ companyId: company.id, applicationKey: randomUUID(), name: "Code tools", type: "mcp_stdio", status: "active" }).returning();
    const key = randomUUID();
    const script = `const fs=require('node:fs'); require('node:readline').createInterface({input:process.stdin}).on('line',line=>{const m=JSON.parse(line);if(!m.id)return; if(m.method==='initialize'){console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,${mode === "initfail" ? "error:{code:-1,message:'secret-canary'}" : "result:{protocolVersion:'2024-11-05',capabilities:{tools:{}},serverInfo:{name:'private',version:'1'}}"}}));return;}let denied=false;try{fs.writeFileSync(${JSON.stringify(path.join(cwd, 'source.txt'))},'bad')}catch{denied=true}console.log(JSON.stringify({jsonrpc:'2.0',id:m.id,result:m.method==='tools/list'?{tools:[{name:'${mode === "missing" ? "different" : "explore"}',inputSchema:{type:'object'}}]}:{content:[{type:'text',text:denied?'write denied':'write allowed'}]}}));});`;
    await db.insert(toolStdioCommandTemplates).values({ companyId: company.id, templateKey: key, name: "Approved fixture", command: process.execPath, args: ["-e", script], envKeys: [], tools: [{ name: "explore", inputSchema: { type: "object" } }] });
    const [connection] = await db.insert(toolConnections).values({ companyId: company.id, applicationId: application.id, uid: randomUUID(), name: "Approved stdio", transport: "local_stdio", status: "active", enabled: true, healthStatus: "ok", credentialPolicy: "shared", config: { templateId: key } }).returning();
    await db.insert(connectionGrants).values({ companyId: company.id, connectionId: connection.id, kind: "organization", isDefault: true, status: "active", credentialSecretRefs: [] });
    await db.insert(toolConnectionInstalls).values({ companyId: company.id, connectionId: connection.id, targetType: "agent", targetId: agent.id });
    const [entry] = await db.insert(toolCatalogEntries).values({ companyId: company.id, applicationId: application.id, connectionId: connection.id, entryKind: "tool", name: "explore", toolName: "explore", status: "active", riskLevel: "read", isReadOnly: true, versionHash: "1", schemaHash: "1" }).returning();
    const [profile] = await db.insert(toolProfiles).values({ companyId: company.id, profileKey: key, name: "Allowed", defaultAction: "deny" }).returning();
    await db.insert(toolProfileBindings).values({ companyId: company.id, profileId: profile.id, targetType: "agent", targetId: agent.id });
    await db.insert(toolProfileEntries).values({ companyId: company.id, profileId: profile.id, selectorType: "catalog_entry", effect: "include", catalogEntryId: entry.id });
    return { company, agent, connection, cwd };
  }
  it("probes real tools/list instead of accepting registered metadata, preserving connection health", async () => {
    for (const mode of ["ok", "initfail", "missing"]) {
      const f = await fixture(mode); const gateway = createToolGatewayService(db);
      const check = await gateway.preflightLocalConnection({ companyId: f.company.id, agentId: f.agent.id, connectionId: f.connection.id, cwd: f.cwd, requiredTools: ["explore"], responsibleUserId: null });
      expect(check.status).toBe(mode === "ok" ? "connected" : "error");
      expect(JSON.stringify(check)).not.toContain("secret-canary");
      expect((await db.select().from(toolConnections).where(eq(toolConnections.id, f.connection.id)))[0]).toEqual(f.connection);
      expect(await fs.readFile(path.join(f.cwd, "source.txt"), "utf8")).toBe("original");
    }
  });
  it("denies foreign or uninstalled connections even when the caller supplies a valid command context", async () => {
    const a = await fixture(); const b = await fixture(); const gateway = createToolGatewayService(db);
    const probe = (connectionId: string) => gateway.preflightLocalConnection({ companyId: a.company.id, agentId: a.agent.id, connectionId, cwd: a.cwd, requiredTools: ["explore"], responsibleUserId: null });
    expect((await probe(b.connection.id)).status).toBe("error");
    await db.delete(toolConnectionInstalls).where(eq(toolConnectionInstalls.connectionId, a.connection.id));
    expect((await probe(a.connection.id)).status).toBe("error");
  });
  it("uses a frozen host profile and cannot turn readOnlyHint into external source write permission", async () => {
    const f = await fixture();
    const runId = randomUUID();
    const [run] = await db.insert(heartbeatRuns).values({ id: runId, companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "running", contextSnapshot: {}, runnerProfileJson: { governedStdioV1: { version: 1, runId, companyId: f.company.id, agentId: f.agent.id, source: "frozen_run", adapterType: "codex_local", cwd: f.cwd, projectId: null, target: "local", sandbox: "read-only", model: "gpt-6.1-sol", effort: "high" } } }).returning();
    const gateway = createToolGatewayService(db); const session = await gateway.createSession({ companyId: f.company.id, agentId: f.agent.id, runId: run.id });
    const tool = (await gateway.listToolsForSession(session.token)).find(tool => tool.connectionId === f.connection.id)!;
    const result = await gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} });
    expect(JSON.stringify(result)).toContain("write denied");
    expect(await fs.readFile(path.join(f.cwd, "source.txt"), "utf8")).toBe("original");
    await db.update(heartbeatRuns).set({ runnerProfileJson: {} }).where(eq(heartbeatRuns.id, run.id));
    await expect(gateway.executeTool({ sessionToken: session.token, tool: tool.name, parameters: {} })).rejects.toMatchObject({ reasonCode: "stdio_profile_unverified" });
  });
  it("compares the saved profile and checks actual skill files without creating project cwd or calling a model", async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.cwd, "skills")); await fs.writeFile(path.join(f.cwd, "skills", "SKILL.md"), "# Review\nCheck facts.");
    const agent = { ...f.agent, runtimeConfig: { ...f.agent.runtimeConfig, readinessRequirements: { skills: [{ workspacePath: "skills/SKILL.md" }], expected: { model: "other-model", cwd: f.cwd }, mcp: [{ connectionId: f.connection.id, requiredTools: ["explore"] }] } } };
    const report = await runAgentBasicPreflight(db, agent, null);
    expect(report.modelInvoked).toBe(false); expect(report.status).toBe("fail");
    expect(report.checks).toEqual(expect.arrayContaining([expect.objectContaining({ code: "expected:model", status: "error" }), expect.objectContaining({ code: "skill:skills/SKILL.md", status: "readable" }), expect.objectContaining({ code: `mcp:${f.connection.id}`, status: "connected" })]));
    expect(report.profileDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(await fs.readdir(f.cwd)).toEqual(["skills", "source.txt"]);
    const missing = path.join(f.cwd, "not-created");
    const missingReport = await runAgentBasicPreflight(db, { ...agent, adapterConfig: { ...agent.adapterConfig, cwd: missing } }, null);
    expect(missingReport.status).toBe("fail"); await expect(fs.stat(missing)).rejects.toThrow();
  });
  it("does not treat a same-named tool as a readable skill or follow skill symlinks outside known roots", async () => {
    const f = await fixture(); await fs.mkdir(path.join(f.cwd, "skills"));
    const outside = path.join(root, "outside-SKILL.md"); await fs.writeFile(outside, "host-canary");
    await fs.symlink(outside, path.join(f.cwd, "skills", "SKILL.md"));
    const report = await runAgentBasicPreflight(db, { ...f.agent, runtimeConfig: { ...f.agent.runtimeConfig, readinessRequirements: { skills: [{ workspacePath: "skills/SKILL.md" }, { key: "explore" }] } } }, null);
    expect(report.checks.filter(check => check.code.startsWith("skill:")).every(check => check.status === "error")).toBe(true);
    expect(JSON.stringify(report)).not.toContain("host-canary");
    await fs.unlink(path.join(f.cwd, "skills", "SKILL.md")); await fs.writeFile(path.join(f.cwd, "skills", "SKILL.md"), "unreadable", { mode: 0 });
    const unreadable = await runAgentBasicPreflight(db, { ...f.agent, runtimeConfig: { ...f.agent.runtimeConfig, readinessRequirements: { skills: [{ workspacePath: "skills/SKILL.md" }] } } }, null);
    expect(unreadable.checks.find(check => check.code.startsWith("skill:"))?.status).toBe("error");
  });
  it("rejects managed raw config overrides before basic probing", async () => {
    const f = await fixture();
    const report = await runAgentBasicPreflight(db, { ...f.agent, adapterConfig: { ...f.agent.adapterConfig, extraArgs: ["-c", "mcp_servers.raw.command=anything"] }, runtimeConfig: { aiConnection: { provider: "openai", mode: "responsible_user" } } }, null);
    expect(report.status).toBe("fail"); expect(report.checks.some(check => check.code === "config_guard" && check.status === "error")).toBe(true);
  });
  it("never probes a remote environment on the host and still reports declared target mismatch", async () => {
    const f = await fixture();
    const [remote] = await db.insert(environments).values({ name: `remote-${randomUUID()}`, driver: "ssh", status: "active", config: { host: "invalid.example" } }).returning();
    const report = await runAgentBasicPreflight(db, { ...f.agent, defaultEnvironmentId: remote.id, runtimeConfig: { readinessRequirements: { interpreters: ["python3"], expected: { target: "local" } } } }, null);
    expect(report.profile.target).toBe("remote");
    expect(report.checks.find(check => check.code === "expected:target")?.status).toBe("error");
    expect(report.checks.some(check => check.code.startsWith("interpreter:"))).toBe(false);
    expect((await db.select().from(environments).where(eq(environments.id, remote.id)))[0]).toEqual(remote);
  });
  it("freezes the host profile once and refuses to repoint an active run to another workspace", async () => {
    const f = await fixture();
    const [run] = await db.insert(heartbeatRuns).values({ companyId: f.company.id, agentId: f.agent.id, invocationSource: "on_demand", status: "running", runnerProfileJson: { unrelatedDescriptor: "preserved" } }).returning();
    const profile = profileBinding.preflightProfile({ adapterType: f.agent.adapterType, config: f.agent.adapterConfig, runtimeConfig: f.agent.runtimeConfig, target: "local", source: "frozen_run" });
    const binding = { runId: run.id, companyId: f.company.id, agentId: f.agent.id, profile };
    await profileBinding.freezeGovernedStdioProfile(db, binding);
    await profileBinding.freezeGovernedStdioProfile(db, binding);
    await expect(profileBinding.freezeGovernedStdioProfile(db, { ...binding, profile: { ...profile, cwd: "/different" } })).rejects.toThrow("profile changed");
    expect((await db.select().from(heartbeatRuns).where(eq(heartbeatRuns.id, run.id)))[0].runnerProfileJson).toMatchObject({ unrelatedDescriptor: "preserved", governedStdioV1: { cwd: f.cwd, runId: run.id } });
  });
  it("keeps public-host restrictions in basic checks without changing connection health", async () => {
    const f = await fixture();
    const host = { deploymentMode: "authenticated" as const, deploymentExposure: "public" as const, trustedLocalStdioRuntimeHost: null };
    const report = await runAgentBasicPreflight(db, { ...f.agent, runtimeConfig: { readinessRequirements: { interpreters: ["python3"] } } }, null, host);
    expect(report.checks.find(check => check.code === "host_policy")?.status).toBe("unverified");
    expect(report.checks.some(check => check.code.startsWith("interpreter:"))).toBe(false);
    const check = await createToolGatewayService(db, host).preflightLocalConnection({ companyId: f.company.id, agentId: f.agent.id, connectionId: f.connection.id, cwd: f.cwd, requiredTools: ["explore"], responsibleUserId: null });
    expect(check.status).toBe("unverified");
  });
});
