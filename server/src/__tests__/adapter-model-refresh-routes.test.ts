import express from "express";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { models as openCodeFallbackModels } from "@paperclipai/adapter-opencode-local";
import { agents, companies, createDb } from "@paperclipai/db";
import type { ServerAdapterModule } from "../adapters/index.js";
import { getEmbeddedPostgresTestSupport, startEmbeddedPostgresTestDatabase } from "./helpers/embedded-postgres.js";

vi.mock("acpx/runtime", () => ({
  createAcpRuntime: vi.fn(),
  createAgentRegistry: vi.fn(),
  createRuntimeStore: vi.fn(),
  isAcpRuntimeError: vi.fn(() => false),
}));

const mockAccessService = vi.hoisted(() => ({
  canUser: vi.fn(),
  hasPermission: vi.fn(),
  ensureMembership: vi.fn(),
  setPrincipalPermission: vi.fn(),
}));

const mockCompanySkillService = vi.hoisted(() => ({
  listRuntimeSkillEntries: vi.fn(),
  resolveRequestedSkillKeys: vi.fn(),
}));

const mockSecretService = vi.hoisted(() => ({
  normalizeAdapterConfigForPersistence: vi.fn(async (_companyId: string, config: Record<string, unknown>) => config),
  resolveAdapterConfigForRuntime: vi.fn(async (_companyId: string, config: Record<string, unknown>) => ({ config })),
}));
const mockEnvironmentService = vi.hoisted(() => ({
  getById: vi.fn(),
}));
const mockListOpenCodeModels = vi.hoisted(() => vi.fn());

const mockAgentInstructionsService = vi.hoisted(() => ({
  materializeManagedBundle: vi.fn(),
  getBundle: vi.fn(),
  readFile: vi.fn(),
  updateBundle: vi.fn(),
  writeFile: vi.fn(),
  deleteFile: vi.fn(),
  exportFiles: vi.fn(),
  ensureManagedBundle: vi.fn(),
}));

const mockBudgetService = vi.hoisted(() => ({
  upsertPolicy: vi.fn(),
}));

const mockHeartbeatService = vi.hoisted(() => ({
  cancelActiveForAgent: vi.fn(),
}));

const mockIssueApprovalService = vi.hoisted(() => ({
  linkManyForApproval: vi.fn(),
}));

const mockApprovalService = vi.hoisted(() => ({
  create: vi.fn(),
  getById: vi.fn(),
}));

const mockInstanceSettingsService = vi.hoisted(() => ({
  getGeneral: vi.fn(async () => ({ censorUsernameInLogs: false })),
}));

const mockLogActivity = vi.hoisted(() => vi.fn());

function registerModuleMocks() {
  vi.doMock("@paperclipai/adapter-opencode-local/server", async () => {
    const actual = await vi.importActual<typeof import("@paperclipai/adapter-opencode-local/server")>("@paperclipai/adapter-opencode-local/server");
    return {
      ...actual,
      listOpenCodeModels: mockListOpenCodeModels,
    };
  });

  vi.doMock("../services/index.js", () => ({
    agentService: () => ({}),
    agentInstructionsService: () => mockAgentInstructionsService,
    accessService: () => mockAccessService,
    approvalService: () => mockApprovalService,
    builtInAgentService: () => ({ ensureCompanyDefaultAgentGrants: vi.fn() }),
    companySkillService: () => mockCompanySkillService,
    budgetService: () => mockBudgetService,
    heartbeatService: () => mockHeartbeatService,
    issueApprovalService: () => mockIssueApprovalService,
    issueService: () => ({}),
    logActivity: mockLogActivity,
    secretService: () => mockSecretService,
    syncInstructionsBundleConfigFromFilePath: vi.fn((_agent, config) => config),
    workspaceOperationService: () => ({}),
  }));

  vi.doMock("../services/instance-settings.js", () => ({
    instanceSettingsService: () => mockInstanceSettingsService,
  }));

  vi.doMock("../services/environments.js", () => ({
    environmentService: () => mockEnvironmentService,
  }));
}

const refreshableAdapterType = "refreshable_adapter_route_test";

async function createApp(db: unknown = {}, companyIds = ["company-1"]) {
  const [{ agentRoutes }, { errorHandler }] = await Promise.all([
    vi.importActual<typeof import("../routes/agents.js")>("../routes/agents.js"),
    vi.importActual<typeof import("../middleware/index.js")>("../middleware/index.js"),
  ]);
  const app = express();
  app.use(express.json());
  app.use((req, _res, next) => {
    (req as any).actor = {
      type: "board",
      userId: "local-board",
      companyIds,
      source: "local_implicit",
      isInstanceAdmin: false,
    };
    next();
  });
  app.use("/api", agentRoutes(db as any));
  app.use(errorHandler);
  return app;
}

async function requestApp(
  app: express.Express,
  buildRequest: (baseUrl: string) => request.Test,
) {
  const { createServer } = await vi.importActual<typeof import("node:http")>("node:http");
  const server = createServer(app);
  try {
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("Expected HTTP server to listen on a TCP port");
    }
    return await buildRequest(`http://127.0.0.1:${address.port}`);
  } finally {
    if (server.listening) {
      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) reject(error);
          else resolve();
        });
      });
    }
  }
}

async function unregisterTestAdapter(type: string) {
  const { unregisterServerAdapter } = await import("../adapters/index.js");
  unregisterServerAdapter(type);
}

