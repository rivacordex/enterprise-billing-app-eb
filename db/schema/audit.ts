import { jsonb, text, timestamp, uuid, index } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { core, appuser } from "@/db/schema/identity";

export const auditLog = core.table(
  "audit_log",
  {
    auditId: uuid("audit_id").primaryKey().defaultRandom(),
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
    index("audit_log_actor_user_id_idx").on(t.actorUserId),
    index("audit_log_event_type_idx").on(t.eventType),
    index("audit_log_created_datetime_idx").on(t.createdDatetime),
  ],
);

export type AuditLog = typeof auditLog.$inferSelect;
export type AuditLogInsert = typeof auditLog.$inferInsert;
