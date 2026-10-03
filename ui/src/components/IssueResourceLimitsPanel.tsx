import { useEffect, useId, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { Issue } from "@paperclipai/shared";
import { issueResourceLimitsSchema, type IssueResourceLimits } from "@paperclipai/shared/validators/issue-resources";
import { issuesApi } from "../api/issues";
import { Button } from "./ui/button";
import { Input } from "./ui/input";

const fields = [
  ["maxTokensPerIssue", "Task and subtasks tokens"], ["maxTokensPerRun", "Reported tokens per run"],
  ["maxAutomaticRuns", "Automatic runs"], ["maxNoProgressRuns", "Runs without progress"],
  ["maxRunSeconds", "Run wall time (seconds)"],
] as const;
export function IssueResourceLimitsPanel({ issue }: { issue: Issue }) {
  const prefix = useId();
  const queryClient = useQueryClient();
  const existing = issue.executionPolicy?.resourceLimits;
  const [draft, setDraft] = useState<Record<string, string>>({});
  useEffect(() => { setDraft(Object.fromEntries(fields.map(([key]) => [key, existing?.[key] == null ? "" : String(existing[key])]))); }, [existing]);
  const candidate = Object.fromEntries(fields.map(([key]) => [key, draft[key]?.trim() ? Number(draft[key]) : null]));
  const parsed = issueResourceLimitsSchema.safeParse(candidate);
  const save = useMutation({
    mutationFn: (limits: IssueResourceLimits) => issuesApi.update(issue.id, { executionPolicy: {
      mode: "normal", commentRequired: true, stages: [], ...issue.executionPolicy, resourceLimits: limits,
    } }),
    onSuccess: () => queryClient.invalidateQueries({ predicate: (query) => {
      const data = query.state.data;
      return Boolean(data && typeof data === "object" && !Array.isArray(data) && (data as { id?: string }).id === issue.id);
    } }),
  });
  return <details className="space-y-3">
    <summary className="cursor-pointer text-sm font-medium">Resource limits</summary>
    <p className="text-xs text-muted-foreground">Leave a limit blank to disable it. Ancestor task limits also apply. Token limits are checked when usage is reported; use wall time to bound a running provider.</p>
    <div className="grid gap-3">
      {fields.map(([key, label]) => <div key={key} className="space-y-2">
        <label htmlFor={`${prefix}-${key}`} className="text-sm">{label}</label>
        <Input id={`${prefix}-${key}`} inputMode="numeric" value={draft[key] ?? ""} onChange={(event) => setDraft((value) => ({ ...value, [key]: event.target.value }))} />
      </div>)}
    </div>
    <Button disabled={!parsed.success || save.isPending} onClick={() => { if (parsed.success) save.mutate(parsed.data); }}>{save.isPending ? "Saving..." : "Save resource limits"}</Button>
    {!parsed.success && <p role="alert" className="text-xs text-destructive">Enter positive whole numbers, or leave a limit blank.</p>}
    {save.error && <p role="alert" className="text-xs text-destructive">{save.error instanceof Error ? save.error.message : "Could not save resource limits."}</p>}
    {save.isSuccess && <p role="status" className="text-xs text-muted-foreground">Resource limits saved.</p>}
  </details>;
}
