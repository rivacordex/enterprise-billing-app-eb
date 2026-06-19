import { check, text, timestamp, uniqueIndex, uuid } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { core } from "@/db/schema/identity";
import { roles } from "@/db/schema/roles";
import { permissions } from "@/db/schema/permissions";

// Unique on (ref_role_id, ref_permission_id): a role carries at most one
// explicit level per permission. The level hierarchy (DELETE ⊃ EDIT ⊃ READ)
// means storing the highest granted level is sufficient — the resolver
// (um06) derives the implied lower levels (um05-spec §"ROLE_PERMISSION_ASSIGN").
export const rolePermissionAssign = core.table(
  "role_permission_assign",
  {
    rolePermissionId: uuid("role_permission_id").primaryKey().defaultRandom(),
    refRoleId: uuid("ref_role_id")
      .notNull()
      .references(() => roles.roleId, { onDelete: "restrict" }),
    refPermissionId: uuid("ref_permission_id")
      .notNull()
      .references(() => permissions.permissionId, { onDelete: "restrict" }),
    permissionType: text("permission_type").notNull(),
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
  (t) => [
    uniqueIndex("role_permission_assign_role_permission_unique").on(
      t.refRoleId,
      t.refPermissionId,
    ),
    check(
      "role_permission_assign_type_check",
      sql`permission_type IN ('READ','EDIT','DELETE')`,
    ),
  ],
);

export type RolePermissionAssign = typeof rolePermissionAssign.$inferSelect;
export type RolePermissionAssignInsert =
  typeof rolePermissionAssign.$inferInsert;
