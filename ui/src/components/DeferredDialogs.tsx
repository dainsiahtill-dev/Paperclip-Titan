import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { useDialogActions, useDialogState } from "../context/DialogContext";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "./ui/dialog";
import { Button } from "./ui/button";

const NewIssueDialog = lazy(() => import("./NewIssueDialog").then(module => ({ default: module.NewIssueDialog })));
const NewProjectDialog = lazy(() => import("./NewProjectDialog").then(module => ({ default: module.NewProjectDialog })));
const NewGoalDialog = lazy(() => import("./NewGoalDialog").then(module => ({ default: module.NewGoalDialog })));
const NewAgentDialog = lazy(() => import("./NewAgentDialog").then(module => ({ default: module.NewAgentDialog })));

/** Keep a requested dialog mounted after closing: drafts and focus/exit effects survive. */
export function DeferredMount({ open, children }: { open: boolean; children: ReactNode }) {
  const [activated, setActivated] = useState(false);
  useEffect(() => { if (open) setActivated(true); }, [open]);
  return open || activated ? children : null;
}

export function DialogLoading({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} onOpenChange={next => { if (!next) onClose(); }}>
      <DialogContent>
        <DialogTitle>正在加载表单</DialogTitle>
        <DialogDescription role="status">正在准备表单，请稍候。</DialogDescription>
        <Button variant="outline" onClick={onClose}>取消</Button>
      </DialogContent>
    </Dialog>
  );
}

export function DeferredDialogs() {
  const state = useDialogState();
  const actions = useDialogActions();
  return <>
    <DeferredMount open={state.newIssueOpen}><Suspense fallback={<DialogLoading open={state.newIssueOpen} onClose={actions.closeNewIssue} />}><NewIssueDialog /></Suspense></DeferredMount>
    <DeferredMount open={state.newProjectOpen}><Suspense fallback={<DialogLoading open={state.newProjectOpen} onClose={actions.closeNewProject} />}><NewProjectDialog /></Suspense></DeferredMount>
    <DeferredMount open={state.newGoalOpen}><Suspense fallback={<DialogLoading open={state.newGoalOpen} onClose={actions.closeNewGoal} />}><NewGoalDialog /></Suspense></DeferredMount>
    <DeferredMount open={state.newAgentOpen}><Suspense fallback={<DialogLoading open={state.newAgentOpen} onClose={actions.closeNewAgent} />}><NewAgentDialog /></Suspense></DeferredMount>
  </>;
}
