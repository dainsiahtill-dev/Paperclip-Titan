import { index, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

/** Instance-local host evidence, never a company writer or namespace receipt.
 * No cascading entity FK: logical deletion cannot erase lifetime uncertainty. */
export const legacyWorkspaceEpochClosures = pgTable("legacy_workspace_epoch_closures", {
  id: uuid("id").primaryKey().defaultRandom(),
  realm: text("realm").notNull(),
  state: text("state").notNull().default("prepared"),
  generation: uuid("generation").notNull().defaultRandom(),
  digest: text("digest").notNull(),
  manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull(),
  closure: jsonb("closure").$type<Record<string, unknown>>(),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  closedAt: timestamp("closed_at", { withTimezone: true }),
}, (table) => ({
  activeRealm: uniqueIndex("legacy_workspace_epoch_closures_active_realm_idx").on(table.realm).where(sql`${table.closedAt} is null`),
  realmState: index("legacy_workspace_epoch_closures_realm_state_idx").on(table.realm, table.state),
}));
