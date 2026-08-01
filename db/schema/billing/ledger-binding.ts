import { check, text, timestamp, unique } from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";
import { billing } from "@/db/schema/billing/pg-schema";

export const ledgerBindingSeq = billing.sequence("ledger_binding_seq", {
  startWith: 1,
});

// TMF row ↔ pgledger account (Module Inv. #9): every BAN has exactly one
// `receivables` binding, every FA exactly one `unapplied_cash` and one
// `deposits` binding. *Existence* of all three is a test (V2), not a DB
// constraint — the UNIQUE triple below only enforces "at most one", not "at
// least one".
export const ledgerBinding = billing.table(
  "ledger_binding",
  {
    ledgerBindingId: text("ledger_binding_id")
      .primaryKey()
      .default(
        sql`'LBD' || lpad(nextval('billing.ledger_binding_seq')::text, 6, '0')`,
      ),
    ownerType: text("owner_type").notNull(),
    // Polymorphic `BAN…`/`FIN…` — app/trigger-checked, deliberately not a DB
    // FK (ac02-spec §2.3).
    ownerId: text("owner_id").notNull(),
    ledgerRole: text("ledger_role").notNull(),
    // The `pgla_…` id from ac01's `pgledger_create_account`.
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
