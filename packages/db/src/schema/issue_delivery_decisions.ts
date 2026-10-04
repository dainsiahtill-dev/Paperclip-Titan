import { sql } from "drizzle-orm";
import { check, foreignKey, index, integer, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { agents } from "./agents.js";
import { completionContracts } from "./completion_contracts.js";
import { heartbeatRuns } from "./heartbeat_runs.js";
import { issues } from "./issues.js";
import { issueThreadInteractions } from "./issue_thread_interactions.js";
import { issueWorkProducts } from "./issue_work_products.js";

export const issueDeliveryDecisions = pgTable("issue_delivery_decisions", {
  id: uuid("id").primaryKey().defaultRandom(), companyId: uuid("company_id").notNull(), issueId: uuid("issue_id").notNull(),
  requestId: uuid("request_id").notNull(), requestDigest: text("request_digest").notNull(),
  contractId: uuid("contract_id").notNull(), contractRevision: integer("contract_revision").notNull(), contractHash: text("contract_hash").notNull(),
  criterionId: text("criterion_id").notNull(), criterionDigest: text("criterion_digest").notNull(),
  workProductId: uuid("work_product_id").notNull(), materialVersion: text("material_version").notNull(), contentDigest: text("content_digest").notNull(),
  verdict: text("verdict").notNull(), reason: text("reason").notNull(),
  actorType: text("actor_type").notNull(), actorId: text("actor_id").notNull(),
  agentId: uuid("agent_id").references(() => agents.id, { onDelete: "set null" }),
  runId: uuid("run_id").references(() => heartbeatRuns.id, { onDelete: "set null" }),
  reviewInteractionId: uuid("review_interaction_id").references(() => issueThreadInteractions.id, { onDelete: "set null" }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
}, (table) => ({
  issueFk: foreignKey({ columns: [table.companyId, table.issueId], foreignColumns: [issues.companyId, issues.id] }).onDelete("cascade"),
  contractFk: foreignKey({ columns: [table.companyId, table.issueId, table.contractId], foreignColumns: [completionContracts.companyId, completionContracts.issueId, completionContracts.id] }),
  productFk: foreignKey({ columns: [table.companyId, table.workProductId], foreignColumns: [issueWorkProducts.companyId, issueWorkProducts.id] }).onDelete("cascade"),
  requestUq: uniqueIndex("issue_delivery_decisions_request_uq").on(table.companyId, table.issueId, table.requestId),
  criterionIdx: index("issue_delivery_decisions_criterion_idx").on(table.companyId, table.issueId, table.criterionId, table.createdAt),
  verdict: check("issue_delivery_decisions_verdict", sql`${table.verdict} in ('accepted', 'rejected')`),
  actor: check("issue_delivery_decisions_actor", sql`${table.actorType} in ('user', 'agent')`),
}));
