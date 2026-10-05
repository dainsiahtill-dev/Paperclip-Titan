// @vitest-environment jsdom
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { App } from "./App";

const loaded = vi.hoisted(() => new Set<string>());
vi.mock("./hooks/useCloudInstance", () => ({ useCloudInstance: () => null }));
const companyState = vi.hoisted(() => ({ unavailable: false, empty: false, retry: vi.fn() }));
vi.mock("./context/DialogContext", () => ({ useDialogActions: () => ({ openOnboarding: vi.fn() }), useDialogState: () => ({ onboardingOpen: false, onboardingRouteDismissed: true }) }));
vi.mock("./pages/SkillStudio", () => { loaded.add("studio"); return { SkillStudio: () => null }; });
vi.mock("./pages/IssueDetail", () => { loaded.add("issue"); return { IssueDetail: () => null }; });
vi.mock("./pages/Agents", () => { loaded.add("agents"); return { Agents: () => <div>Employee roster</div>, AGENT_FILTER_TABS: ["all"] }; });
vi.mock("./components/Layout.production", () => { loaded.add("production layout"); return { Layout: () => <Outlet /> }; });
vi.mock("./components/Layout", () => ({ Layout: () => <Outlet /> }));
vi.mock("./components/OnboardingWizardVariant", () => ({ OnboardingWizardVariant: () => null }));
vi.mock("./components/CloudAccessGate", () => ({ CloudAccessGate: () => <Outlet /> }));
vi.mock("./hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("./context/CompanyContext", () => ({ useCompany: () => ({ companies: companyState.empty ? [] : [{ id: "c", issuePrefix: "POL" }], selectedCompany: companyState.empty ? null : { id: "c", issuePrefix: "POL" }, loading: false, companyListUnavailable: companyState.unavailable, retryCompanies: companyState.retry }) }));

it("loads the employee route without evaluating unrelated pages or the other layout", async () => {
  expect([...loaded]).toEqual([]);
  const container = document.createElement("div"); document.body.append(container);
  const root = createRoot(container);
  try {
    flushSync(() => root.render(<MemoryRouter initialEntries={["/POL/agents/all"]}><App /></MemoryRouter>));
    expect(container.textContent).not.toContain("Employee roster");
    await vi.waitFor(() => expect(container.textContent).toContain("Employee roster"));
    expect([...loaded]).toEqual(["agents"]);
  } finally { flushSync(() => root.unmount()); container.remove(); }
});

it("shows company-request recovery before offering zero-company onboarding", async () => {
 companyState.unavailable=true;companyState.empty=true;
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 const render=() => flushSync(() => root.render(<MemoryRouter initialEntries={["/"]}><App /></MemoryRouter>));
 try {
  render(); await vi.waitFor(() => expect(container.textContent).toContain("无法加载组织"));
  expect(container.textContent).not.toContain("Create your first organization");
  flushSync(() => container.querySelector("button")!.click());expect(companyState.retry).toHaveBeenCalledTimes(1);
  companyState.unavailable=false;render();
  await vi.waitFor(() => expect(container.textContent).toContain("Create your first organization"));
  expect(container.textContent).not.toContain("无法加载组织");
 } finally {flushSync(() => root.unmount());container.remove();companyState.empty=false;companyState.unavailable=false;}
});
