import { v3t } from "@/i18n";
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { PatchInstanceGeneralSettings, BackupRetentionPolicy, AgentConcurrencySettings } from "@paperclipai/shared";
import {
  DAILY_RETENTION_PRESETS,
  WEEKLY_RETENTION_PRESETS,
  MONTHLY_RETENTION_PRESETS,
  DEFAULT_BACKUP_RETENTION,
  DEFAULT_AGENT_CONCURRENCY,
} from "@paperclipai/shared";
import { LogOut, SlidersHorizontal } from "lucide-react";
import { healthApi } from "@/api/health";
import { instanceSettingsApi } from "@/api/instanceSettings";
import { ModeBadge } from "@/components/access/ModeBadge";
import { Button } from "../components/ui/button";
import { useBreadcrumbs } from "../context/BreadcrumbContext";
import { queryKeys } from "../lib/queryKeys";
import { ToggleSwitch } from "@/components/ui/toggle-switch";
import { cn } from "../lib/utils";
import { useSignOut } from "@/hooks/useSignOut";

const FEEDBACK_TERMS_URL = import.meta.env.VITE_FEEDBACK_TERMS_URL?.trim() || "https://paperclip.ing/tos";

export function InstanceGeneralSettings({ embedded = false }: { embedded?: boolean }) {
  const { setBreadcrumbs } = useBreadcrumbs();
  const queryClient = useQueryClient();
  const [actionError, setActionError] = useState<string | null>(null);

  const signOutMutation = useSignOut();

  useEffect(() => {
    if (embedded) return;
    setBreadcrumbs([
      { label: v3t("instanceGeneralSettings.settings"), href: "/company/settings" },
      { label: v3t("instanceGeneralSettings.general") },
    ]);
  }, [embedded, setBreadcrumbs]);

  const generalQuery = useQuery({
    queryKey: queryKeys.instance.generalSettings,
    queryFn: () => instanceSettingsApi.getGeneral(),
  });
  const healthQuery = useQuery({
    queryKey: queryKeys.health,
    queryFn: () => healthApi.get(),
    retry: false,
  });

  const updateGeneralMutation = useMutation({
    mutationFn: instanceSettingsApi.updateGeneral,
    onMutate: () => {
      setActionError(null);
      signOutMutation.reset();
    },
    onSuccess: async () => {
      setActionError(null);
      signOutMutation.reset();
      await queryClient.invalidateQueries({ queryKey: queryKeys.instance.generalSettings });
    },
    onError: (error) => {
      setActionError(error instanceof Error ? error.message : "Failed to update general settings.");
    },
  });

  if (generalQuery.isLoading || healthQuery.isLoading) {
    return <div className="text-sm text-muted-foreground">{v3t("instanceGeneralSettings.loading")}</div>;
  }

  if (generalQuery.error) {
    return (
      <div className="text-sm text-destructive">
        {generalQuery.error instanceof Error
          ? generalQuery.error.message
          : v3t("instanceGeneralSettings.failedToLoad")}
      </div>
    );
  }

  const censorUsernameInLogs = generalQuery.data?.censorUsernameInLogs === true;
  const keyboardShortcuts = generalQuery.data?.keyboardShortcuts === true;
  const feedbackDataSharingPreference = generalQuery.data?.feedbackDataSharingPreference ?? "prompt";
  const backupRetention: BackupRetentionPolicy = generalQuery.data?.backupRetention ?? DEFAULT_BACKUP_RETENTION;
  const agentConcurrency = generalQuery.data?.agentConcurrency ?? DEFAULT_AGENT_CONCURRENCY;
  const hiddenSettings = new Set(healthQuery.data?.hiddenSettings ?? []);
  const showDeploymentStatus = !hiddenSettings.has("instance.general.deploymentStatus");
  const showCensorUsernameInLogs = !hiddenSettings.has("instance.general.censorUsernameInLogs");
  const showKeyboardShortcuts = !hiddenSettings.has("instance.general.keyboardShortcuts");
  const showBackupRetention = !hiddenSettings.has("instance.general.backupRetention");
  const showFeedbackDataSharing = !hiddenSettings.has("instance.general.feedbackDataSharingPreference");
  const showSignOut = !hiddenSettings.has("instance.general.signOut");
  const visibleTopics = [
    "agent concurrency",
    ...(showCensorUsernameInLogs ? ["log display"] : []),
    ...(showKeyboardShortcuts ? ["keyboard shortcuts"] : []),
    ...(showBackupRetention ? ["backup retention"] : []),
    ...(showFeedbackDataSharing ? ["data sharing"] : []),
  ];
  const topicSummary = visibleTopics.length > 2
    ? `${visibleTopics.slice(0, -1).join(", ")}, and ${visibleTopics[visibleTopics.length - 1]}`
    : visibleTopics.join(" and ");
  const visibleActionError = signOutMutation.error instanceof Error
    ? signOutMutation.error.message
    : signOutMutation.error
      ? "Failed to sign out."
      : actionError;

  return (
    <div className={embedded ? "space-y-8" : "max-w-4xl space-y-8"}>
      {!embedded ? (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <SlidersHorizontal className="h-5 w-5 text-muted-foreground" />
            <h1 className="text-lg font-semibold">{v3t("instanceGeneralSettings.general")}</h1>
          </div>
          <p className="text-sm text-muted-foreground">
            {v3t("local.configure_instance_wide_preferences_38641f")}
            {visibleTopics.length > 0 ? <> {v3t("local.including_031af5")} {topicSummary}</> : null}.
          </p>
        </div>
      ) : null}

      {visibleActionError && (
        <div className="rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2 text-sm text-destructive">
          {visibleActionError}
        </div>
      )}

      {showDeploymentStatus && (
      <section>
        <div className="space-y-3">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold">{v3t("instanceGeneralSettings.deploymentAndAuth")}</h2>
            <ModeBadge
              deploymentMode={healthQuery.data?.deploymentMode}
              deploymentExposure={healthQuery.data?.deploymentExposure}
            />
          </div>
          <div className="text-sm text-muted-foreground">
            {healthQuery.data?.deploymentMode === "local_trusted"
              ? v3t("instanceGeneralSettings.localTrustedMode")
              : healthQuery.data?.deploymentExposure === "public"
                ? v3t("instanceGeneralSettings.publicMode")
                : v3t("instanceGeneralSettings.privateMode")}
          </div>
          <div className="grid gap-3 md:grid-cols-3">
            <StatusBox
              label={v3t("instanceGeneralSettings.authReadiness")}
              value={healthQuery.data?.authReady ? "Ready" : "Not ready"}
            />
            <StatusBox
              label={v3t("instanceGeneralSettings.bootstrapStatus")}
              value={healthQuery.data?.bootstrapStatus === "bootstrap_pending" ? "Setup required" : "Ready"}
            />
            <StatusBox
              label={v3t("instanceGeneralSettings.bootstrapInvite")}
              value={healthQuery.data?.bootstrapInviteActive ? "Active" : "None"}
            />
          </div>
        </div>
      </section>
      )}

      <AgentConcurrencyControls
        key={JSON.stringify(agentConcurrency)}
        value={agentConcurrency}
        disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
        onSave={(next) => updateGeneralMutation.mutate({ agentConcurrency: next })}
      />

      {showCensorUsernameInLogs && (
      <section>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{v3t("instanceGeneralSettings.censorUsername")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {v3t("instanceGeneralSettings.censorUsernameDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={censorUsernameInLogs}
            onCheckedChange={() => updateGeneralMutation.mutate({ censorUsernameInLogs: !censorUsernameInLogs })}
            disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
            aria-label={v3t("instanceGeneralSettings.toggleUsernameCensoring")}
          />
        </div>
      </section>
      )}

      {showKeyboardShortcuts && (
      <section>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{v3t("instanceGeneralSettings.keyboardShortcuts")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {v3t("instanceGeneralSettings.keyboardShortcutsDescription")}
            </p>
          </div>
          <ToggleSwitch
            checked={keyboardShortcuts}
            onCheckedChange={() => updateGeneralMutation.mutate({ keyboardShortcuts: !keyboardShortcuts })}
            disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
            aria-label={v3t("instanceGeneralSettings.toggleKeyboardShortcuts")}
          />
        </div>
      </section>
      )}

      {showBackupRetention && (
      <section>
        <div className="space-y-5">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{v3t("instanceGeneralSettings.backupRetention")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {v3t("instanceGeneralSettings.backupRetentionDescription")}
            </p>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{v3t("instanceGeneralSettings.daily")}</h3>
            <div className="flex flex-wrap gap-2">
              {DAILY_RETENTION_PRESETS.map((days) => {
                const active = backupRetention.dailyDays === days;
                return (
                  <button
                    key={days}
                    type="button"
                    disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, dailyDays: days },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{days} {v3t("local.days_ab5100")}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{v3t("instanceGeneralSettings.weekly")}</h3>
            <div className="flex flex-wrap gap-2">
              {WEEKLY_RETENTION_PRESETS.map((weeks) => {
                const active = backupRetention.weeklyWeeks === weeks;
                const label = weeks === 1 ? "1 week" : `${weeks} weeks`;
                return (
                  <button
                    key={weeks}
                    type="button"
                    disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, weeklyWeeks: weeks },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="space-y-1.5">
            <h3 className="text-xs font-medium text-muted-foreground uppercase tracking-wide">{v3t("instanceGeneralSettings.monthly")}</h3>
            <div className="flex flex-wrap gap-2">
              {MONTHLY_RETENTION_PRESETS.map((months) => {
                const active = backupRetention.monthlyMonths === months;
                const label = months === 1 ? "1 month" : `${months} months`;
                return (
                  <button
                    key={months}
                    type="button"
                    disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                    className={cn(
                      "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                      active
                        ? "border-foreground bg-accent text-foreground"
                        : "border-border bg-background hover:bg-accent/50",
                    )}
                    onClick={() =>
                      updateGeneralMutation.mutate({
                        backupRetention: { ...backupRetention, monthlyMonths: months },
                      })
                    }
                  >
                    <div className="text-sm font-medium">{label}</div>
                  </button>
                );
              })}
            </div>
          </div>
        </div>
      </section>
      )}

      {showFeedbackDataSharing && (
      <section>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{v3t("instanceGeneralSettings.feedbackSharing")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {v3t("instanceGeneralSettings.feedbackSharingDescription")}
            </p>
            {FEEDBACK_TERMS_URL ? (
              <a
                href={FEEDBACK_TERMS_URL}
                target="_blank"
                rel="noreferrer"
                className="inline-flex text-sm text-muted-foreground underline underline-offset-4 hover:text-foreground"
              >
                {v3t("instanceGeneralSettings.readTerms")}
              </a>
            ) : null}
          </div>
          {feedbackDataSharingPreference === "prompt" ? (
            <div className="rounded-lg bg-accent/20 px-3 py-2 text-sm text-muted-foreground">
              {v3t("instanceGeneralSettings.noDefaultSaved")}
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {[
              {
                value: "allowed",
                label: v3t("instanceGeneralSettings.alwaysAllow"),
                description: "Share voted AI outputs automatically.",
              },
              {
                value: "not_allowed",
                label: v3t("instanceGeneralSettings.dontAllow"),
                description: "Keep voted AI outputs local only.",
              },
            ].map((option) => {
              const active = feedbackDataSharingPreference === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  disabled={updateGeneralMutation.isPending || signOutMutation.isPending}
                  className={cn(
                    "rounded-lg border px-3 py-2 text-left transition-colors disabled:cursor-not-allowed disabled:opacity-60",
                    active
                      ? "border-foreground bg-accent text-foreground"
                      : "border-border bg-background hover:bg-accent/50",
                  )}
                  onClick={() =>
                    updateGeneralMutation.mutate({
                      feedbackDataSharingPreference: option.value as
                        | "allowed"
                        | "not_allowed",
                    })
                  }
                >
                  <div className="text-sm font-medium">{option.label}</div>
                  <div className="text-xs text-muted-foreground">
                    {option.description}
                  </div>
                </button>
              );
            })}
          </div>
          <p className="text-xs text-muted-foreground">
            {v3t("instanceGeneralSettings.devNote1")}{" "}
            <code>feedbackDataSharingPreference</code> {v3t("instanceGeneralSettings.devNote2")}{" "}
            <code>instance_settings.general</code> {v3t("instanceGeneralSettings.devNote3")}{" "}
            <code>"prompt"</code>{v3t("instanceGeneralSettings.devNote4")} <code>"prompt"</code> {v3t("instanceGeneralSettings.devNote5")}
          </p>
        </div>
      </section>

      )}

      {showSignOut && (
      <section>
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1.5">
            <h2 className="text-sm font-semibold">{v3t("instanceGeneralSettings.signOut")}</h2>
            <p className="max-w-2xl text-sm text-muted-foreground">
              {v3t("instanceGeneralSettings.signOutDescription")}
            </p>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={signOutMutation.isPending || updateGeneralMutation.isPending}
            onClick={() => {
              setActionError(null);
              signOutMutation.mutate();
            }}
          >
            <LogOut className="size-4" />
            {signOutMutation.isPending ? v3t("instanceGeneralSettings.signingOut") : v3t("instanceGeneralSettings.signOut")}
          </Button>
        </div>
      </section>
      )}
    </div>
  );
}

function AgentConcurrencyControls({
  value,
  disabled,
  onSave,
}: {
  value: AgentConcurrencySettings;
  disabled: boolean;
  onSave: (next: AgentConcurrencySettings) => void;
}) {
  const [totalDraft, setTotalDraft] = useState(value.maxActiveRuns?.toString() ?? "");
  const [groupDrafts, setGroupDrafts] = useState(
    value.groups.map((group) => ({ name: group.name, limit: String(group.maxActiveRuns) })),
  );
  const [error, setError] = useState<string | null>(null);

  const updateGroup = (index: number, patch: Partial<{ name: string; limit: string }>) => {
    setGroupDrafts((current) => current.map((group, row) => row === index ? { ...group, ...patch } : group));
    setError(null);
  };
  const save = () => {
    const total = totalDraft.trim() === "" ? null : Number(totalDraft);
    if (total !== null && (!Number.isInteger(total) || total < 1 || total > 100)) {
      setError("Instance limit must be a whole number from 1 to 100, or blank for no limit.");
      return;
    }
    const names = new Set<string>();
    const groups: AgentConcurrencySettings["groups"] = [];
    for (const draft of groupDrafts) {
      const name = draft.name.trim();
      const limit = Number(draft.limit);
      if (!/^[a-z][a-z0-9_-]{0,31}$/.test(name) || names.has(name)) {
        setError("Group names must be unique lowercase slugs (letters, digits, _ or -).");
        return;
      }
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) {
        setError("Each group limit must be a whole number from 1 to 50.");
        return;
      }
      names.add(name);
      groups.push({ name, maxActiveRuns: limit });
    }
    setError(null);
    onSave({ maxActiveRuns: total, groups });
  };

  return (
    <section aria-labelledby="agent-capacity-heading" className="space-y-4">
      <div className="space-y-1.5">
        <h2 id="agent-capacity-heading" className="text-sm font-semibold">Agent concurrency</h2>
        <p className="max-w-2xl text-sm text-muted-foreground">
          Set an instance ceiling and shared subscription groups. Extra Agent runs wait in the queue.
          Workspace and task dependencies can reduce actual parallel work below these limits.
        </p>
      </div>
      <label className="block max-w-xs space-y-1.5 text-sm">
        <span className="font-medium">Maximum active Agent runs</span>
        <input
          aria-label="Maximum active Agent runs"
          type="number"
          min={1}
          max={100}
          value={totalDraft}
          onChange={(event) => { setTotalDraft(event.target.value); setError(null); }}
          disabled={disabled}
          placeholder="No instance limit"
          className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground"
        />
      </label>
      <div className="space-y-3">
        <h3 className="text-sm font-medium">Shared subscription groups</h3>
        {groupDrafts.map((group, index) => (
          <div key={index} className="grid gap-3 rounded-lg border border-border p-3 sm:grid-cols-(--grid-provider-concurrency) sm:items-end">
            <label className="space-y-1 text-sm">
              <span className="font-medium">Group name</span>
              <input
                aria-label={`Concurrency group name ${index + 1}`}
                value={group.name}
                onChange={(event) => updateGroup(index, { name: event.target.value })}
                disabled={disabled}
                placeholder="minimax"
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground"
              />
            </label>
            <label className="space-y-1 text-sm">
              <span className="font-medium">Max active</span>
              <input
                aria-label={`Concurrency group limit ${index + 1}`}
                type="number"
                min={1}
                max={50}
                value={group.limit}
                onChange={(event) => updateGroup(index, { limit: event.target.value })}
                disabled={disabled}
                className="w-full rounded-md border border-border bg-background px-3 py-2 text-foreground"
              />
            </label>
            <Button
              type="button"
              variant="outline"
              disabled={disabled}
              aria-label={`Remove concurrency group ${index + 1}`}
              onClick={() => { setGroupDrafts((current) => current.filter((_, row) => row !== index)); setError(null); }}
            >
              Remove
            </Button>
          </div>
        ))}
        <Button
          type="button"
          variant="outline"
          disabled={disabled || groupDrafts.length >= 32}
          onClick={() => setGroupDrafts((current) => [...current, { name: "", limit: "6" }])}
        >
          Add concurrency group
        </Button>
      </div>
      {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
      <Button type="button" disabled={disabled} onClick={save}>Save capacity limits</Button>
    </section>
  );
}

function StatusBox({ label, value }: { label: string; value: string }) {
  return (
    <div className="space-y-1">
      <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{label}</div>
      <div className="text-sm font-medium">{value}</div>
    </div>
  );
}
