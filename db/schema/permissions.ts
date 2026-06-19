import { text, uniqueIndex, uuid } from "drizzle-orm/pg-core";

import { core } from "@/db/schema/identity";

// No timestamps: the code-seeded permission registry is static
// migration/seed-only infrastructure, not operational data (Inv. #7).
// No CHECK on `permission_name`: later modules add rows for their own
// pages via migration only — no application code path creates rows here.
export const permissions = core.table(
  "permissions",
  {
    permissionId: uuid("permission_id").primaryKey().defaultRandom(),
    permissionName: text("permission_name").notNull(),
    permissionInfo: text("permission_info"),
  },
  (t) => [
    uniqueIndex("permissions_permission_name_unique").on(t.permissionName),
  ],
);

export type Permission = typeof permissions.$inferSelect;
export type PermissionInsert = typeof permissions.$inferInsert;
