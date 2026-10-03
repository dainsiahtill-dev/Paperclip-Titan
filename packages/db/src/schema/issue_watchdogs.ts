import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { companies } from "./companies.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";

export const issueWatchdogs = pgTable(
  "issue_watchdogs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    companyId: uuid("company_id").notNull().references(() => companies.id, { onDelete: "cascade" }),
    issueId: uuid("issue_id").notNull().references(() => issues.id, { onDelete: "cascade" }),
    watchdogAgentId: uuid("watchdog_agent_id").notNull().references(() => agents.id),
    instructions: text("instructions"),
    status: text("status").notNull().default("active"),
    configurationVersion: integer("configuration_version").notNull().default(1),
    watchdogIssueId: uuid("watchdog_issue_id").references(() => issues.id, { onDelete: "set null" }),
    lastObservedFingerprint: text("last_observed_fingerprint"),
    lastReviewedFingerprint: text("last_reviewed_fingerprint"),
    lastObservedStopSnapshot: jsonb("last_observed_stop_snapshot"),
    lastReviewedStopSnapshot: jsonb("last_reviewed_stop_snapshot"),
    lastTriggeredAt: timestamp("last_triggered_at", { withTimezone: true }),
    lastCompletedAt: timestamp("last_completed_at", { withTimezone: true }),
    triggerCount: integer("trigger_count").notNull().default(0),
    restorationDisposition: text("restoration_disposition"),
    restorationSourceFingerprint: text("restoration_source_fingerprint"),
    restorationClaimedFingerprint: text("restoration_claimed_fingerprint"),
    restorationAttemptCount: integer("restoration_attempt_count").notNull().default(0),
    restorationMaxAttempts: integer("restoration_max_attempts").notNull().default(3),
    verificationDueAt: timestamp("verification_due_at", { withTimezone: true }),
    restorationActionIds: jsonb("restoration_action_ids").$type<string[]>().notNull().default([]),
    restorationRunId: uuid("restoration_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdByAgentId: uuid("created_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    createdByUserId: text("created_by_user_id"),
    createdByRunId: uuid("created_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    updatedByAgentId: uuid("updated_by_agent_id").references(() => agents.id, { onDelete: "set null" }),
    updatedByUserId: text("updated_by_user_id"),
    updatedByRunId: uuid("updated_by_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => ({
    companyIdUq: unique("issue_watchdogs_company_id_uq").on(table.companyId, table.id),
    boundedAttempts: check("issue_watchdogs_bounded_attempts", sql`${table.restorationMaxAttempts} in (2,3) and ${table.restorationAttemptCount} between 0 and ${table.restorationMaxAttempts}`),
    disposition: check("issue_watchdogs_disposition", sql`${table.restorationDisposition} is null or ${table.restorationDisposition} in ('legitimate_stop', 'restoration_claimed', 'escalated')`),
    companyIssueIdx: uniqueIndex("issue_watchdogs_company_issue_uq").on(table.companyId, table.issueId),
    companyStatusIdx: index("issue_watchdogs_company_status_idx").on(table.companyId, table.status),
    companyAgentIdx: index("issue_watchdogs_company_agent_idx").on(table.companyId, table.watchdogAgentId),
    companyWatchdogIssueIdx: uniqueIndex("issue_watchdogs_company_watchdog_issue_uq")
      .on(table.companyId, table.watchdogIssueId)
      .where(sql`${table.watchdogIssueId} is not null`),
  }),
);

export const issueWatchdogAttempts = pgTable("issue_watchdog_attempts", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  watchdogId: uuid("watchdog_id").notNull(),
  sourceFingerprint: text("source_fingerprint").notNull(),
  observedFingerprint: text("observed_fingerprint").notNull(),
  claimedFingerprint: text("claimed_fingerprint"),
  attemptNumber: integer("attempt_number").notNull(),
  watchdogRunId: uuid("watchdog_run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  disposition: text("disposition"),
  dispositionRequestId: uuid("disposition_request_id"),
  dispositionRequestDigest: text("disposition_request_digest"),
  actionIds: jsonb("action_ids").$type<string[]>().notNull().default([]),
  evidence: text("evidence"),
  verificationDueAt: timestamp("verification_due_at", { withTimezone: true }),
  verificationOutcome: text("verification_outcome"),
  verifiedAt: timestamp("verified_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  watchdogFk: foreignKey({ columns: [table.companyId, table.watchdogId], foreignColumns: [issueWatchdogs.companyId, issueWatchdogs.id] }).onDelete("cascade"),
  boundedAttempts: check("issue_watchdog_attempts_bound", sql`${table.attemptNumber} between 1 and 3`),
  lineage: uniqueIndex("issue_watchdog_attempts_lineage_uq").on(table.companyId, table.watchdogId, table.sourceFingerprint, table.attemptNumber),
}));

export const issueWatchdogRecoveryBatches = pgTable("issue_watchdog_recovery_batches", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  watchdogId: uuid("watchdog_id").notNull(),
  watchdogRunId: uuid("watchdog_run_id").notNull().references(() => heartbeatRuns.id, { onDelete: "cascade" }),
  requestId: uuid("request_id").notNull(),
  requestDigest: text("request_digest").notNull(),
  observedFingerprint: text("observed_fingerprint").notNull(),
  status: text("status").notNull(),
  reason: text("reason"),
  actionIds: jsonb("action_ids").$type<string[]>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  watchdogFk: foreignKey({ columns: [table.companyId, table.watchdogId], foreignColumns: [issueWatchdogs.companyId, issueWatchdogs.id] }).onDelete("cascade"),
  singleShot: uniqueIndex("issue_watchdog_recovery_batches_run_uq").on(table.companyId, table.watchdogRunId),
  idempotency: uniqueIndex("issue_watchdog_recovery_batches_request_uq").on(table.companyId, table.watchdogId, table.requestId),
  validStatus: check("issue_watchdog_recovery_batches_status", sql`${table.status} in ('applied', 'stale')`),
}));

export const issueWatchdogRecoveryOutbox = pgTable("issue_watchdog_recovery_outbox", {
  id: uuid("id").primaryKey().defaultRandom(),
  companyId: uuid("company_id").notNull(),
  watchdogId: uuid("watchdog_id").notNull(),
  issueId: uuid("issue_id").notNull(),
  idempotencyKey: text("idempotency_key").notNull(),
  kind: text("kind").notNull(),
  status: text("status").$type<"pending" | "enqueued" | "published" | "suppressed">().notNull().default("pending"),
  deliveryReason: text("delivery_reason"),
  acceptedWakeId: text("accepted_wake_id"),
  settledAt: timestamp("settled_at", { withTimezone: true }),
  payload: jsonb("payload").$type<Record<string, unknown>>().notNull(),
  deliveredAt: timestamp("delivered_at", { withTimezone: true }),
  leaseExpiresAt: timestamp("lease_expires_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  watchdogFk: foreignKey({ columns: [table.companyId, table.watchdogId], foreignColumns: [issueWatchdogs.companyId, issueWatchdogs.id] }).onDelete("cascade"),
  issueFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }).onDelete("cascade"),
  idempotency: uniqueIndex("issue_watchdog_recovery_outbox_key_uq").on(table.companyId, table.idempotencyKey),
  pending: index("issue_watchdog_recovery_outbox_pending_idx").on(table.companyId, table.deliveredAt, table.createdAt),
  statusCheck: check("issue_watchdog_recovery_outbox_status", sql`${table.status} in ('pending', 'enqueued', 'published', 'suppressed')`),
}));
