import {
  type AnyPgColumn,
  char,
  check,
  integer,
  jsonb,
  numeric,
  text,
  timestamp,
  unique,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { billing } from "@/db/schema/billing/schema";
import { appuser } from "@/db/schema/identity";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { reasonCode } from "@/db/schema/billing/catalogs";
import type { ModeRef } from "@/validation/accounts/mode-ref.schema";
import type { DocumentMetadata } from "@/validation/accounts/document-metadata.schema";

// Per-type document id sequences (Q18/code-standards §6.2). `document_id`
// has no column default — the insert repository selects the right
// `nextval()` for the row's `doc_type` and assembles the id itself, since a
// column default expression can't switch on a sibling column's value. This
// is the one table whose id isn't a column default; later units must not add
// one.
export const documentPaySeq = billing.sequence("document_pay_seq", {
  startWith: 1,
});
export const documentDepSeq = billing.sequence("document_dep_seq", {
  startWith: 1,
});
export const documentCrnSeq = billing.sequence("document_crn_seq", {
  startWith: 1,
});
export const documentDbnSeq = billing.sequence("document_dbn_seq", {
  startWith: 1,
});
export const documentAdjSeq = billing.sequence("document_adj_seq", {
  startWith: 1,
});
export const documentLineSeq = billing.sequence("document_line_seq", {
  startWith: 1,
});

// The workflow anchor (Q18, module Inv. #3/#5): every ledger transfer is
// created inside this row's posting transaction and carries `metadata.doc`
// back to it.
export const document = billing.table(
  "document",
  {
    documentId: text("document_id").primaryKey(),
    docType: text("doc_type").notNull(),
    state: text("state").notNull().default("draft"),
    refFinancialAccountId: text("ref_financial_account_id")
      .notNull()
      .references(() => financialAccount.financialAccountId, {
        onDelete: "restrict",
      }),
    refBillingAccountId: text("ref_billing_account_id").references(
      () => billingAccount.billingAccountId,
      { onDelete: "restrict" },
    ),
    reasonCode: text("reason_code")
      .notNull()
      .references(() => reasonCode.reasonCode, { onDelete: "restrict" }),
    currency: char("currency", { length: 3 }).notNull(),
    totalAmount: numeric("total_amount", {
      precision: 18,
      scale: 2,
      mode: "string",
    }).notNull(),
    paymentMode: text("payment_mode"),
    modeRef: jsonb("mode_ref").$type<ModeRef>(),
    referenceDate: timestamp("reference_date", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    referenceInfo: text("reference_info").notNull(),
    eventAt: timestamp("event_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    postedAt: timestamp("posted_at", {
      withTimezone: true,
      mode: "date",
    }),
    reversalOf: text("reversal_of").references(
      (): AnyPgColumn => document.documentId,
      { onDelete: "restrict" },
    ),
    createdBy: text("created_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    approvedBy: text("approved_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
    metadata: jsonb("metadata").$type<DocumentMetadata>(),
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
      "document_doc_type_check",
      sql`doc_type IN ('PAY','DEP','CRN','DBN','ADJ')`,
    ),
    check(
      "document_state_check",
      sql`state IN ('draft','pending_approval','posted','reversed','cancelled')`,
    ),
    check(
      "document_payment_mode_check",
      sql`payment_mode IS NULL OR payment_mode IN ('bank_transfer','cash','cheque')`,
    ),
  ],
);

// One posted line ↔ exactly one pgledger transfer (module Inv. #7,
// `pgledger_transfer_id` UNIQUE nullable — set at post, code-standards §6.7).
export const documentLine = billing.table(
  "document_line",
  {
    documentLineId: text("document_line_id")
      .primaryKey()
      .default(
        sql`'DLN' || lpad(nextval('billing.document_line_seq')::text, 8, '0')`,
      ),
    refDocumentId: text("ref_document_id")
      .notNull()
      .references(() => document.documentId, { onDelete: "restrict" }),
    lineNo: integer("line_no").notNull(),
    lineKind: text("line_kind").notNull(),
    refBillingAccountId: text("ref_billing_account_id").references(
      () => billingAccount.billingAccountId,
      { onDelete: "restrict" },
    ),
    refSettledDocumentId: text("ref_settled_document_id").references(
      () => document.documentId,
      { onDelete: "restrict" },
    ),
    amount: numeric("amount", {
      precision: 18,
      scale: 2,
      mode: "string",
    }).notNull(),
    pgledgerTransferId: text("pgledger_transfer_id").unique(),
    reversedByLineId: text("reversed_by_line_id").references(
      (): AnyPgColumn => documentLine.documentLineId,
      { onDelete: "restrict" },
    ),
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
    unique("document_line_ref_document_id_line_no_unique").on(
      t.refDocumentId,
      t.lineNo,
    ),
    check(
      "document_line_line_kind_check",
      sql`line_kind IN ('capture','allocation','charge','release','refund')`,
    ),
    check("document_line_amount_check", sql`amount > 0`),
  ],
);

export type Document = typeof document.$inferSelect;
export type DocumentInsert = typeof document.$inferInsert;
export type DocumentLine = typeof documentLine.$inferSelect;
export type DocumentLineInsert = typeof documentLine.$inferInsert;
