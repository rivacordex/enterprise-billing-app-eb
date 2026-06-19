import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { core } from "@/db/schema/identity";

// No CHECK constraint on `role_name`: roles are admin-managed at runtime;
// the seeded names (ADMIN, MANAGER, USER) are protected by a service-layer
// guard added in a later unit, not a column constraint (um05-spec §5.1).
export const roles = core.table(
  "roles",
  {
    roleId: uuid("role_id").primaryKey().defaultRandom(),
    roleName: text("role_name").notNull(),
    roleDescr: text("role_descr"),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [uniqueIndex("roles_role_name_unique").on(t.roleName)],
);

export type Role = typeof roles.$inferSelect;
export type RoleInsert = typeof roles.$inferInsert;