describe("adapter model refresh route", () => {
  beforeEach(async () => {
    vi.resetModules();
    vi.doUnmock("../routes/agents.js");
    vi.doUnmock("../routes/authz.js");
    vi.doUnmock("../middleware/index.js");
    registerModuleMocks();
    vi.clearAllMocks();
    mockCompanySkillService.listRuntimeSkillEntries.mockResolvedValue([]);
    mockCompanySkillService.resolveRequestedSkillKeys.mockResolvedValue([]);
    mockAccessService.canUser.mockResolvedValue(true);
    mockAccessService.hasPermission.mockResolvedValue(true);
    mockAccessService.ensureMembership.mockResolvedValue(undefined);
    mockAccessService.setPrincipalPermission.mockResolvedValue(undefined);
    mockLogActivity.mockResolvedValue(undefined);
    mockEnvironmentService.getById.mockReset();
    mockEnvironmentService.getById.mockResolvedValue(null);
    mockListOpenCodeModels.mockReset();
    mockListOpenCodeModels.mockResolvedValue([{ id: "dynamic-opencode-model", label: "dynamic-opencode-model" }]);
    await unregisterTestAdapter(refreshableAdapterType);
  });

  afterEach(async () => {
    await unregisterTestAdapter(refreshableAdapterType);
  });

  it("reuses configured Claude model IDs only within the requesting company", async () => {
    const support = await getEmbeddedPostgresTestSupport();
    if (!support.supported) return;
    const tempDb = await startEmbeddedPostgresTestDatabase("paperclip-claude-company-models-");
    try {
      const db = createDb(tempDb.connectionString);
      const firstCompanyId = randomUUID();
      const secondCompanyId = randomUUID();
      await db.insert(companies).values([
        { id: firstCompanyId, name: "First", issuePrefix: "FST", requireBoardApprovalForNewAgents: false },
        { id: secondCompanyId, name: "Second", issuePrefix: "SND", requireBoardApprovalForNewAgents: false },
      ]);
      await db.insert(agents).values([
        { id: randomUUID(), companyId: firstCompanyId, name: "First Claude", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: { model: "MiniMax-M4-Preview" }, runtimeConfig: {}, permissions: {} },
        { id: randomUUID(), companyId: firstCompanyId, name: "Second Claude", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: { model: "MiniMax-M4-Preview" }, runtimeConfig: {}, permissions: {} },
        { id: randomUUID(), companyId: firstCompanyId, name: "Follow Claude", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: { model: "MiniMax-stale", modelSelection: "claude_config" }, runtimeConfig: {}, permissions: {} },
        { id: randomUUID(), companyId: firstCompanyId, name: "Other adapter", role: "engineer", status: "active", adapterType: "codex_local", adapterConfig: { model: "private-codex-model" }, runtimeConfig: {}, permissions: {} },
        { id: randomUUID(), companyId: secondCompanyId, name: "Second company Claude", role: "engineer", status: "active", adapterType: "claude_local", adapterConfig: { model: "MiniMax-M5-Preview" }, runtimeConfig: {}, permissions: {} },
      ]);
      const app = await createApp(db, [firstCompanyId, secondCompanyId]);
      const first = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/companies/${firstCompanyId}/adapters/claude_local/models`));
      const second = await requestApp(app, (baseUrl) => request(baseUrl).get(`/api/companies/${secondCompanyId}/adapters/claude_local/models`));
      expect(first.status).toBe(200);
      expect(second.status).toBe(200);
      expect(first.body.filter((model: { id: string }) => model.id === "MiniMax-M4-Preview")).toHaveLength(1);
      expect(first.body.some((model: { id: string }) => ["MiniMax-M5-Preview", "MiniMax-stale", "private-codex-model"].includes(model.id))).toBe(false);
      expect(second.body.some((model: { id: string }) => model.id === "MiniMax-M5-Preview")).toBe(true);
      expect(second.body.some((model: { id: string }) => model.id === "MiniMax-M4-Preview")).toBe(false);
    } finally {
      await tempDb.cleanup();
    }
  }, 45_000);

  it("uses refreshModels when refresh=1 is requested", async () => {
    const listModels = vi.fn(async () => [{ id: "stale-model", label: "stale-model" }]);
    const refreshModels = vi.fn(async () => [{ id: "fresh-model", label: "fresh-model" }]);
    const { registerServerAdapter } = await import("../adapters/index.js");
    const adapter: ServerAdapterModule = {
      type: refreshableAdapterType,
      execute: async () => ({ exitCode: 0, signal: null, timedOut: false }),
      testEnvironment: async () => ({
        adapterType: refreshableAdapterType,
        status: "pass",
        checks: [],
        testedAt: new Date(0).toISOString(),
      }),
      listModels,
      refreshModels,
    };
    registerServerAdapter(adapter);

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get(`/api/companies/company-1/adapters/${refreshableAdapterType}/models?refresh=1`),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "fresh-model", label: "fresh-model" }]);
    expect(refreshModels).toHaveBeenCalledTimes(1);
    expect(listModels).not.toHaveBeenCalled();
  });

  it("skips OpenCode model discovery for non-local environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      companyId: "company-1",
      name: "Remote SSH",
      driver: "ssh",
      config: {},
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/adapters/opencode_local/models?environmentId=env-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual(openCodeFallbackModels);
    expect(mockListOpenCodeModels).not.toHaveBeenCalled();
  });

  it("keeps OpenCode model discovery enabled for local environments", async () => {
    mockEnvironmentService.getById.mockResolvedValue({
      id: "env-1",
      companyId: "company-1",
      name: "Local",
      driver: "local",
      config: {},
    });

    const app = await createApp();
    const res = await requestApp(app, (baseUrl) =>
      request(baseUrl).get("/api/companies/company-1/adapters/opencode_local/models?environmentId=env-1"),
    );

    expect(res.status, JSON.stringify(res.body)).toBe(200);
    expect(res.body).toEqual([{ id: "dynamic-opencode-model", label: "dynamic-opencode-model" }]);
    expect(mockListOpenCodeModels).toHaveBeenCalledTimes(1);
  });
});
