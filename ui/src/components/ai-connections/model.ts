import { v3t } from "@/i18n";
/** Redacted presentation contracts shared with the production API. */
import type { AiProvider, AiAuthMethod, AiManagedConnectionSummary, AiConnectionBinding } from "@paperclipai/shared";
export type { AiProvider, AiAuthMethod, AiConnectionBinding } from "@paperclipai/shared";
export type AiConnectionStatus = AiManagedConnectionSummary["status"];

export const AI_PROVIDERS: Record<
  AiProvider,
  { name: string; subscriptionName?: string; logo?: string }
> = {
  anthropic: {
    name: "Claude",
    subscriptionName: v3t("connectionLabels.claudeSubscription"),
    logo: "/brands/claude-color.svg",
  },
  openai: {
    name: "OpenAI",
    subscriptionName: v3t("connectionLabels.chatgptSubscription"),
    logo: "/brands/codex-color.svg",
  },
  openrouter: { name: "OpenRouter", logo: "/brands/apps/openrouter.svg" },
  xai: {
    name: "Grok",
    subscriptionName: v3t("connectionLabels.grokSubscription"),
    logo: "/brands/adapters/grok.svg",
  },
};

export type AiConnectionSummary = Omit<AiManagedConnectionSummary, "isDefault"> & { isDefault?: boolean };

export interface AiConnectionRequirement {
  companyId: string;
  provider: AiProvider;
  method?: AiAuthMethod;
}

export const AI_CONNECTION_STATUS: Record<AiConnectionStatus, string> = {
  connected: v3t("connectionLabels.connected"),
  needs_attention: v3t("connectionLabels.needsAttention"),
  expired: v3t("connectionLabels.expired"),
  revoked: v3t("connectionLabels.revoked"),
};

export function aiMethodLabel(provider: AiProvider, method: AiAuthMethod) {
  return method === "subscription"
    ? (AI_PROVIDERS[provider].subscriptionName ?? v3t("connectionLabels.subscriptionUnavailable"))
    : v3t("connectionLabels.apiKey");
}

export function matchesAiRequirement(
  connection: AiConnectionSummary,
  requirement: AiConnectionRequirement,
) {
  return (
    connection.companyId === requirement.companyId &&
    connection.provider === requirement.provider &&
    (requirement.method === undefined || connection.method === requirement.method)
  );
}

export function personalAiDefault(
  connections: AiConnectionSummary[],
  requirement: AiConnectionRequirement,
  userId: string,
) {
  // Never choose another account because the declared default is unhealthy.
  return connections.find(
    (connection) =>
      matchesAiRequirement(connection, { ...requirement, method: undefined }) &&
      connection.ownership === "personal" &&
      connection.ownerUserId === userId &&
      connection.isDefault,
  );
}

export function aiConnectionProblem(connection?: AiConnectionSummary) {
  if (!connection)
    return v3t("connectionLabels.noConnection");
  return (
    connection.unavailableReason ??
    (connection.status === "connected"
      ? null
      : v3t("connectionLabels.reconnect", { status: AI_CONNECTION_STATUS[connection.status] }))
  );
}

export function bindingProblem(
  binding: AiConnectionBinding,
  requirement: AiConnectionRequirement,
  connections: AiConnectionSummary[],
  userId: string,
  _agentId: string,
) {
  if (
    binding.provider !== requirement.provider ||
    (binding.mode !== "responsible_user" && requirement.method !== undefined && binding.method !== requirement.method)
  )
    return v3t("connectionLabels.compatibleConnection");
  if (binding.mode === "responsible_user")
    return aiConnectionProblem(
      personalAiDefault(connections, requirement, userId),
    );
  const connection = connections.find(
    (item) =>
      item.id === binding.connectionId &&
      item.grantId === binding.grantId &&
      item.method === binding.method &&
      matchesAiRequirement(item, requirement),
  );
  if (!connection)
    return v3t("connectionLabels.connectionUnavailable");
  if (binding.mode === "shared" && connection.ownership !== "shared")
    return v3t("connectionLabels.sharedConnection");
  if (
    binding.mode === "delegated" &&
    (connection.ownership !== "personal" ||
      connection.ownerUserId !== userId)
  )
    return v3t("connectionLabels.credentialUnavailable");
  return aiConnectionProblem(connection);
}
