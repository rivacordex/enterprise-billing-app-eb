import { boolean, text } from "drizzle-orm/pg-core";

import { rating } from "@/db/schema/rating/pg-schema";

// rm01-spec §Implementation §5. PHYSICAL DDL OF RECORD: db/migrations/0034_rating.sql
// Table only — the seed is rm02. Not partitioned; reference data.
export const eventCatalog = rating.table("event_catalog", {
  eventCode: text("event_code").primaryKey(),
  // Emitting component, or NULL for any.
  component: text("component"),
  // NULL means the code is logged but never alarms (rm02 §A).
  defaultSeverity: text("default_severity"),
  eventType: text("event_type"),
  probableCause: text("probable_cause"),
  description: text("description").notNull(),
  isAutoClearing: boolean("is_auto_clearing").notNull().default(false),
  // Self-reference by value, no FK.
  clearEventCode: text("clear_event_code"),
  isActive: boolean("is_active").notNull().default(true),
});

export type EventCatalog = typeof eventCatalog.$inferSelect;
export type EventCatalogInsert = typeof eventCatalog.$inferInsert;
