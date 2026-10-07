import { and, eq, sql } from "drizzle-orm";
import { heartbeatRuns, type Db } from "@paperclipai/db";

/** Server-owned admission evidence. Never infer non-execution from an adapter
 * result marker alone, and never discard actual process/invocation/usage facts. */
export const verifiedPreProviderAdmissionSql = sql`(
  ${heartbeatRuns.runtimeMode} = 'legacy'
  and ${heartbeatRuns.status} in ('failed', 'cancelled') and ${heartbeatRuns.finishedAt} is not null
  and ${heartbeatRuns.processPid} is null and ${heartbeatRuns.processGroupId} is null and ${heartbeatRuns.processStartedAt} is null
  and (${heartbeatRuns.usageJson} is null or ${heartbeatRuns.usageJson} = '{}'::jsonb)
  and not exists (select 1 from heartbeat_run_events invoked
    where invoked.run_id = ${heartbeatRuns.id} and invoked.company_id = ${heartbeatRuns.companyId} and invoked.event_type = 'adapter.invoke')
  and not exists (select 1 from cost_events spent
    where spent.heartbeat_run_id = ${heartbeatRuns.id} and spent.company_id = ${heartbeatRuns.companyId})
  and exists (select 1 from heartbeat_run_events admission
    where admission.run_id = ${heartbeatRuns.id} and admission.company_id = ${heartbeatRuns.companyId}
      and admission.agent_id = ${heartbeatRuns.agentId} and admission.stream = 'system'
      and admission.source_event_id is null and admission.source_instance_id is null and admission.source_seq is null
      and (
        (${heartbeatRuns.startedAt} is null and admission.event_type in ('lifecycle', 'error'))
        or (${heartbeatRuns.status} = 'cancelled' and ${heartbeatRuns.errorCode} = 'workspace_busy'
          and ${heartbeatRuns.resultJson}->'executionRecovery'->>'kind' = 'workspace_wait'
          and ${heartbeatRuns.resultJson}->'executionRecovery'->'providerWorkStarted' = 'false'::jsonb
          and admission.event_type = 'lifecycle'
          and jsonb_typeof(admission.payload->'retryScheduled') = 'boolean'
          and admission.payload->'deferralAttempt' = ${heartbeatRuns.resultJson}->'workspaceBusy'->'deferralAttempt'
          and admission.payload->'projectWorkspaceId' = ${heartbeatRuns.resultJson}->'workspaceBusy'->'projectWorkspaceId')
        or (${heartbeatRuns.errorCode} in ('setup_failed', 'resource_run_deadline')
          and ${heartbeatRuns.executionStage} = 'preparing'
          and ${heartbeatRuns.resultJson}->'executionRecovery'->>'kind' = 'bootstrap'
          and ${heartbeatRuns.resultJson}->'executionRecovery'->'providerWorkStarted' = 'false'::jsonb
          and admission.event_type = 'error' and admission.level = 'error')
      ))
)`;

export async function isVerifiedPreProviderAdmission(db: Pick<Db, "select">, input: { companyId: string; runId: string; agentId?: string }) {
  const [row] = await db.select({ id: heartbeatRuns.id }).from(heartbeatRuns).where(and(
    eq(heartbeatRuns.companyId, input.companyId), eq(heartbeatRuns.id, input.runId),
    input.agentId ? eq(heartbeatRuns.agentId, input.agentId) : undefined, verifiedPreProviderAdmissionSql));
  return Boolean(row);
}
