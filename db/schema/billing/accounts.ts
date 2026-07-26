import {
  char,
  check,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/schema";
import { appuser } from "@/db/schema/identity";
import { partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import type { Contact } from "@/validation/accounts/contact.schema";

export const financialAccountSeq = billing.sequence("financial_account_seq", {
  startWith: 1,
});
export const billingAccountSeq = billing.sequence("billing_account_seq", {
  startWith: 1,
});

// FA/BAN base fields (ac02-spec §2.3) — no stored balance column on either
// table (module Inv. #2): every balance is a live read from
// `pgledger_accounts_view`, never cached here.
export const financialAccount = billing.table(
  "financial_account",
  {
    financialAccountId: text("financial_account_id")
      .primaryKey()
      .default(
        sql`'FIN' || lpad(nextval('billing.financial_account_seq')::text, 6, '0')`,
      ),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").notNull().default("active"),
    refPartyRoleId: text("ref_party_role_id")
      .notNull()
      .references(() => partyRole.partyRoleId, { onDelete: "restrict" }),
    contact: jsonb("contact").$type<Contact>(),
    currency: char("currency", { length: 3 }).notNull(),
    creditLimitAmount: numeric("credit_limit_amount", {
      precision: 18,
      scale: 2,
      mode: "string",
    }),
    lastModified: timestamp("last_modified", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastEditedBy: text("last_edited_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
  },
  () => [
    check(
      "financial_account_state_check",
      sql`state IN ('active','suspended','closed')`,
    ),
  ],
);

// BAN (ac02-spec §2.3): contract-level, always under one FA. `rating_type`
// only ever `postpaid` at write time this phase (Q23) — `prepaid` stays in
// the CHECK for schema stability, not offered by the wizard. `payment_status`
// never stores `overdue` (Q8/Inv. #2) — that's derived at read time.
export const billingAccount = billing.table(
  "billing_account",
  {
    billingAccountId: text("billing_account_id")
      .primaryKey()
      .default(
        sql`'BAN' || lpad(nextval('billing.billing_account_seq')::text, 6, '0')`,
      ),
    name: text("name").notNull(),
    description: text("description"),
    state: text("state").notNull().default("active"),
    refPartyRoleId: text("ref_party_role_id")
      .notNull()
      .references(() => partyRole.partyRoleId, { onDelete: "restrict" }),
    contact: jsonb("contact").$type<Contact>(),
    refFinancialAccountId: text("ref_financial_account_id")
      .notNull()
      .references(() => financialAccount.financialAccountId, {
        onDelete: "restrict",
      }),
    currency: char("currency", { length: 3 }).notNull(),
    ratingType: text("rating_type").notNull().default("postpaid"),
    paymentStatus: text("payment_status").notNull().default("paid"),
    creditLimitAmount: numeric("credit_limit_amount", {
      precision: 18,
      scale: 2,
      mode: "string",
    }),
    refBillCycleId: text("ref_bill_cycle_id")
      .notNull()
      .references(() => billCycle.billCycleId, { onDelete: "restrict" }),
    paymentDueDaysOverride: integer("payment_due_days_override"),
    defaultPaymentMethodRef: text("default_payment_method_ref"),
    lastModified: timestamp("last_modified", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastEditedBy: text("last_edited_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
  },
  () => [
    check(
      "billing_account_state_check",
      sql`state IN ('active','suspended','closed')`,
    ),
    check(
      "billing_account_rating_type_check",
      sql`rating_type IN ('prepaid','postpaid')`,
    ),
    check(
      "billing_account_payment_status_check",
      sql`payment_status IN ('paid','due','in_dispute')`,
    ),
  ],
);

export type FinancialAccount = typeof financialAccount.$inferSelect;
export type FinancialAccountInsert = typeof financialAccount.$inferInsert;
export type BillingAccount = typeof billingAccount.$inferSelect;
export type BillingAccountInsert = typeof billingAccount.$inferInsert;
