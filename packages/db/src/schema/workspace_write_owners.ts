import { sql } from "drizzle-orm";
import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";

/** Safety tombstones deliberately have no cascading company/issue/run FKs.
 * Entity deletion and controller expiry cannot revoke a physical process. */
export const workspaceWriteOwners = pgTable("workspace_write_owners", {
  id: uuid("id").primaryKey().defaultRandom(),
  resourceKey: text("resource_key").notNull(),
  realm: text("realm").notNull(),
  canonicalRoot: text("canonical_root").notNull(),
  device: text("device").notNull(),
  inode: text("inode").notNull(),
  companyId: uuid("company_id").notNull(),
  issueId: uuid("issue_id"),
  runId: uuid("run_id").notNull(),
  generation: uuid("generation").notNull().defaultRandom(),
  state: text("state").notNull().default("reserved"),
  launchId: uuid("launch_id"),
  launchIdentity: jsonb("launch_identity").$type<Record<string, unknown>>(),
  stopReceipt: jsonb("stop_receipt").$type<Record<string, unknown>>(),
  history: jsonb("history").$type<Array<Record<string, unknown>>>().notNull().default([]),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp("released_at", { withTimezone: true }),
}, table => ({
  activeResource: uniqueIndex("workspace_write_owners_active_resource_idx").on(table.resourceKey).where(sql`${table.releasedAt} is null`),
  realmActive: index("workspace_write_owners_realm_active_idx").on(table.realm, table.releasedAt),
  companyRun: index("workspace_write_owners_company_run_idx").on(table.companyId, table.runId),
}));
