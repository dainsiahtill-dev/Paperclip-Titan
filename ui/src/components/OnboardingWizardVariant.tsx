import { lazy, Suspense } from "react";
import { useLocation } from "@/lib/router";
import { useCompany } from "../context/CompanyContext";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { isOnboardingPath } from "../lib/onboarding-route";
import { DeferredMount, DialogLoading } from "./DeferredDialogs";

const OnboardingWizard = lazy(() => import("./OnboardingWizard").then(module => ({ default: module.OnboardingWizard })));

/** Route-driven onboarding still resolves company/cloud policy inside the wizard. */
export function OnboardingWizardVariant() {
  const { pathname } = useLocation();
  const { loading: companiesLoading, companyListUnavailable } = useCompany();
  const { onboardingOpen, onboardingRouteDismissed } = useDialogState();
  const { closeOnboarding, setOnboardingRouteDismissed } = useDialogActions();
  const routeReady = !companiesLoading && !companyListUnavailable;
  const open = onboardingOpen || (routeReady && isOnboardingPath(pathname) && !onboardingRouteDismissed);
  return <DeferredMount open={open}>
    <Suspense fallback={<DialogLoading open={open} onClose={() => { closeOnboarding(); setOnboardingRouteDismissed(true); }} />}>
      <OnboardingWizard />
    </Suspense>
  </DeferredMount>;
}
