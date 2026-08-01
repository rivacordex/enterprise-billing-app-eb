import { char, check, primaryKey, text, timestamp } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import { billing } from "@/db/schema/billing/pg-schema";

// Full close behaviour is ac14 — this unit ships the table only. Composite
// PK `(period, currency)`: MYR-only today but multi-currency-ready per Q12,
// one period row per currency.
export const accountingPeriod = billing.table(
  "accounting_period",
  {
    period: text("period").notNull(),
    currency: char("currency", { length: 3 }).notNull(),
    state: text("state").notNull().default("open"),
    closedAt: timestamp("closed_at", { withTimezone: true, mode: "date" }),
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
    // Must match the `to_char(event_at, 'YYYY-MM')` key gl_journal_view
    // groups by (views.sql) — a malformed period would silently split or
    // orphan a month's journal rows.
    check(
      "accounting_period_period_format_check",
      sql`period ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'`,
    ),
  ],
);

export type AccountingPeriod = typeof accountingPeriod.$inferSelect;
export type AccountingPeriodInsert = typeof accountingPeriod.$inferInsert;
