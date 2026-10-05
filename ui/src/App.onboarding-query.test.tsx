// @vitest-environment jsdom
import { act } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { MemoryRouter, Outlet } from "react-router-dom";
import { expect, it, vi } from "vitest";
import { App } from "./App";
import { DialogProvider } from "./context/DialogContext";
const companyState = vi.hoisted(() => ({ loading: false, unavailable: true, retry: vi.fn() }));
vi.mock("./context/CompanyContext", () => ({ useCompany: () => ({ companies: [], selectedCompany: null, loading: companyState.loading, companyListUnavailable: companyState.unavailable, retryCompanies: companyState.retry }) }));
vi.mock("./hooks/useCloudInstance", () => ({ useCloudInstance: () => null }));
vi.mock("./hooks/useStreamlinedUiEnabled", () => ({ useStreamlinedUiEnabled: () => ({ enabled: true, loaded: true }) }));
vi.mock("./components/CloudAccessGate", () => ({ CloudAccessGate: () => <Outlet /> }));
vi.mock("./components/Layout", () => ({ Layout: () => <Outlet /> }));
vi.mock("./components/Layout.production", () => ({ Layout: () => <Outlet /> }));
vi.mock("./components/OnboardingWizard", () => ({ OnboardingWizard: () => <div data-testid="wizard">Create your first organization</div> }));
it.each(["/onboarding", "/POL/onboarding"])("keeps retry reachable on failed direct %s and opens onboarding after a successful empty answer", async path => {
 companyState.loading=false;companyState.unavailable=true;companyState.retry.mockClear();
 const container=document.createElement("div");document.body.append(container);const root=createRoot(container);
 const render=()=>flushSync(()=>root.render(<MemoryRouter initialEntries={[path]}><DialogProvider><App /></DialogProvider></MemoryRouter>));
 try {
  render();
  // Resolve the mocked heavy module so an active lazy wizard cannot hide behind its pending import.
  await act(async()=>{await import("./components/OnboardingWizard");});
  expect(container.textContent).toContain("无法加载组织");expect(container.querySelector('[data-testid="wizard"]')).toBeNull();
  await act(async()=>container.querySelector("button")!.click());expect(companyState.retry).toHaveBeenCalledTimes(1);
  companyState.unavailable=false;render();await vi.waitFor(()=>expect(container.querySelector('[data-testid="wizard"]')).not.toBeNull());
 }finally{flushSync(()=>root.unmount());container.remove();document.body.innerHTML="";}
});
