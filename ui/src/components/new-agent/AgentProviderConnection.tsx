import { v3t } from "@/i18n";
import { healthApi } from "@/api/health";
import { aiConnectionsApi } from "@/api/ai-connections";
import { useLocalAiLogin } from "../ai-connections/useLocalAiLogin";
import type { AiConnectionBinding, AiConnectionLoginIntent } from "@paperclipai/shared";
import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { motion } from "motion/react";
import {
  SavedProviderKeySelect,
  useSavedProviderKeys,
} from "../onboarding/SavedProviderKeySelect";
import { agentsApi } from "@/api/agents";
import { queryKeys } from "@/lib/queryKeys";
import { AdapterLoginPanel } from "../AgentConfigForm";
import {
  LocalProviderLoginInstructions,
  OnboardingCardField,
  OnboardingLoginCard,
} from "../AdapterLoginChrome";
import { ModelSourceTiles } from "../onboarding/ModelSourceTiles";
import { CredentialModeLink } from "../onboarding/CredentialModeLink";
import { FooterNav } from "../onboarding/FooterNav";
import { MAKE_ROOM, CARD_ENTER } from "../onboarding/onboarding-motion";
import { buildFixedClaudeOAuthBinding } from "../environment-variables-editor/model";
import type { EnvBinding } from "@paperclipai/shared";

