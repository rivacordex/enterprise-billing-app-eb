import { text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser, core } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";

// No `last_modified_datetime`: a role assignment is created or deleted,
// never mutated in place (um05-spec §"ROLE_ASSIGN"). `assigned_by` is
// nullable with ON DELETE SET NULL — NULL for the seeded bootstrap row
// (a system operation, not an admin UI action); who-assigned-it is
// informational metadata, not structural data.
export const roleAssign = core.table(
  "role_assign",
  {
    roleAssignId: uuid("role_assign_id").primaryKey().defaultRandom(),
    refUserId: text("ref_user_id")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    refRoleId: uuid("ref_role_id")
      .notNull()
      .references(() => roles.roleId, { onDelete: "restrict" }),
    assignedBy: text("assigned_by").references(() => appuser.id, {
      onDelete: "set null",
    }),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("role_assign_user_role_unique").on(t.refUserId, t.refRoleId),
  ],
);

export type RoleAssign = typeof roleAssign.$inferSelect;
export type RoleAssignInsert = typeof roleAssign.$inferInsert;
