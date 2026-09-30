import { useId } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  agentQuotaFallbackConfigSchema,
  type Agent,
  type AgentQuotaFallbackConfig,
  type QuotaFallbackBackup,
} from "@paperclipai/shared";
import { agentsApi } from "../api/agents";
import { codexReasoningEffortOptions } from "../lib/codex-reasoning-effort";
import { formatDateTime } from "../lib/utils";
import { AiConnectionField } from "./ai-connections/AiConnectionField";
import { Field } from "./agent-config-primitives";
import { Button } from "./ui/button";

const DEFAULT_BACKUP: QuotaFallbackBackup = {
  adapterType: "codex_local",
  model: "gpt-6.1-sol",
  thinkingEffort: "high",
};

const inputClass = "w-full rounded-md border border-border bg-background px-2.5 py-1.5 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

export function AgentQuotaFallbackSettings({ companyId, agent, agentName, value, onChange, concurrencyGroups, environmentId }: {
  companyId?: string;
  agent?: Agent;
  agentName: string;
  value: unknown;
  onChange: (policy: AgentQuotaFallbackConfig) => void;
  concurrencyGroups: string[];
  environmentId?: string;
}) {
  const policy = (value ?? { enabled: false, recoveryEnabled: true, primaryCheckIntervalSec: 900 }) as AgentQuotaFallbackConfig;
  const backup = policy.backup ?? DEFAULT_BACKUP;
  const modelListId = useId();
  const queryClient = useQueryClient();
  const statusKey = ["agents", agent?.id, "quota-fallback", companyId];
  const status = useQuery({
    queryKey: statusKey,
    queryFn: () => agentsApi.quotaFallbackStatus(agent!.id, companyId),
    enabled: Boolean(agent && companyId && (policy.enabled || agent.runtimeConfig.quotaFallback?.enabled)),
    refetchInterval: 15_000,
    retry: false,
  });
  const checkPrimary = useMutation({
    mutationFn: () => agentsApi.checkQuotaFallbackPrimary(agent!.id, companyId),
    onSuccess: (result) => queryClient.setQueryData(statusKey, result),
  });
  const testBackup = useMutation({
    mutationFn: () => agentsApi.testQuotaFallbackBackup(agent!.id, backup, companyId),
  });
  const models = useQuery({
    queryKey: ["quota-fallback-models", companyId, backup.adapterType, environmentId],
    queryFn: () => agentsApi.adapterModels(companyId!, backup.adapterType, { environmentId }),
    enabled: Boolean(companyId && policy.enabled),
    retry: false,
  });
  const validation = agentQuotaFallbackConfigSchema.safeParse(policy);
  function updatePolicy(patch: Partial<AgentQuotaFallbackConfig>) {
    onChange({ ...policy, recoveryEnabled: policy.recoveryEnabled ?? true, primaryCheckIntervalSec: policy.primaryCheckIntervalSec ?? 900, ...patch });
  }
  function updateBackup(patch: Partial<QuotaFallbackBackup>) {
    updatePolicy({ backup: { ...backup, ...patch } });
    testBackup.reset();
  }
  const effortOptions = backup.adapterType === "codex_local"
    ? codexReasoningEffortOptions(backup.model, "Auto").filter((option) => option.value !== "minimal")
    : [{ value: "", label: "Auto" }, ...["low", "medium", "high"].map((effort) => ({ value: effort, label: effort }))];
  const connectionEnabled = Boolean(backup.aiConnection);
  const state = status.data;
  const error = checkPrimary.error ?? testBackup.error ?? status.error ?? models.error;

  return (
    <div className="space-y-3">
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" aria-label="Enable quota fallback" checked={policy.enabled} className="mt-0.5 size-4 accent-primary"
          onChange={(event) => updatePolicy({ enabled: event.target.checked, ...(event.target.checked ? { backup } : {}) })} />
        <span><span className="block font-medium">Enable quota fallback</span><span className="block text-xs text-muted-foreground">Continue with a backup model after the primary provider reports a quota or capacity limit.</span></span>
      </label>
      {policy.enabled && <>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Backup harness">
            <select aria-label="Backup harness" className={inputClass} value={backup.adapterType} onChange={(event) => {
              const adapterType = event.target.value as QuotaFallbackBackup["adapterType"];
              updatePolicy({ backup: adapterType === "codex_local" ? { ...DEFAULT_BACKUP } : { adapterType, model: "sonnet" } });
              testBackup.reset();
            }}>
              <option value="codex_local">Codex CLI</option><option value="claude_local">Claude CLI</option>
            </select>
          </Field>
          <Field label="Backup model" hint="Select a model or enter the exact model ID accepted by the execution machine's CLI.">
            <input aria-label="Backup model ID" list={modelListId} className={`${inputClass} font-mono`} value={backup.model} maxLength={200} autoComplete="off" spellCheck={false}
              onChange={(event) => {
                const model = event.target.value;
                const supported = codexReasoningEffortOptions(model);
                const invalidEffort = backup.adapterType === "codex_local" && backup.thinkingEffort && !supported.some((option) => option.value === backup.thinkingEffort);
                const { thinkingEffort: _effort, ...rest } = backup;
                updatePolicy({ backup: invalidEffort ? { ...rest, model, ...(model.trim() === "gpt-6-luna" ? { thinkingEffort: "xhigh" } : {}) } : { ...backup, model } });
                testBackup.reset();
              }} />
            <datalist id={modelListId}>{(models.data ?? []).map((model) => <option key={model.id} value={model.id}>{model.label}</option>)}</datalist>
          </Field>
          <Field label="Backup thinking effort">
            <select aria-label="Backup thinking effort" className={inputClass} value={backup.thinkingEffort ?? ""} onChange={(event) => {
              const { thinkingEffort: _effort, ...rest } = backup;
              updatePolicy({ backup: event.target.value ? { ...rest, thinkingEffort: event.target.value as QuotaFallbackBackup["thinkingEffort"] } : rest });
              testBackup.reset();
            }}>{effortOptions.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}</select>
          </Field>
          <Field label="Backup concurrency group" hint="Share the configured provider capacity limit with other Agents using this group.">
            <select aria-label="Backup concurrency group" className={inputClass} value={backup.concurrencyGroup ?? ""} onChange={(event) => {
              const { concurrencyGroup: _group, ...rest } = backup;
              updatePolicy({ backup: event.target.value ? { ...rest, concurrencyGroup: event.target.value } : rest });
            }}><option value="">Provider default</option>
              {backup.concurrencyGroup && !concurrencyGroups.includes(backup.concurrencyGroup) && <option value={backup.concurrencyGroup}>{backup.concurrencyGroup} (unconfigured)</option>}
              {concurrencyGroups.map((group) => <option key={group} value={group}>{group}</option>)}
            </select>
          </Field>
        </div>
        {backup.adapterType === "codex_local" && <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label="Backup Fast mode" checked={backup.fastMode === true} className="size-4 accent-primary" onChange={(event) => updateBackup({ fastMode: event.target.checked })} />
          Fast mode <span className="text-xs text-muted-foreground">Uses more credits; requires model support.</span>
        </label>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label="Use a managed backup connection" checked={connectionEnabled} className="size-4 accent-primary" onChange={(event) => {
            if (event.target.checked) {
              updateBackup({ aiConnection: { mode: "responsible_user", provider: backup.adapterType === "codex_local" ? "openai" : "anthropic", method: "subscription" } });
            } else {
              const { aiConnection: _connection, ...rest } = backup;
              updatePolicy({ backup: rest });
              testBackup.reset();
            }
          }} />Use a managed backup connection
        </label>
        {connectionEnabled && companyId ? <AiConnectionField companyId={companyId} agentId={agent?.id} agentName={`${agentName} backup`} adapterType={backup.adapterType} model={backup.model} value={backup.aiConnection} onChange={(aiConnection) => updateBackup({ aiConnection })} environmentId={environmentId} />
          : <p className="text-xs text-muted-foreground">Use the execution machine's CLI login: Codex uses the host account; Claude uses the local Claude/CC-Switch configuration.</p>}
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" aria-label="Automatically return to primary" checked={policy.recoveryEnabled !== false} className="size-4 accent-primary" onChange={(event) => updatePolicy({ recoveryEnabled: event.target.checked })} />Automatically return to primary
        </label>
        {policy.recoveryEnabled !== false && <Field label="Primary check interval (seconds)" hint="Check primary model availability independently of the Agent heartbeat. Between 60 and 86400 seconds.">
          <input aria-label="Primary check interval (seconds)" type="number" min={60} max={86400} step={1} className={inputClass} value={policy.primaryCheckIntervalSec ?? 900} onChange={(event) => updatePolicy({ primaryCheckIntervalSec: Number(event.target.value) })} />
        </Field>}
        {!validation.success && <p role="alert" className="text-xs text-destructive">{validation.error.issues.map((issue) => issue.message).join(". ")}</p>}
        {agent && <div className="flex flex-wrap gap-2">
          <Button type="button" size="sm" variant="outline" disabled={Boolean(environmentId) || testBackup.isPending || !validation.success} onClick={() => testBackup.mutate()}>{testBackup.isPending ? "Testing backup..." : "Test backup connection"}</Button>
          <Button type="button" size="sm" variant="outline" disabled={Boolean(environmentId) || checkPrimary.isPending || state?.checkingPrimary === true || state?.enabled !== true} onClick={() => checkPrimary.mutate()}>{checkPrimary.isPending || state?.checkingPrimary ? "Checking primary..." : "Check primary now"}</Button>
        </div>}
        <p className="text-xs text-muted-foreground">Quota fallback requires a Local CLI environment. Backup tests use these draft settings; primary checks use the saved primary configuration.</p>
        {environmentId && <p role="alert" className="text-xs text-destructive">Choose a Local runtime environment to use quota fallback. Remote environment checks are unavailable.</p>}
        {!agent && <p className="text-xs text-muted-foreground">Save the Agent to test its backup connection and primary availability in its configured environment.</p>}
        {testBackup.data && <div role="status" className="space-y-1 text-xs">
          <p className="font-medium">Backup connection: {testBackup.data.status}</p>
          {testBackup.data.checks.map((check, index) => <p key={`${check.code}-${index}`} className={check.level === "error" ? "text-destructive" : "text-muted-foreground"}>{check.message}</p>)}
        </div>}
      </>}
      {state && <div className="space-y-1 text-xs" aria-live="polite">
        <p aria-label="Next run model" className="font-medium">Next run: {state.usingBackup ? "Backup" : "Primary"} · <span className="font-mono">{state.usingBackup ? state.backupModel ?? state.backupAdapterType : state.primaryModel ?? state.primaryAdapterType}</span></p>
        {state.usingBackup && <p>Backup selected after a primary provider quota or capacity limit{state.lastQuotaAt ? ` at ${formatDateTime(state.lastQuotaAt)}` : ""}.</p>}
        <p>Last primary check: <span className="font-mono">{state.lastPrimaryCheckAt ? formatDateTime(state.lastPrimaryCheckAt) : "Not checked"}</span>{state.lastPrimaryCheckResult ? ` · ${state.lastPrimaryCheckResult}` : ""}</p>
        <p>Next primary check: <span className="font-mono">{state.nextPrimaryCheckAt ? formatDateTime(state.nextPrimaryCheckAt) : "Not scheduled"}</span></p>
        <p className="text-muted-foreground">Status uses your responsible-user connection. Running turns keep their admitted model; recovery selects the primary for the next safe turn.</p>
      </div>}
      {error && <p role="alert" className="text-xs text-destructive">{error instanceof Error ? error.message : "Unable to check quota fallback. Try again."}</p>}
    </div>
  );
}
