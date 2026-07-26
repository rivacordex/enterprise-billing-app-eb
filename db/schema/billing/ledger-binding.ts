import { check, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/schema";
import { appuser } from "@/db/schema/identity";

export const ledgerBindingSeq = billing.sequence("ledger_binding_seq", {
  startWith: 1,
});

// TMF row ↔ pgledger account (module Inv. #9 — the UNIQUE half; that every
// owner has *all* the roles it needs is a test property, not a constraint).
// `owner_id` is polymorphic (`BAN…`/`FIN…`) and app/trigger-checked, not a DB
// FK. `pgledger_account_id` isn't FK'd to `billing.pgledger_accounts` either
// — that table is outside the Drizzle schema surface (raw-SQL fork, ac01);
// existence is enforced by the repository that calls
// `pgledger_create_account` before inserting this row, never by the DB.
export const ledgerBinding = billing.table(
  "ledger_binding",
  {
    ledgerBindingId: text("ledger_binding_id")
      .primaryKey()
      .default(
        sql`'LBD' || lpad(nextval('billing.ledger_binding_seq')::text, 6, '0')`,
      ),
    ownerType: text("owner_type").notNull(),
    ownerId: text("owner_id").notNull(),
    ledgerRole: text("ledger_role").notNull(),
    pgledgerAccountId: text("pgledger_account_id").notNull().unique(),
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
  (t) => [
    unique("ledger_binding_owner_type_owner_id_ledger_role_unique").on(
      t.ownerType,
      t.ownerId,
      t.ledgerRole,
    ),
    check(
      "ledger_binding_owner_type_check",
      sql`owner_type IN ('billing_account','financial_account')`,
    ),
    check(
      "ledger_binding_ledger_role_check",
      sql`ledger_role IN ('receivables','unapplied_cash','deposits')`,
    ),
  ],
);

export type LedgerBinding = typeof ledgerBinding.$inferSelect;
export type LedgerBindingInsert = typeof ledgerBinding.$inferInsert;
