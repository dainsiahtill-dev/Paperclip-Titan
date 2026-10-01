import { sql } from "drizzle-orm";
import { heartbeatRuns } from "@paperclipai/db";

/** Retain provider acknowledgements atomically, including a concurrent final delivery. */
export function preserveQueuedSteeringAcknowledgements(result: Record<string, unknown> | null) {
  const encoded = result === null ? null : JSON.stringify(result);
  return sql<Record<string, unknown> | null>`
    case when ${heartbeatRuns.resultJson} ? 'queuedSteeringAcknowledgements'
      then coalesce(${encoded}::jsonb, '{}'::jsonb) ||
        jsonb_build_object('queuedSteeringAcknowledgements',
        ${heartbeatRuns.resultJson}->'queuedSteeringAcknowledgements')
      else ${encoded}::jsonb end
  `;
}
