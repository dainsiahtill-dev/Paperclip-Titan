import { sql } from 'drizzle-orm';
import { check, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';
import { companies } from './companies.js';
import { issues } from './issues.js';
import { issueComments } from './issue_comments.js';
import { heartbeatRuns } from './heartbeat_runs.js';
import { agentWakeupRequests } from './agent_wakeup_requests.js';

/** Content-free receipts. Wake requests schedule; comments retain text/authorship. */
export const issueCommentDeliveries = pgTable('issue_comment_deliveries', {
  id: uuid('id').primaryKey().defaultRandom(),
  companyId: uuid('company_id').notNull().references(() => companies.id, { onDelete: 'cascade' }),
  issueId: uuid('issue_id').notNull().references(() => issues.id, { onDelete: 'cascade' }),
  commentId: uuid('comment_id').notNull().references(() => issueComments.id, { onDelete: 'cascade' }),
  queueId: uuid('queue_id').notNull().references(() => agentWakeupRequests.id, { onDelete: 'cascade' }),
  targetRunId: uuid('target_run_id').references(() => heartbeatRuns.id, { onDelete: 'set null' }),
  targetTurnId: text('target_turn_id'),
  targetSessionId: text('target_session_id'),
  sessionGeneration: integer('session_generation').notNull(),
  controllerId: text('controller_id').notNull(),
  controllerBootId: uuid('controller_boot_id'),
  commentVersion: timestamp('comment_version', { withTimezone: true }).notNull(),
  payloadSha256: text('payload_sha256').notNull(),
  queueRevision: text('queue_revision').notNull(),
  correlationId: text('correlation_id').notNull(),
  deliveryMode: text('delivery_mode').notNull(),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').notNull().default(0),
  activityActorType: text('activity_actor_type').notNull(),
  activityActorId: text('activity_actor_id').notNull(),
  activityAgentApiKeyId: uuid('activity_agent_api_key_id'),
  lastErrorCode: text('last_error_code'),
  dispatchedAt: timestamp('dispatched_at', { withTimezone: true }),
  acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  correlationUq: uniqueIndex('issue_comment_deliveries_correlation_uq').on(table.correlationId),
  runCommentIdx: index('issue_comment_deliveries_run_comment_idx').on(table.companyId, table.targetRunId, table.commentId),
  statusCheck: check('issue_comment_deliveries_status_check', sql`${table.status} IN ('pending', 'dispatching', 'acknowledged', 'uncertain', 'superseded', 'cancelled')`),
  modeCheck: check('issue_comment_deliveries_mode_check', sql`${table.deliveryMode} IN ('acp', 'native')`),
}));