export type ProviderConnection = {
  env: Record<string, EnvBinding>;
  aiConnection?: AiConnectionBinding;
  /** Kept in memory until the user finishes setup. */
  credentials?: Record<string, string>;
  storedSessionId?: string;
  applyStoredClaudeLogin?: boolean;
};
export function AgentProviderConnection({
  companyId,
  adapterType,
  environmentId,
  canLogin,
  localEnvironment = false,
  onConnected,
  onBack,
  testConnection,
  testError,
  managedAccount,
}: {
  companyId: string;
  adapterType: "claude_local" | "codex_local" | "grok_local";
  environmentId: string | null;
  canLogin: boolean;
  localEnvironment?: boolean;
  onConnected: (connection: ProviderConnection) => void;
  onBack: () => void;
  testConnection: (connection: ProviderConnection) => Promise<boolean>;
  testError?: string | null;
  /** Connections supplies its access intent; presentation and login controllers stay shared. */
  managedAccount?: {
    intent: AiConnectionLoginIntent;
    initialMethod?: "subscription" | "api_key";
    fixedMethod?: boolean;
    disabled?: boolean;
    onComplete: (result: { connectionId: string; grantId: string; method: "subscription" | "api_key" }) => void;
  };
}) {
  const health = useQuery({ queryKey: queryKeys.health, queryFn: healthApi.get, enabled: localEnvironment });
  const canUseLocalLogin = localEnvironment && (health.data?.localAiLoginSupported ?? health.data?.deploymentMode === "local_trusted");
  const epoch = useRef(0);
  useEffect(
    () => () => {
      epoch.current++;
    },
    [],
  );
  const cancel = () => {
    epoch.current++;
    setBusy(false);
    setOpened(false);
    setAuthorizationUrl(null);
    setLoginPhase("preparing");
  };
  const [methodChoice, setMethod] = useState<"subscription" | "api" | null>(managedAccount?.initialMethod === "api_key" ? "api" : managedAccount ? "subscription" : null);
  const [opened, setOpened] = useState(false);
  const [authorizationUrl, setAuthorizationUrl] = useState<string | null>(null);
  const [loginPhase, setLoginPhase] = useState<"preparing" | "ready" | "waiting" | "connecting">("preparing");
  const phaseBeforeSubmit = useRef<"ready" | "waiting">("ready");
  const [apiKey, setApiKey] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [storedConnection, setStoredConnection] =
    useState<ProviderConnection | null>(null);
  const provider = adapterType === "claude_local" ? "Claude" : adapterType === "grok_local" ? "Grok" : "OpenAI";
  const envKey =
    adapterType === "claude_local" ? "ANTHROPIC_API_KEY" : adapterType === "grok_local" ? "XAI_API_KEY" : "OPENAI_API_KEY";
  const aiProvider = adapterType === "claude_local" ? "anthropic" : adapterType === "grok_local" ? "xai" : "openai";
  const availableKeys = useSavedProviderKeys(companyId, envKey);
  // Add/reconnect creates the requested account, never copies a saved account's
  // credential or silently changes its ownership. Agent setup retains reuse.
  const savedKeys = managedAccount
    ? { ...availableKeys, options: [], subscriptions: [], loading: false }
    : availableKeys;
  const [subscriptionId, setSubscriptionId] = useState<string | null>(null);
  const savedSubscription =
    savedKeys.subscriptions.length
      ? savedKeys.subscriptions.find(
          (option) =>
            option.id === (subscriptionId ?? savedKeys.subscriptions[0]?.id),
        )
      : undefined;
  const [selectedKeyId, setSelectedKeyId] = useState<string | null>(null);
  const selectedKey = savedKeys.options.find(
    (option) => option.id === (selectedKeyId ?? savedKeys.options[0]?.id),
  );
  const storedLogin = managedAccount
    ? { ...savedKeys.storedLogin, data: undefined, isPending: false, isError: false }
    : savedKeys.storedLogin;
  const savedManagedAccount = useRef<{ connectionId: string; grantId: string } | null>(null);
  const method = methodChoice ?? (
    (savedKeys.subscriptions.length > 0 || (adapterType === "claude_local" && !savedSubscription && storedLogin.data))
      ? "subscription" : savedKeys.options.length ? "api" : "subscription"
  );
  const localLogin = useLocalAiLogin(companyId, managedAccount?.intent ?? {
    provider: aiProvider, method: "subscription", name: `My ${provider} subscription`,
    ownership: "personal", agentIds: [], allAgents: true,
  }, canUseLocalLogin && method === "subscription" && !savedSubscription && !storedLogin.data,
  { allowHostClaude: health.data?.deploymentMode === "local_trusted" });
  const auth = useQuery({
    queryKey: queryKeys.agents.authSignal(
      companyId,
      adapterType,
      environmentId,
    ),
    queryFn: () =>
      agentsApi.getAdapterAuthSignal(
        companyId,
        adapterType,
        environmentId ?? undefined,
      ),
    retry: false,
    enabled: !managedAccount,
  });
  async function connect() {
    if (busy || managedAccount?.disabled) return;
    const run = ++epoch.current;
    setBusy(true);
    setError(null);
    try {
      if (managedAccount) {
        if (method === "subscription" && !canUseLocalLogin) return;
        const result = savedManagedAccount.current ?? await (method === "api"
          ? aiConnectionsApi.create(companyId, { ...managedAccount.intent, method: "api_key", apiKey: apiKey.trim() })
          : localLogin.connect(managedAccount.intent));
        savedManagedAccount.current = result;
        setApiKey("");
        if (run === epoch.current) managedAccount.onComplete({ ...result, method: method === "api" ? "api_key" : "subscription" });
        return;
      }
      let connection: ProviderConnection =
        method === "api"
          ? selectedKey
            ? selectedKey.aiConnection ? { env: {}, aiConnection: selectedKey.aiConnection } : { env: { [envKey]: selectedKey.binding } }
            : (storedConnection ?? {
                env: {},
                credentials: { [envKey]: apiKey.trim() },
              })
          : {
              ...(savedSubscription?.aiConnection ? { aiConnection: savedSubscription.aiConnection } : {}),
              env: savedSubscription?.binding
                ? { CODEX_HOME: savedSubscription.binding }
                : {},
              ...(adapterType === "claude_local" && !savedSubscription && storedLogin.data
                ? {
                    env: buildFixedClaudeOAuthBinding(),
                    applyStoredClaudeLogin: true,
                  }
                : {}),
            };
      if (method === "subscription" && canUseLocalLogin && !savedSubscription && !storedLogin.data) {
        savedManagedAccount.current ??= await localLogin.connect();
        connection = { env: {}, aiConnection: { provider: aiProvider, method: "subscription", mode: "responsible_user" } };
      }
      if (connection.credentials) {
        await aiConnectionsApi.create(companyId, { provider: aiProvider, method: "api_key", name: `My ${provider} API`, ownership: "personal", apiKey: connection.credentials[envKey], agentIds: [], allAgents: true });
        connection = { env: {}, aiConnection: { provider: aiProvider, method: "api_key", mode: "responsible_user" } };
      }
      if (run !== epoch.current) return;
      if (method === "api") {
        setApiKey("");
        if (!selectedKey) setStoredConnection(connection);
      }
      const connected = await testConnection(connection);
      if (run !== epoch.current) return;
      if (connected) onConnected(connection);
      else
        setError(
          "The provider did not respond. Check the connection and try again.",
        );
    } catch (cause) {
      if (run !== epoch.current) return;
      if (managedAccount) setApiKey("");
      setError(
        cause instanceof Error
          ? cause.message
          : "Could not connect to the provider.",
      );
    } finally {
      if (run === epoch.current) setBusy(false);
    }
  }
  const needsLogin =
    method === "subscription" &&
    canLogin &&
    environmentId &&
    !savedSubscription &&
    !savedKeys.loading &&
    !storedLogin.data &&
    (Boolean(managedAccount) || auth.data?.status !== "present" || subscriptionId === "");
  return (
    <div className="min-w-0 max-w-full">
      <ModelSourceTiles
        label={v3t("local.connect_your_model_provider_763f7f")}
        sources={[
          {
            id: adapterType,
            label: provider,
            icon: (
              <img
                src={adapterType === "grok_local" ? "/brands/adapters/grok.svg" : `/brands/${adapterType === "claude_local" ? "claude" : "codex"}-color.svg`}
                className="size-6"
                alt=""
              />
            ),
          },
        ]}
        mode={method}
        selectedId={opened ? adapterType : null}
        collapsed={opened}
        onSelect={() => { if (!managedAccount?.disabled) setOpened(true); }}
      />
      {!opened && !managedAccount?.fixedMethod && (
        <div className="-ml-3 mt-1">
          <CredentialModeLink
            mode={method}
            onChange={(next) => {
              savedManagedAccount.current = null;
              setMethod(next);
              setError(null);
            }}
          />
        </div>
      )}
      {!opened && savedKeys.options.length > 0 && (
        <p className="mt-2 text-sm text-muted-foreground">
          {savedKeys.options.length} {v3t("local.saved_api_b9bbaf")}{" "}
          {savedKeys.options.length === 1 ? v3t("local.key_available_39a65b") : v3t("local.keys_available_2f1061")}.
        </p>
      )}
      {method === "subscription" &&
        savedKeys.subscriptions.length > 0 && (
          <SavedProviderKeySelect
            options={savedKeys.subscriptions}
            value={savedSubscription?.id ?? ""}
            onChange={setSubscriptionId}
            loading={false}
            error={false}
            kind="subscription"
            disabled={busy}
          />
        )}
      <motion.div
        initial={false}
        animate={{ height: opened ? "auto" : 0, opacity: opened ? 1 : 0 }}
        transition={{ height: MAKE_ROOM, opacity: CARD_ENTER }}
        className="overflow-hidden"
      >
        {opened && (
          <div className="pt-5">
            {method === "api" ? (
              <OnboardingLoginCard
                instruction={
                  savedKeys.options.length
                    ? v3t("dynamic.chooseSavedKey")
                    : v3t("dynamic.providerKey", { provider })
                }
              >
                <SavedProviderKeySelect
                  {...savedKeys}
                  value={selectedKey?.id ?? ""}
                  disabled={busy}
                  onChange={(id) => {
                    setSelectedKeyId(id);
                    setApiKey("");
                    setStoredConnection(null);
                    setError(null);
                  }}
                />
                {!selectedKey && (
                  <OnboardingCardField
                    label={v3t("local.api_key_16f0ee")}
                    masked
                    autoFocus
                    value={apiKey}
                    placeholder={
                      storedConnection
                        ? v3t("local.key_entered_retry_the_connection_43912a")
                        : v3t("local.enter_api_key_here_c80c3a")
                    }
                    onChange={(value) => {
                      setSelectedKeyId("");
                      setApiKey(value);
                      setStoredConnection(null);
                    }}
                    onSubmit={() => void connect()}
                    disabled={busy}
                  />
                )}
              </OnboardingLoginCard>
            ) : needsLogin ? (
              <AdapterLoginPanel
                companyId={companyId}
                adapterType={adapterType}
                environmentId={environmentId}
                chrome="onboarding"
                aiConnection={managedAccount?.intent ?? { provider: aiProvider, method: "subscription", name: `My ${provider} subscription`, ownership: "personal", agentIds: [], allAgents: true }}
                autoStart
                onStored={() => {}}
                onPromptReady={(url) => {
                  setAuthorizationUrl(url);
                  setLoginPhase((phase) => url ? (phase === "preparing" ? "ready" : phase) : "preparing");
                }}
                onCodeSubmitted={() => {
                  phaseBeforeSubmit.current = loginPhase === "waiting" ? "waiting" : "ready";
                  setLoginPhase("connecting");
                }}
                onSubmitFailed={() => {
                  setLoginPhase((phase) => phase === "connecting" ? phaseBeforeSubmit.current : phase);
                }}
                onConnected={(sessionId) => {
                  if (managedAccount) {
                    if (!sessionId) { setError("The login did not return a saved connection. Try again."); return; }
                    const run = epoch.current;
                    setLoginPhase("connecting");
                    void aiConnectionsApi.loginResult(companyId, sessionId).then((result) => {
                      if (run === epoch.current) managedAccount.onComplete({ ...result, method: "subscription" });
                    }).catch(() => {
                      if (run !== epoch.current) return;
                      setLoginPhase("ready");
                      setError("Could not retrieve the saved connection. Go back and retry.");
                    });
                    return;
                  }
                  const connection: ProviderConnection = { env: {}, aiConnection: { provider: aiProvider, method: "subscription", mode: "responsible_user" } };
                  setStoredConnection(connection);
                  onConnected(connection);
                }}
              />
            ) : savedSubscription ? null : canUseLocalLogin && !storedLogin.data ? (
              <LocalProviderLoginInstructions adapterType={adapterType} login={{ ...localLogin, retry: () => { setError(null); localLogin.retry(); } }} />
            ) : (
              <p className="text-sm text-muted-foreground">
                {storedLogin.data
                  ? v3t("local.use_your_saved_claude_subscription_for_this_agent_bb2c11")
                  : canLogin
                    ? v3t("local.use_the_existing_provider_connection_for_this_environmen_c910c4")
                    : v3t("local.this_environment_does_not_support_browser_sign_in_choose_b62e1e")}
              </p>
            )}
          </div>
        )}
      </motion.div>
      {method === "subscription" && storedLogin.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {v3t("local.could_not_check_your_saved_claude_subscription_try_again_c8c6c2")}
        </p>
      )}
      {error && (
        <p role="alert" className="mt-4 text-sm text-destructive">
          {testError ?? error}
        </p>
      )}
      {localEnvironment && health.isError && (
        <p role="alert" className="mt-4 text-sm text-destructive">{v3t("local.could_not_prepare_sign_in_reload_this_page_to_try_again_f89460")}</p>
      )}
      <FooterNav
        onBack={() => {
          if (opened) cancel();
          else onBack();
        }}
        primaryLabel={
          opened && needsLogin
            ? loginPhase === "waiting" ? v3t("dynamic.waitingForCode")
              : loginPhase === "connecting" ? v3t("dynamic.connecting")
              : v3t("dynamic.signInProvider", { provider })
            : busy
            ? v3t("dynamic.connecting")
            : method === "subscription" &&
                (storedLogin.data || savedSubscription)
              ? v3t("connectionLabels.useSavedSubscription")
              : method === "api" && selectedKey
                ? v3t("connectionLabels.useSavedApiKey")
                : v3t("local.connect_1a2303")
        }
        primaryDisabled={
          managedAccount?.disabled ||
          (Boolean(managedAccount) && method === "subscription" && !canLogin && !canUseLocalLogin) ||
          (localEnvironment && health.isPending) || localLogin.preparing || Boolean(localLogin.error) ||
          (!managedAccount && auth.isPending) ||
          savedKeys.loading ||
          (adapterType === "claude_local" && storedLogin.isPending) ||
          !opened ||
          (Boolean(needsLogin) && (!authorizationUrl || loginPhase !== "ready")) ||
          (method === "api" &&
            !apiKey.trim() &&
            !storedConnection &&
            !selectedKey)
        }
        loading={busy}
        primaryIcon={opened && needsLogin ? loginPhase === "ready" ? "none" : "spinner" : undefined}
        onPrimary={() => {
          if (needsLogin) {
            if (!authorizationUrl || loginPhase !== "ready") return;
            window.open(authorizationUrl, "_blank", "noreferrer,noopener");
            setLoginPhase("waiting");
          } else void connect();
        }}
      />
    </div>
  );
}
