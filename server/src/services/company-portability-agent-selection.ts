import { isUuidLike, normalizeAgentUrlKey } from "@paperclipai/shared";
import { readBuiltInAgentMarker } from "./built-in-agent-metadata.js";
import { conflict, notFound } from "../errors.js";

interface ExportAgentCandidate {
  id: string;
  name: string;
  status: string;
  metadata: unknown;
}

export function resolvePortableExportAgentSelection<T extends ExportAgentCandidate>(
  allAgentRows: T[],
  selectors: string[] | undefined,
  includeAgents: boolean,
): { agents: T[]; warnings: string[] } {
  const warnings: string[] = [];
  const liveAgentRows = allAgentRows.filter((agent) => agent.status !== "terminated");
  const builtInAgentRows = liveAgentRows.filter((agent) => readBuiltInAgentMarker(agent.metadata));
  const portableAgentRows = liveAgentRows.filter((agent) => !readBuiltInAgentMarker(agent.metadata));

  if (includeAgents) {
    const skipped = allAgentRows.length - liveAgentRows.length;
    if (skipped > 0) {
      warnings.push(`Skipped ${skipped} terminated agent${skipped === 1 ? "" : "s"} from export.`);
    }
    if (builtInAgentRows.length > 0) {
      warnings.push(`Skipped ${builtInAgentRows.length} built-in managed agent${builtInAgentRows.length === 1 ? "" : "s"} from export.`);
    }
  }

  const agentById = new Map(liveAgentRows.map((agent) => [
    isUuidLike(agent.id) ? agent.id.toLowerCase() : agent.id,
    agent,
  ]));
  const agentByName = new Map<string, T | null>();
  const agentByAlias = new Map<string, T | null>();
  const addReference = (map: Map<string, T | null>, key: string, agent: T) => {
    const prior = map.get(key);
    map.set(key, map.has(key) && prior?.id !== agent.id ? null : agent);
  };
  for (const agent of liveAgentRows) {
    addReference(agentByName, agent.name, agent);
    const normalizedName = normalizeAgentUrlKey(agent.name);
    if (normalizedName) addReference(agentByAlias, normalizedName, agent);
  }

  const selectedAgents = new Map<string, T>();
  for (const selector of selectors ?? []) {
    const trimmed = selector.trim();
    if (!trimmed) continue;
    let match: T | null | undefined = agentById.get(isUuidLike(trimmed) ? trimmed.toLowerCase() : trimmed);
    if (!match && isUuidLike(trimmed)) {
      throw notFound(`Agent selector '${selector}' was not found.`);
    }
    if (!match) {
      const nameReference = agentByName.has(selector) ? selector : trimmed;
      match = agentByName.get(nameReference);
      if (match === null) {
        throw conflict(`Agent selector '${selector}' is ambiguous; select an agent ID.`, { code: "agent_reference_ambiguous" });
      }
    }
    if (!match) {
      if (/[^\x20-\x7e]/.test(trimmed)) throw notFound(`Agent selector '${selector}' was not found.`);
      const alias = normalizeAgentUrlKey(trimmed);
      match = alias ? agentByAlias.get(alias) : undefined;
      if (match === null) {
        throw conflict(`Agent selector '${selector}' is ambiguous; select an agent ID.`, { code: "agent_reference_ambiguous" });
      }
    }
    if (!match) throw notFound(`Agent selector '${selector}' was not found.`);
    if (readBuiltInAgentMarker(match.metadata)) {
      warnings.push(`Agent selector "${selector}" is a built-in managed agent and was skipped.`);
      continue;
    }
    selectedAgents.set(match.id, match);
  }

  // Only an intentionally empty selector list requests every portable agent.
  if (includeAgents && !(selectors ?? []).some((selector) => selector.trim())) {
    for (const agent of portableAgentRows) selectedAgents.set(agent.id, agent);
  }

  return { agents: Array.from(selectedAgents.values()), warnings };
}
