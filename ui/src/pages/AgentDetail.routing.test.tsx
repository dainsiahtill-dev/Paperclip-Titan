// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter, Route, Routes, useLocation } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { AgentDetail as AgentDetailRecord, AgentRuntimeState, AgentSkillSnapshot, ResourceMemberships } from "@paperclipai/shared";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TooltipProvider } from "@/components/ui/tooltip";
import type { CurrentBoardAccess } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { AgentDetail } from "./AgentDetail";

const shellActions = vi.hoisted(() => ({
  closePanel: vi.fn(),
  setBreadcrumbs: vi.fn(),
  setSelectedCompanyId: vi.fn(),
  openNewIssue: vi.fn(),
  pushToast: vi.fn(),
}));

// Shell contexts supply the selected company; routing, feature queries, agent
// queries and actions remain their production implementations.
vi.mock("../context/CompanyContext", () => ({
  useCompany: () => ({
    companies: [{ id: "company-1", name: "Paperclip", issuePrefix: "POL" }],
    selectedCompanyId: "company-1",
    selectedCompany: { id: "company-1", name: "Paperclip", issuePrefix: "POL" },
    setSelectedCompanyId: shellActions.setSelectedCompanyId,
  }),
}));
vi.mock("../context/PanelContext", () => ({ usePanel: () => ({ closePanel: shellActions.closePanel }) }));
vi.mock("../context/BreadcrumbContext", () => ({ useBreadcrumbs: () => ({ setBreadcrumbs: shellActions.setBreadcrumbs }) }));
vi.mock("../context/SidebarContext", () => ({ useSidebar: () => ({ isMobile: false }) }));
vi.mock("../context/DialogContext", () => ({ useDialogActions: () => ({ openNewIssue: shellActions.openNewIssue }) }));
vi.mock("../context/ToastContext", () => ({ useToastActions: () => ({ pushToast: shellActions.pushToast }) }));

// eslint-disable-next-line @typescript-eslint/no-explicit-any
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const AGENT_ID = "11111111-1111-4111-8111-111111111111";
const COMPANY_ID = "company-1";

function makeAgent(): AgentDetailRecord {
  return {
    id: AGENT_ID,
    companyId: COMPANY_ID,
    name: "Alpha",
    urlKey: "alpha",
    role: "engineer",
    title: null,
    icon: null,
    status: "error",
    errorReason: "previous_run_failed",
    reportsTo: null,
    capabilities: null,
    adapterType: "codex_local",
    adapterConfig: {},
    runtimeConfig: {},
    budgetMonthlyCents: 0,
    spentMonthlyCents: 0,
    pauseReason: null,
    pausedAt: null,
    permissions: { canCreateAgents: false },
    lastHeartbeatAt: null,
    metadata: null,
    chainOfCommand: [],
    access: { canAssignTasks: true, taskAssignSource: "simple_default", membership: null, grants: [] },
    createdAt: new Date("2026-01-01T00:00:00Z"),
    updatedAt: new Date("2026-01-01T00:00:00Z"),
  };
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
}

function deferredResponse() {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => { resolve = done; });
  return { promise, resolve };
}

function CurrentRoute() {
  const location = useLocation();
  return <output aria-label="Current route">{location.pathname}</output>;
}

async function flushReact() {
  await act(async () => {
    await Promise.resolve();
    await new Promise((resolve) => window.setTimeout(resolve, 0));
  });
}

