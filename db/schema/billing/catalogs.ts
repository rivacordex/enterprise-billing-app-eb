import {
  type AnyPgColumn,
  boolean,
  char,
  check,
  integer,
  numeric,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/schema";
import { appuser } from "@/db/schema/identity";

export const billCycleSeq = billing.sequence("bill_cycle_seq", {
  startWith: 1,
});
export const glMappingSeq = billing.sequence("gl_mapping_seq", {
  startWith: 1,
});

// Q13/Q14 — never deleted, only retired (module Inv. #11).
export const billCycle = billing.table(
  "bill_cycle",
  {
    billCycleId: text("bill_cycle_id")
      .primaryKey()
      .default(
        sql`'BCY' || lpad(nextval('billing.bill_cycle_seq')::text, 6, '0')`,
      ),
    name: text("name").notNull().unique(),
    description: text("description"),
    frequency: text("frequency").notNull().default("monthly"),
    cycleDay: integer("cycle_day").notNull().default(1),
    paymentDueDays: integer("payment_due_days").notNull().default(30),
    state: text("state").notNull().default("active"),
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
  () => [
    check(
      "bill_cycle_frequency_check",
      sql`frequency IN ('monthly','quarterly','annually')`,
    ),
    check("bill_cycle_cycle_day_check", sql`cycle_day BETWEEN 1 AND 28`),
    check("bill_cycle_state_check", sql`state IN ('active','retired')`),
  ],
);

// Natural-key catalog (no prefix/sequence) — `posting_nature` selects the sys
// counter-account (Q19); `auto_post_limit = 0` means always four-eyes (Q20).
export const reasonCode = billing.table(
  "reason_code",
  {
    reasonCode: text("reason_code").primaryKey(),
    name: text("name").notNull(),
    description: text("description"),
    docType: text("doc_type").notNull(),
    postingNature: text("posting_nature").notNull(),
    autoPostLimit: numeric("auto_post_limit", {
      precision: 18,
      scale: 2,
      mode: "string",
    })
      .notNull()
      .default("0"),
    state: text("state").notNull().default("active"),
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
  () => [
    check(
      "reason_code_doc_type_check",
      sql`doc_type IN ('PAY','DEP','CRN','DBN','ADJ')`,
    ),
    check(
      "reason_code_posting_nature_check",
      sql`posting_nature IN ('revenue','revenue_adj','write_off','rounding','cash','deposit_movement')`,
    ),
    check("reason_code_state_check", sql`state IN ('active','retired')`),
  ],
);

// Chart of Accounts — mastered here (Q26), never deleted, only retired.
export const glAccount = billing.table(
  "gl_account",
  {
    glCode: text("gl_code").primaryKey(),
    name: text("name").notNull(),
    accountClass: text("account_class").notNull(),
    normalBalance: text("normal_balance").notNull(),
    parentGlCode: text("parent_gl_code").references(
      (): AnyPgColumn => glAccount.glCode,
      { onDelete: "restrict" },
    ),
    isPostable: boolean("is_postable").notNull().default(true),
    state: text("state").notNull().default("active"),
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
  () => [
    check(
      "gl_account_account_class_check",
      sql`account_class IN ('asset','liability','equity','revenue','expense')`,
    ),
    check(
      "gl_account_normal_balance_check",
      sql`normal_balance IN ('debit','credit')`,
    ),
    check("gl_account_state_check", sql`state IN ('active','retired')`),
  ],
);

// Resolution rules for `gl_resolution_view` (Inv. #10) — deterministic via
// the (selector_type, selector, currency) UNIQUE.
export const glMapping = billing.table(
  "gl_mapping",
  {
    glMappingId: text("gl_mapping_id")
      .primaryKey()
      .default(
        sql`'GLM' || lpad(nextval('billing.gl_mapping_seq')::text, 6, '0')`,
      ),
    selectorType: text("selector_type").notNull(),
    selector: text("selector").notNull(),
    currency: char("currency", { length: 3 }),
    refGlCode: text("ref_gl_code")
      .notNull()
      .references(() => glAccount.glCode, { onDelete: "restrict" }),
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
    unique("gl_mapping_selector_type_selector_currency_unique").on(
      t.selectorType,
      t.selector,
      t.currency,
    ),
    check(
      "gl_mapping_selector_type_check",
      sql`selector_type IN ('ledger_role','system_account')`,
    ),
  ],
);

export type BillCycle = typeof billCycle.$inferSelect;
export type BillCycleInsert = typeof billCycle.$inferInsert;
export type ReasonCode = typeof reasonCode.$inferSelect;
export type ReasonCodeInsert = typeof reasonCode.$inferInsert;
export type GlAccount = typeof glAccount.$inferSelect;
export type GlAccountInsert = typeof glAccount.$inferInsert;
export type GlMapping = typeof glMapping.$inferSelect;
export type GlMappingInsert = typeof glMapping.$inferInsert;
