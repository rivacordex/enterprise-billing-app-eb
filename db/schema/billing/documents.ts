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

import { appuser } from "@/db/schema/identity";
import { billing } from "@/db/schema/billing/pg-schema";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { reasonCode } from "@/db/schema/billing/catalogs";
import type { ModeRef } from "@/validation/accounts/mode-ref.schema";
import type { DocumentMetadata } from "@/validation/accounts/metadata.schema";

// Per-type sequences (Q18/§2.2) — `document_id` has no column default; it is
// assembled in the insert repository by choosing the sequence for the row's
// `doc_type` (the one documented exception to "IDs are a DB-layer column
// default", code-standards §6.2). Declared here only so drizzle-kit creates
// them; nothing in this schema file references them as a default.
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

// The workflow anchor (Q18): state machine, reason code, payment capture,
// reversal linkage. `total_amount = Σ lines` is app-checked at post time
// (Inv. `UNBALANCED_DOC`), not a DB constraint — line rows don't exist until
// after the header in every write path this module has (ac07+).
export const document = billing.table(
  "document",
  {
    // No `.default(...)` — see the per-type sequence note above.
    documentId: text("document_id").primaryKey(),
    docType: text("doc_type").notNull(),
    state: text("state").notNull().default("draft"),
    refFinancialAccountId: text("ref_financial_account_id")
      .notNull()
      .references(() => financialAccount.financialAccountId, {
        onDelete: "restrict",
      }),
    // Required for CRN/DBN/ADJ, app-checked (Q1) — not a DB constraint since
    // it depends on the sibling `doc_type` value.
    refBillingAccountId: text("ref_billing_account_id").references(
      () => billingAccount.billingAccountId,
      { onDelete: "restrict" },
    ),
    reasonCode: text("reason_code")
      .notNull()
      .references(() => reasonCode.reasonCode, { onDelete: "restrict" }),
    currency: char("currency", { length: 3 }).notNull(),
    totalAmount: numeric("total_amount", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
    // NOT NULL for PAY/DEP capture — app-checked (Q22), nullable here since
    // it doesn't apply to every doc_type.
    paymentMode: text("payment_mode"),
    modeRef: jsonb("mode_ref").$type<ModeRef>(),
    // Captioned "Entry Date" in the UI (AC24). Manually entered, defaults to
    // today (Q29); not used by period validation or GL grouping, though it is
    // selected for read-only display (the document detail drawer). Named
    // `entry_date` so the column name matches its caption (originally shipped
    // as `reference_date`; folded into the 0012 create migration).
    entryDate: timestamp("entry_date", {
      withTimezone: true,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    referenceInfo: text("reference_info").notNull(),
    // Captioned "Reference Date" in the UI (AC24) — despite that label this is
    // the document's true business-event date: it drives period validation +
    // GL-journal grouping (Q9/Q29). Backdatable but rejected by the posting
    // repository when the target period is closed (Inv. #7).
    eventAt: timestamp("event_at", {
      withTimezone: true,
      mode: "date",
    }).notNull(),
    postedAt: timestamp("posted_at", { withTimezone: true, mode: "date" }),
    reversalOf: text("reversal_of").references(
      (): AnyPgColumn => document.documentId,
    ),
    createdBy: text("created_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    // `approved_by <> created_by` is a service-layer check (Q20) — not
    // expressible as a DB CHECK without a self-join.
    approvedBy: text("approved_by").references(() => appuser.id, {
      onDelete: "restrict",
    }),
    // Documented JSONB exemption (Q25 escrow) — well-formed JSON plus
    // reserved-key typing only (code-standards §6.5).
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
      sql`payment_mode IN ('bank_transfer','cash','cheque')`,
    ),
  ],
);

// One row per posted line ↔ exactly one pgledger transfer (Module Inv. #7,
// the UNIQUE nullable on `pgledger_transfer_id` below).
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
    // The allocation target BAN (Q1) — nullable, not every line kind
    // targets a billing account.
    refBillingAccountId: text("ref_billing_account_id").references(
      () => billingAccount.billingAccountId,
      { onDelete: "restrict" },
    ),
    // The document/charge an `allocation` line settles (Q24, the refund
    // workbench's payment↔document application).
    refSettledDocumentId: text("ref_settled_document_id").references(
      () => document.documentId,
      { onDelete: "restrict" },
    ),
    amount: numeric("amount", {
      mode: "string",
      precision: 18,
      scale: 2,
    }).notNull(),
    // Set at post — 1:1 line↔transfer (Module Inv. #7, code-standards §6.7).
    pgledgerTransferId: text("pgledger_transfer_id").unique(),
    reversedByLineId: text("reversed_by_line_id").references(
      (): AnyPgColumn => documentLine.documentLineId,
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
