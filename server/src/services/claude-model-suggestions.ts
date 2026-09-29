import { and, eq, sql } from "drizzle-orm";
import { agents, type Db } from "@paperclipai/db";
import type { AdapterModel } from "@paperclipai/adapter-utils";

/** Add reusable Claude model IDs without reading or returning agent credentials. */
export async function withCompanyClaudeModelSuggestions(
  db: Db,
  companyId: string,
  discovered: AdapterModel[],
): Promise<AdapterModel[]> {
  const rows = await db
    .selectDistinct({
      model: sql<string | null>`${agents.adapterConfig} ->> 'model'`,
      modelSelection: sql<string | null>`${agents.adapterConfig} ->> 'modelSelection'`,
    })
    .from(agents)
    .where(and(eq(agents.companyId, companyId), eq(agents.adapterType, "claude_local")));

  const seen = new Set(discovered.map((model) => model.id));
  const configured = rows
    .filter((row) => row.modelSelection !== "claude_config")
    .map((row) => row.model?.trim() ?? "")
    .filter((id) => id.length > 0 && id.length <= 200 && !/[\x00-\x1f\x7f]/.test(id))
    .sort((a, b) => a.localeCompare(b));
  const suggestions: AdapterModel[] = [];
  for (const id of configured) {
    if (seen.has(id)) continue;
    seen.add(id);
    suggestions.push({ id, label: `${id} (configured)` });
  }
  return [...discovered, ...suggestions];
}
