import { char, check, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/schema";
import { appuser } from "@/db/schema/identity";

// Composite PK `(period, currency)` — one row per currency per period,
// multi-currency-ready even though MYR-only today (Q12). Full close
// behaviour is ac14; this unit ships the table only.
export const accountingPeriod = billing.table(
  "accounting_period",
  {
    period: text("period").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    state: text("state").notNull().default("open"),
    closedAt: timestamp("closed_at", {
      withTimezone: true,
      mode: "date",
    }),
    closedBy: text("closed_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
    lastModified: timestamp("last_modified", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastEditedBy: text("last_edited_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
  },
  (t) => [
    primaryKey({ columns: [t.period, t.currency] }),
    check("accounting_period_state_check", sql`state IN ('open','closed')`),
  ],
);

export type AccountingPeriod = typeof accountingPeriod.$inferSelect;
export type AccountingPeriodInsert = typeof accountingPeriod.$inferInsert;
