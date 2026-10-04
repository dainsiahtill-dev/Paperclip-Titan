import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { HeartbeatRun } from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { issuesApi } from "../api/issues";
import { accessApi } from "../api/access";
import { queryKeys } from "../lib/queryKeys";
import { canBoardManageRuntime } from "../lib/recovery-reconcile";
import { Button } from "./ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./ui/dialog";
import { Input } from "./ui/input";
import { Label } from "./ui/label";
import { Textarea } from "./ui/textarea";

/** A board decision about current work; the server owns all source and budget authority. */
export function RunRetrySupersession({ run, onContinued }: { run: HeartbeatRun; onContinued?: (runId: string, agentId: string) => void }) {
  const issueId = typeof run.contextSnapshot?.issueId === "string" ? run.contextSnapshot.issueId : null;
  const eligible = Boolean(issueId && ["failed", "timed_out", "interrupted", "cancelled"].includes(run.status));
  const [open, setOpen] = useState(false);
  const [objective, setObjective] = useState("");
  const [seconds, setSeconds] = useState("");
  const [requestId, setRequestId] = useState(() => crypto.randomUUID());
  const errorRef = useRef<HTMLParagraphElement>(null);
  const client = useQueryClient();
  const task = useQuery({ queryKey: queryKeys.issues.detail(issueId ?? "__none__"), queryFn: () => issuesApi.get(issueId!), enabled: eligible });
  const access = useQuery({ queryKey: queryKeys.access.currentBoardAccess, queryFn: () => accessApi.getCurrentBoardAccess(), enabled: eligible, retry: false });
  const owner = useQuery({ queryKey: queryKeys.agents.detail(task.data?.assigneeAgentId ?? "__none__"),
    queryFn: () => agentsApi.get(task.data!.assigneeAgentId!, run.companyId), enabled: Boolean(eligible && task.data?.assigneeAgentId) });
  const action = task.data?.activeRecoveryAction;
  const held = run.retryDisposition?.state === "blocked" || (action?.cause === "retry_suppressed" && action.evidence.sourceRunId === run.id);
  const revision = task.data?.updatedAt instanceof Date ? task.data.updatedAt.toISOString() : String(task.data?.updatedAt ?? "");
  const budget = Number(seconds);
  const canSubmit = Boolean(task.data?.assigneeAgentId && !["done", "cancelled"].includes(task.data.status) &&
    objective.trim().length >= 20 && seconds.trim() && Number.isSafeInteger(budget) && budget > 0 && budget <= 604800);
  const continuation = useMutation({ mutationFn: async () => {
    const current = task.data!;
    const result = await agentsApi.retryFailedRun(current.assigneeAgentId!, run.id, run.companyId, {
      requestId, expectedIssueRevision: revision, expectedAssigneeAgentId: current.assigneeAgentId!, residualObjective: objective.trim(), maxRunSeconds: budget });
    return { result, agentId: current.assigneeAgentId! };
  }, onSuccess: ({ result, agentId }) => {
    client.invalidateQueries({ queryKey: queryKeys.issues.detail(issueId!) });
    client.invalidateQueries({ queryKey: queryKeys.runDetail(run.id) });
    setOpen(false);
    if (result.runId) onContinued?.(result.runId, agentId);
  } });
  useEffect(() => { if (continuation.isError) errorRef.current?.focus(); }, [continuation.isError]);
  if (!eligible || !held || !canBoardManageRuntime(run.companyId, access.data)) return null;
  return <>
    <Button variant="outline" size="sm" onClick={() => { setOpen(true); task.refetch(); }}>Authorize remaining work</Button>
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogContent>
        <DialogHeader><DialogTitle>Authorize remaining work</DialogTitle>
          <DialogDescription>Review the current task and owner. This creates one new authorized continuation; the stopped run and its spent budget remain recorded.</DialogDescription></DialogHeader>
        <form className="space-y-4" onSubmit={event => { event.preventDefault(); if (canSubmit) continuation.mutate(); }}>
          {continuation.isError && <p role="alert" tabIndex={-1} ref={errorRef} className="text-sm text-destructive">{continuation.error instanceof Error ? continuation.error.message : "Unable to authorize remaining work."}</p>}
          <div className="space-y-2 text-sm">
            <p>{task.data?.title}</p><p className="text-muted-foreground">{task.data?.description}</p>
            <p>Owner: {owner.data?.name ?? task.data?.assigneeAgentId ?? "Unassigned"}</p>
            <p>Status: {task.data?.status}</p>
            <p className="font-mono">Workspace: {task.data?.executionWorkspaceId ?? task.data?.projectWorkspaceId ?? "Task default"}</p>
          </div>
          <div className="space-y-2"><Label htmlFor="retry-residual">Remaining work objective</Label>
            <Textarea id="retry-residual" value={objective} onChange={event => setObjective(event.target.value)} required minLength={20} maxLength={12000} /></div>
          <div className="space-y-2"><Label htmlFor="retry-wall-budget">Additional wall-time budget (seconds)</Label>
            <Input id="retry-wall-budget" type="number" min={1} max={604800} step={1} value={seconds} onChange={event => setSeconds(event.target.value)} required />
            <p className="text-sm text-muted-foreground">Enter a budget explicitly. Existing task, token, company and agent limits still apply.</p></div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => { task.refetch(); setRequestId(crypto.randomUUID()); continuation.reset(); }} disabled={continuation.isPending}>Refresh current task</Button>
            <Button type="submit" disabled={!canSubmit || continuation.isPending || task.isFetching}>{continuation.isPending ? "Authorizing…" : "Authorize and continue"}</Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  </>;
}
