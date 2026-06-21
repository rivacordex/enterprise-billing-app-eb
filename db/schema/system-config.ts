import {
  boolean,
  check,
  integer,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser, core } from "@/db/schema/identity";

// `modified_by` is `text` (not `uuid`, despite um22-spec's literal SQL) —
// it references `appuser.id`, which Better-Auth hardcodes as `text` (see
// db/schema/identity.ts), matching `role_assign.assigned_by`'s established
// pattern. Nullable + ON DELETE SET NULL: seeded rows have no human actor,
// and tombstoning the modifying admin preserves config history.
export const systemConfig = core.table(
  "system_config",
  {
    configId: uuid("config_id").primaryKey().defaultRandom(),
    configGroup: text("config_group").notNull(),
    configVersion: integer("config_version").notNull().default(1),
    configKey: text("config_key").notNull(),
    configValue: text("config_value"),
    isSecret: boolean("is_secret").notNull().default(false),
    status: text("status").notNull().default("ACTIVE"),
    modifiedBy: text("modified_by").references(() => appuser.id, {
      onDelete: "set null",
    }),
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
    uniqueIndex("system_config_group_version_key_unique").on(
      t.configGroup,
      t.configVersion,
      t.configKey,
    ),
    check(
      "system_config_status_check",
      sql`status IN ('DRAFT','ACTIVE','RETIRED')`,
    ),
  ],
);

export type SystemConfig = typeof systemConfig.$inferSelect;
export type SystemConfigInsert = typeof systemConfig.$inferInsert;