async function waitFor(assertion: () => void) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 20; attempt++) {
    await flushReact();
    try {
      assertion();
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

describe("AgentDetail legacy channels routing", () => {
  let container: HTMLDivElement;
  let root: Root;
  let queryClient: QueryClient;
  let storedAgent: AgentDetailRecord;
  let settings: ReturnType<typeof deferredResponse>;
  let requests: Array<{ method: string; pathname: string; companyId: string | null }>;
  let unexpectedRequests: string[];

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
    root = createRoot(container);
    queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity }, mutations: { retry: false } },
    });
    storedAgent = makeAgent();
    settings = deferredResponse();
    requests = [];
    unexpectedRequests = [];

    // Fake only HTTP: the real API client, DTO paths, mutation and query-cache
    // invalidation all execute without a server, provider or model call.
    vi.stubGlobal("fetch", vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://localhost");
      const method = init?.method ?? "GET";
      requests.push({ method, pathname: url.pathname, companyId: url.searchParams.get("companyId") });

      if (method === "GET" && url.pathname === "/api/instance/settings/experimental") return settings.promise;
      if (method === "GET" && url.pathname === "/api/cli-auth/me") {
        const access: CurrentBoardAccess = {
          user: null, userId: "local-board", isInstanceAdmin: true, companyIds: [COMPANY_ID],
          memberships: [{ companyId: COMPANY_ID, membershipRole: "owner", status: "active" }],
          source: "local_implicit", keyId: null,
        };
        return jsonResponse(access);
      }
      if (url.searchParams.get("companyId") === COMPANY_ID) {
        if (method === "GET" && ["/api/agents/alpha", `/api/agents/${AGENT_ID}`].includes(url.pathname)) {
          return jsonResponse(storedAgent);
        }
        if (method === "POST" && url.pathname === `/api/agents/${AGENT_ID}/clear-error`) {
          storedAgent = { ...storedAgent, status: "idle", errorReason: null };
          return jsonResponse(storedAgent);
        }
        if (method === "GET" && url.pathname === `/api/agents/${AGENT_ID}/runtime-state`) {
          const state: AgentRuntimeState = {
            agentId: AGENT_ID, companyId: COMPANY_ID, adapterType: "codex_local", sessionId: null,
            stateJson: {}, lastRunId: null, lastRunStatus: null, totalInputTokens: 0, totalOutputTokens: 0,
            totalCachedInputTokens: 0, totalCostCents: 0, lastError: null,
            createdAt: storedAgent.createdAt, updatedAt: storedAgent.updatedAt,
          };
          return jsonResponse(state);
        }
        if (method === "GET" && url.pathname === `/api/agents/${AGENT_ID}/skills`) {
          const snapshot: AgentSkillSnapshot = {
            adapterType: "codex_local", supported: true, mode: "persistent", desiredSkills: [], entries: [], warnings: [],
          };
          return jsonResponse(snapshot);
        }
      }
      if (method === "GET" && url.pathname === `/api/companies/${COMPANY_ID}/resource-memberships/me`) {
        const memberships: ResourceMemberships = {
          projectMemberships: {}, agentMemberships: {}, starredProjectIds: [], starredAgentIds: [],
          starredDocumentIds: [], projectStarredAt: {}, agentStarredAt: {}, documentStarredAt: {}, updatedAt: null,
        };
        return jsonResponse(memberships);
      }
      if (method === "GET" && url.pathname === `/api/companies/${COMPANY_ID}/agents`) return jsonResponse([storedAgent]);
      if (method === "GET" && [
        `/api/companies/${COMPANY_ID}/issues`, `/api/companies/${COMPANY_ID}/heartbeat-runs`,
        `/api/companies/${COMPANY_ID}/skills`, `/api/companies/${COMPANY_ID}/chat-endpoints`,
      ].includes(url.pathname)) return jsonResponse([]);

      unexpectedRequests.push(`${method} ${url.pathname}${url.search}`);
      return jsonResponse({ error: "Unexpected fixture request" }, 500);
    }));
  });

  afterEach(async () => {
    await act(async () => settings.resolve(jsonResponse({ enableChatConnectors: false })));
    await flushReact();
    await act(async () => root.unmount());
    queryClient.clear();
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
  });

  it.each([true, false])("refreshes error actions before settings resolve and preserves feature selection (%s)", async (enableChatConnectors) => {
    await act(async () => root.render(
      <QueryClientProvider client={queryClient}>
        <TooltipProvider>
          <MemoryRouter initialEntries={["/agents/alpha/channels"]}>
            <CurrentRoute />
            <Routes>
              <Route path="/:companyPrefix?/agents/:agentId/:tab" element={<AgentDetail />} />
            </Routes>
          </MemoryRouter>
        </TooltipProvider>
      </QueryClientProvider>,
    ));
    const clearError = () => container.querySelector<HTMLButtonElement>('[aria-label="Clear error and return agent to idle"]');
    await waitFor(() => expect(clearError()).toBeTruthy());
    expect(requests).toContainEqual({ method: "GET", pathname: "/api/agents/alpha", companyId: COMPANY_ID });
    expect(queryClient.getQueryState(queryKeys.instance.experimentalSettings)?.fetchStatus).toBe("fetching");

    await act(async () => clearError()!.click());
    await waitFor(() => expect(storedAgent.status).toBe("idle"));
    expect(requests).toContainEqual({ method: "POST", pathname: `/api/agents/${AGENT_ID}/clear-error`, companyId: COMPANY_ID });
    expect(queryClient.getQueryState(queryKeys.instance.experimentalSettings)?.fetchStatus).toBe("fetching");
    await waitFor(() => {
      expect(clearError()).toBeNull();
      expect(container.querySelector("header")?.textContent).toContain("Pause");
    });
    expect(queryClient.getQueryData<AgentDetailRecord>([...queryKeys.agents.detail(AGENT_ID), COMPANY_ID])?.status).toBe("idle");
    expect(container.querySelector('[aria-label="Current route"]')?.textContent).toBe(`/POL/agents/${AGENT_ID}/channels`);
    expect(queryClient.getQueryState(queryKeys.instance.experimentalSettings)?.fetchStatus).toBe("fetching");

    await act(async () => settings.resolve(jsonResponse({ enableChatConnectors })));
    await waitFor(() => {
      expect(container.querySelector('[aria-label="Current route"]')?.textContent).toBe(
        `/POL/agents/${AGENT_ID}/${enableChatConnectors ? "channels" : "overview"}`,
      );
      expect(container.querySelector("h2")?.textContent).toBe(enableChatConnectors ? "Channels" : "Overview");
    });
    expect(clearError()).toBeNull();
    expect(container.querySelector("header")?.textContent).toContain("Pause");
    expect(unexpectedRequests).toEqual([]);
  });
});
