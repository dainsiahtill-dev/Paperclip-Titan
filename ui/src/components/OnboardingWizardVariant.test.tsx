// @vitest-environment jsdom

import { MemoryRouter } from "react-router-dom";
import { DialogProvider, useDialogActions } from "../context/DialogContext";
import { flushSync } from "react-dom";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OnboardingWizardVariant } from "./OnboardingWizardVariant";

const mockInstanceSettingsApi = vi.hoisted(() => ({
  getExperimental: vi.fn(),
}));

vi.mock("@/api/instanceSettings", () => ({
  instanceSettingsApi: mockInstanceSettingsApi,
}));

vi.mock("./OnboardingWizard", () => ({
  OnboardingWizard: () => <div data-testid="wizard-capsule" />,
}));

describe("OnboardingWizardVariant (PAP-138)", () => {
  let container: HTMLDivElement;
  let root: Root | null = null;

  function renderVariant() {
    root = createRoot(container);
    flushSync(() => {
      root!.render(<MemoryRouter initialEntries={["/onboarding"]}><DialogProvider><OnboardingWizardVariant /></DialogProvider></MemoryRouter>);
    });
  }

  beforeEach(() => {
    container = document.createElement("div");
    document.body.appendChild(container);
  });

  afterEach(() => {
    flushSync(() => {
      root?.unmount();
    });
    root = null;
    container.remove();
    vi.clearAllMocks();
  });

  it("loads route-driven onboarding without reading the chat flag", async () => {
    mockInstanceSettingsApi.getExperimental.mockResolvedValue({});
    renderVariant();

    await vi.waitFor(() => expect(container.querySelector('[data-testid="wizard-capsule"]')).not.toBeNull());
    expect(mockInstanceSettingsApi.getExperimental).not.toHaveBeenCalled();
  });
  it("leaves the wizard unmounted on an employee route until explicitly requested", async () => {
    function Trigger() { const { openOnboarding } = useDialogActions(); return <button onClick={() => openOnboarding()}>Open onboarding</button>; }
    root = createRoot(container);
    flushSync(() => root!.render(<MemoryRouter initialEntries={["/POL/agents/all"]}><DialogProvider><Trigger /><OnboardingWizardVariant /></DialogProvider></MemoryRouter>));
    expect(container.querySelector('[data-testid="wizard-capsule"]')).toBeNull();
    flushSync(() => container.querySelector("button")!.click());
    await vi.waitFor(() => expect(container.querySelector('[data-testid="wizard-capsule"]')).not.toBeNull());
  });

});
