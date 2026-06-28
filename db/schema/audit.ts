import {
  jsonb,
  text,
  timestamp,
  uuid,
  index,
  primaryKey,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { core, appuser } from "@/db/schema/identity";

// PHYSICAL DDL OF RECORD: db/migrations/0001_audit.sql
// This table is PARTITION BY RANGE (created_datetime) and ULID-keyed.
// Drizzle cannot express partitioning or the composite-PK-on-partitioned-table;
// this declaration exists for query typing only. Do not `drizzle-kit push` it.
export const auditLog = core.table(
  "audit_log",
  {
    // ULID generated db-side by core.generate_ulid(), stored in uuid (16 bytes).
    auditId: uuid("audit_id")
      .notNull()
      .default(sql`core.generate_ulid()`),
    eventType: text("event_type").notNull(),
    // `text`, not `uuid`: appuser.id (the FK target) is `text` (um03-spec
    // §3.2 names `uuid`, but the column it references is `text`, so this
    // matches the actual `core.appuser.user_id` column type).
    actorUserId: text("actor_user_id").references(() => appuser.id, {
      onDelete: "set null",
    }),
    targetEntity: text("target_entity"),
    targetId: text("target_id"),
    beforeData: jsonb("before_data"),
    afterData: jsonb("after_data"),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // Composite PK is required because created_datetime is the partition key
    // (Postgres requires the partition key in every unique/PK on a partitioned
    // table). audit_id is still globally unique in practice (ULID).
    primaryKey({ columns: [t.auditId, t.createdDatetime] }),
    index("audit_log_actor_user_id_idx").on(t.actorUserId),
    index("audit_log_event_type_idx").on(t.eventType),
    index("audit_log_created_datetime_idx").on(t.createdDatetime),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
