import type postgresjs from "postgres";

import { db } from "@/db/client";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { capturePayment } from "@/services/accounts/capture-payment";
import {
  approveDocument,
  submitDocument,
} from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import { onboardCustomerAccounts } from "@/services/accounts/onboard-customer-accounts";
import { raiseCreditNote } from "@/services/accounts/raise-credit-note";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { refundPayment } from "@/services/accounts/refund-payment";
import { reverseDocument } from "@/services/accounts/reverse-document";
import { roundingAdjustment } from "@/services/accounts/rounding-adjustment";
import { writeOff } from "@/services/accounts/write-off";

// rpt03-spec D9 — the Part A seed (plan §A.4). Every payment-side document is
// posted through the real Accounts services, so each line's pgledger transfer
// is the one production would write; the INVs go through the generic
// posting path the bill run uses (documentRepository + submitDocument, the
// bm09 precedent), latched to a posted `customer_bill`.
//
// Two things are set directly, because no service takes them: an INV's
// `posted_at` (the PDF's Invoice Date — posting stamps `now()`), so the
// expected files are stable; and, for one fixture invoice, a NULL `posted_at`
// (the INVOICE_POSTED_AT_MISSING data fault).
//
// MNOs:
//   MNO-A — T1, T2, T3, T5, T7, T8, T10, T11 (and the 202607 posted_at case)
//   MNO-B — T4, T6, T9 (fully allocated), R03-T4 (202606 time-zone pair)
//   MNO-C — no mnoPublicKey1: T13 (202609), T16 (202605, its only invoice)
//   MNO-D — T9 (unapplied cash, no 202609 invoice), T12 (202608 INV; an
//           unposted 202609 bill)
//   MNO-E — R03-T1's rounding in both directions and a DBN with tax; T21
// Every date is on or before 2026-10-28, except T10's PAY (2026-11-05).

export const MNO = {
  A: "MNO-A",
  B: "MNO-B",
  D: "MNO-D",
  E: "MNO-E",
} as const;

// An instant on a given Asia/Kuala_Lumpur day (09:00 local).
export function klDay(day: string): Date {
  return new Date(`${day}T09:00:00+08:00`);
}

export interface Account {
  financialAccountId: string;
  billingAccountId: string;
  partyRoleId: string;
}

export interface SettlementFixture {
  actorId: string;
  managerId: string;
  accounts: Record<"A" | "B" | "C" | "D" | "E", Account>;
  // Invoice ids by fixture name (A1 … E2, plus the other-period ones).
  invoices: Record<string, string>;
  // Payment-side document ids by fixture name.
  documents: Record<string, string>;
}

function posted(result: SubmitDocumentResult | { ok: false; code: string }) {
  if (!result.ok) throw new Error(`seed: post failed: ${result.code}`);
  return result.value;
}

export async function seedSettlementFixture(
  sql: postgresjs.Sql,
): Promise<SettlementFixture> {
  const [actor] = await sql<{ id: string }[]>`
    INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
    VALUES ('rpt03-seed-actor', 'rpt03 Actor', 'rpt03-actor@example.com', 'LOCAL', 'ACTIVE')
    RETURNING user_id AS id
  `;
  const [manager] = await sql<{ id: string }[]>`
    INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
    VALUES ('rpt03-seed-manager', 'rpt03 Manager', 'rpt03-manager@example.com', 'LOCAL', 'ACTIVE')
    RETURNING user_id AS id
  `;
  const actorId = actor!.id;
  const managerId = manager!.id;

  for (const name of [
    "cash",
    "revenue",
    "revenue_adj",
    "write_off",
    "rounding",
    "tax_payable",
  ]) {
    await sql`SELECT id FROM billing.pgledger_create_account(${`sys.${name}.MYR`}, 'MYR')`;
  }
  // The reason codes the services hard-code, with their seeded limits;
  // CUST_PAYMENT's limit routes T11's large allocation to pending_approval.
  await sql`
    INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, auto_post_limit, state)
    VALUES
      ('CUST_PAYMENT', 'PAY', 'cash', 100000.00, 'active'),
      ('PAYMENT_REFUND', 'PAY', 'cash', 0.00, 'active'),
      ('GOODWILL_CREDIT', 'CRN', 'revenue_adj', 1000.00, 'active'),
      ('MANUAL_CHARGE', 'DBN', 'revenue', 10000.00, 'active'),
      ('BAD_DEBT_WRITEOFF', 'ADJ', 'write_off', 0.00, 'active'),
      ('ROUNDING_ADJ', 'ADJ', 'rounding', 10.00, 'active'),
      ('STANDARD_INVOICE', 'INV', 'revenue', 999999999999.99, 'active')
  `;
  const [cycle] = await sql<{ id: string }[]>`
    INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
    VALUES ('rpt03 Monthly', 'monthly', 1, 30, 'active')
    RETURNING bill_cycle_id AS id
  `;
  const cycleId = cycle!.id;

  async function onboard(
    tag: string,
    spec: Record<string, string>,
  ): Promise<Account> {
    const [org] = await sql<{ id: string }[]>`
      INSERT INTO customer.organization (name, organization_type, last_modified_by)
      VALUES (${`rpt03 ${tag}`}, 'COMPANY', ${actorId})
      RETURNING organization_id AS id
    `;
    const [pr] = await sql<{ id: string; ts: Date }[]>`
      INSERT INTO customer.party_role (engaged_party, status, party_role_specification, last_modified_by)
      VALUES (${org!.id}, 'INITIALIZED', ${sql.json(spec)}, ${actorId})
      RETURNING party_role_id AS id, last_modified_datetime AS ts
    `;
    const result = await onboardCustomerAccounts(
      {
        partyRoleId: pr!.id,
        billCycleId: cycleId,
        currency: "MYR",
        statusReason: `rpt03 settlement seed — ${tag}`,
        lastModifiedDatetime: pr!.ts,
      },
      actorId,
    );
    if (!result.ok) throw new Error(`seed: onboarding ${tag}: ${result.code}`);
    return {
      financialAccountId: result.value.financialAccountId,
      billingAccountId: result.value.billingAccountId,
      partyRoleId: pr!.id,
    };
  }

  const accounts = {
    A: await onboard("MNO-A", { mnoPublicKey1: MNO.A }),
    B: await onboard("MNO-B", { mnoPublicKey1: MNO.B }),
    C: await onboard("MNO-C", {}),
    D: await onboard("MNO-D", { mnoPublicKey1: MNO.D }),
    E: await onboard("MNO-E", { mnoPublicKey1: MNO.E }),
  };

  // A completed run per bill: a BAN has at most one bill per run, and a run
  // is unique per (cycle, period), so each run gets its own fixture cycle.
  let runs = 0;
  async function billRun(periodStart: string, periodEnd: string) {
    runs += 1;
    const [runCycle] = await sql<{ id: string }[]>`
      INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
      VALUES (${`rpt03 run cycle ${runs}`}, 'monthly', 1, 30, 'active')
      RETURNING bill_cycle_id AS id
    `;
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO billing.bill_run (ref_bill_cycle_id, period_start, period_end, scheduled_run_date, status)
      VALUES (${runCycle!.id}, ${periodStart}, ${periodEnd}, ${periodEnd}::date + 1, 'COMPLETED')
      RETURNING bill_run_id AS id
    `;
    return run!.id;
  }

  // One posted bill: customer_bill → INV (revenue charge line, plus a tax
  // line when given) posted through submitDocument → latch → posted_at.
  async function invoice(
    account: Account,
    opts: {
      periodStart: string;
      periodEnd: string;
      net: string;
      tax?: string;
      total: string;
      dueDate: string;
      postedAt: string | null; // an ISO instant; null = the data fault
    },
  ): Promise<string> {
    const runId = await billRun(opts.periodStart, opts.periodEnd);
    const [bill] = await sql<{ id: string }[]>`
      INSERT INTO billing.customer_bill
        (ref_bill_run_id, ref_billing_account_id, period_partition, category, state,
         billing_period_start, billing_period_end, subtotal, tax_total, total_amount, payment_due_date)
      VALUES (${runId}, ${account.billingAccountId}, ${opts.periodStart}, 'normal', 'sent',
              ${opts.periodStart}, ${opts.periodEnd}, ${opts.net}, ${opts.tax ?? "0.00"},
              ${opts.total}, ${opts.dueDate})
      RETURNING customer_bill_id AS id
    `;
    const eventAt = new Date(`${opts.periodEnd}T12:00:00+08:00`);
    const result = await db.transaction(async (tx) => {
      const doc = await documentRepository.insert(tx, "INV", {
        state: "draft",
        refFinancialAccountId: account.financialAccountId,
        refBillingAccountId: account.billingAccountId,
        reasonCode: "STANDARD_INVOICE",
        currency: "MYR",
        totalAmount: opts.total,
        paymentMode: null,
        modeRef: null,
        entryDate: eventAt,
        referenceInfo: `rpt03 invoice ${bill!.id}`,
        eventAt,
        postedAt: null,
        reversalOf: null,
        createdBy: actorId,
        approvedBy: null,
        metadata: null,
        lastEditedBy: actorId,
        refCustomerBillId: bill!.id,
        periodPartition: opts.periodStart,
      });
      const lines: [string, "charge" | "release"][] = [[opts.net, "charge"]];
      if (opts.tax) lines.push([opts.tax, "release"]);
      for (const [i, [amount, lineKind]] of lines.entries()) {
        await documentLineRepository.insert(tx, {
          refDocumentId: doc.documentId,
          lineNo: i + 1,
          lineKind,
          refBillingAccountId: account.billingAccountId,
          refSettledDocumentId: null,
          amount,
          pgledgerTransferId: null,
          reversedByLineId: null,
          lastEditedBy: actorId,
        });
      }
      return submitDocument(tx, doc.documentId, actorId);
    });
    const inv = posted(result);
    await sql`
      UPDATE billing.customer_bill SET ref_inv_document_id = ${inv.documentId}
      WHERE customer_bill_id = ${bill!.id}
    `;
    await sql`
      UPDATE billing.document SET posted_at = ${opts.postedAt}::timestamptz
      WHERE document_id = ${inv.documentId}
    `;
    return inv.documentId;
  }

  const sep = {
    periodStart: "2026-09-01",
    periodEnd: "2026-09-30",
    dueDate: "2026-11-04",
    postedAt: "2026-10-05T10:00:00+08:00",
  };

  async function capture(
    account: Account,
    amount: string,
    day: string,
    ref: string,
  ) {
    return posted(
      await capturePayment(
        {
          financialAccountId: account.financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount,
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: ref },
          eventAt: klDay(day),
          entryDate: klDay(day),
          referenceInfo: ref,
        },
        actorId,
      ),
    ).documentId;
  }

  async function allocate(
    account: Account,
    amount: string,
    invoiceId: string | null,
    day: string,
    ref: string,
  ) {
    return posted(
      await allocatePayment(
        {
          financialAccountId: account.financialAccountId,
          billingAccountId: account.billingAccountId,
          amount,
          refSettledDocumentId: invoiceId,
          eventAt: klDay(day),
          entryDate: klDay(day),
          referenceInfo: ref,
        },
        actorId,
      ),
    );
  }

  async function approve(documentId: string) {
    return posted(
      await db.transaction((tx) => approveDocument(tx, documentId, managerId)),
    ).documentId;
  }

  const invoices: Record<string, string> = {};
  const documents: Record<string, string> = {};
  const { A, B, C, D, E } = accounts;

  // ---- MNO-A ---------------------------------------------------------------
  invoices.A1 = await invoice(A, { ...sep, net: "1000.00", total: "1000.00" }); // T1
  invoices.A2 = await invoice(A, { ...sep, net: "500.00", total: "500.00" }); // T2
  invoices.A3 = await invoice(A, { ...sep, net: "800.00", total: "800.00" }); // T3
  invoices.A4 = await invoice(A, { ...sep, net: "400.00", total: "400.00" }); // T5
  invoices.A5 = await invoice(A, { ...sep, net: "300.00", total: "300.00" }); // T10

  // T8 — 1,270.00 captured by the cut-off; 870.00 applied (500 + 300 + 400
  // − 400 reversed + 70) leaves UNAPPLIED 400.00.
  documents.captureA = await capture(A, "1270.00", "2026-10-08", "TT-55100");
  documents.payA2 = (
    await allocate(A, "500.00", invoices.A2, "2026-10-10", "TT-55120")
  ).documentId;
  documents.payA3 = (
    await allocate(A, "300.00", invoices.A3, "2026-10-11", "TT-55187")
  ).documentId;
  const payA4 = await allocate(
    A,
    "400.00",
    invoices.A4,
    "2026-10-12",
    "TT-55190",
  );
  documents.payA4 = payA4.documentId;
  documents.revA4 = posted(
    await reverseDocument(
      {
        originalDocumentId: payA4.documentId,
        financialAccountId: A.financialAccountId,
        lastModified: payA4.lastModified,
        eventAt: klDay("2026-10-14"),
        entryDate: klDay("2026-10-14"),
        referenceInfo: "Reversal - wrong account",
        reversalComment: "Allocated to the wrong account",
      },
      actorId,
    ),
  ).documentId;
  // T7 — account-level items on BAN-A.
  documents.crnA = posted(
    await raiseCreditNote(
      {
        financialAccountId: A.financialAccountId,
        billingAccountId: A.billingAccountId,
        amount: "100.00",
        eventAt: klDay("2026-10-15"),
        entryDate: klDay("2026-10-15"),
        referenceInfo: "Goodwill credit Sep outage",
      },
      actorId,
    ),
  ).documentId;
  documents.dbnA = posted(
    await raiseDebitNote(
      {
        financialAccountId: A.financialAccountId,
        billingAccountId: A.billingAccountId,
        netAmount: "50.00",
        taxAmount: null,
        eventAt: klDay("2026-10-16"),
        entryDate: klDay("2026-10-16"),
        referenceInfo: "Late payment charge",
      },
      actorId,
    ),
  ).documentId;
  const writeOffA = posted(
    await writeOff(
      {
        financialAccountId: A.financialAccountId,
        billingAccountId: A.billingAccountId,
        amount: "20.00",
        eventAt: klDay("2026-10-17"),
        entryDate: klDay("2026-10-17"),
        referenceInfo: "Bad debt write-off",
      },
      actorId,
    ),
  );
  documents.adjA = await approve(writeOffA.documentId); // always four-eyes
  documents.payA0 = (
    await allocate(A, "70.00", null, "2026-10-18", "Advance applied to account")
  ).documentId;
  // T11 — above CUST_PAYMENT's limit: stays pending_approval, never counts.
  const pendingA = await allocate(
    A,
    "150000.00",
    invoices.A1,
    "2026-10-20",
    "TT-PENDING",
  );
  if (pendingA.state !== "pending_approval")
    throw new Error(
      "seed: T11 allocation was expected to stay pending_approval",
    );
  documents.pendingA = pendingA.documentId;
  // T10 — after the default cut-off (20261031).
  documents.captureA5 = await capture(A, "300.00", "2026-11-05", "TT-56099");
  documents.payA5 = (
    await allocate(A, "300.00", invoices.A5, "2026-11-05", "TT-56100")
  ).documentId;

  // ---- MNO-B ---------------------------------------------------------------
  invoices.B1 = await invoice(B, { ...sep, net: "200.00", total: "200.00" }); // T4
  invoices.B2 = await invoice(B, { ...sep, net: "300.00", total: "300.00" }); // T4
  invoices.B3 = await invoice(B, { ...sep, net: "300.00", total: "300.00" }); // T6
  documents.captureB = await capture(B, "500.00", "2026-10-09", "Receipt 889");
  documents.payB1 = (
    await allocate(
      B,
      "200.00",
      invoices.B1,
      "2026-10-10",
      "Receipt 889, part 1",
    )
  ).documentId;
  documents.payB2 = (
    await allocate(
      B,
      "300.00",
      invoices.B2,
      "2026-10-10",
      "Receipt 889, part 2",
    )
  ).documentId;
  documents.captureB3 = await capture(B, "300.00", "2026-10-11", "TT-56001");
  documents.payB3 = (
    await allocate(B, "300.00", invoices.B3, "2026-10-12", "TT-56002")
  ).documentId;
  const [allocationB3] = await sql<{ id: string }[]>`
    SELECT document_line_id AS id FROM billing.document_line
    WHERE ref_document_id = ${documents.payB3} AND line_kind = 'allocation'
  `;
  const refundB3 = posted(
    await refundPayment(
      {
        financialAccountId: B.financialAccountId,
        billingAccountId: B.billingAccountId,
        refundType: "cash",
        items: [
          { allocationLineId: allocationB3!.id, refundedAmount: "300.00" },
        ],
        eventAt: klDay("2026-10-20"),
        entryDate: klDay("2026-10-20"),
        referenceInfo: "Refund to customer",
      },
      actorId,
    ),
  );
  documents.refundB3 = await approve(refundB3.documentId); // always four-eyes
  // R03-T4 — 202606: one INV posted at 23:59 and one at 00:01 local.
  invoices.B_late = await invoice(B, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    net: "10.00",
    total: "10.00",
    dueDate: "2026-08-03",
    postedAt: "2026-07-04T23:59:00+08:00",
  });
  invoices.B_early = await invoice(B, {
    periodStart: "2026-06-01",
    periodEnd: "2026-06-30",
    net: "20.00",
    total: "20.00",
    dueDate: "2026-08-04",
    postedAt: "2026-07-05T00:01:00+08:00",
  });

  // ---- MNO-C (no mnoPublicKey1) ---------------------------------------------
  invoices.C1 = await invoice(C, { ...sep, net: "600.00", total: "600.00" }); // T13
  documents.captureC = await capture(C, "250.00", "2026-10-10", "TT-C-1");
  documents.payC1 = (
    await allocate(C, "250.00", invoices.C1, "2026-10-11", "TT-C-2")
  ).documentId;
  documents.crnC = posted(
    await raiseCreditNote(
      {
        financialAccountId: C.financialAccountId,
        billingAccountId: C.billingAccountId,
        amount: "40.00",
        eventAt: klDay("2026-10-12"),
        entryDate: klDay("2026-10-12"),
        referenceInfo: "MNO-C credit",
      },
      actorId,
    ),
  ).documentId;
  invoices.C_may = await invoice(C, {
    // T16 — 202605's only invoice.
    periodStart: "2026-05-01",
    periodEnd: "2026-05-31",
    net: "90.00",
    total: "90.00",
    dueDate: "2026-07-04",
    postedAt: "2026-06-05T10:00:00+08:00",
  });

  // ---- MNO-D ----------------------------------------------------------------
  invoices.D_aug = await invoice(D, {
    // T12 — another period's invoice.
    periodStart: "2026-08-01",
    periodEnd: "2026-08-31",
    net: "700.00",
    total: "700.00",
    dueDate: "2026-10-04",
    postedAt: "2026-09-05T10:00:00+08:00",
  });
  const runSep = await billRun(sep.periodStart, sep.periodEnd);
  // T12 — a 202609 bill never posted (no ref_inv_document_id).
  await sql`
    INSERT INTO billing.customer_bill
      (ref_bill_run_id, ref_billing_account_id, period_partition, category, state,
       billing_period_start, billing_period_end, subtotal, tax_total, total_amount, payment_due_date)
    VALUES (${runSep}, ${D.billingAccountId}, ${sep.periodStart}, 'normal', 'new',
            ${sep.periodStart}, ${sep.periodEnd}, 55.00, 0.00, 55.00, ${sep.dueDate})
  `;
  documents.captureD = await capture(D, "250.00", "2026-10-13", "TT-D-1"); // T9

  // ---- MNO-E: rounding both ways, a DBN with tax (R03-T1) ---------------------
  invoices.E1 = await invoice(E, {
    ...sep,
    net: "92.59",
    tax: "7.41",
    total: "100.00",
  });
  // 250.00 captured, 200.01 applied: UNAPPLIED 49.99, with no document after
  // today's date, so T21 can compare it with the live balance.
  documents.captureE = await capture(E, "250.00", "2026-10-09", "TT-E-1");
  documents.payE1 = (
    await allocate(E, "100.02", invoices.E1, "2026-10-10", "TT-E-2")
  ).documentId;
  // A/R −0.02: cleared through the `release` leg (receivables increase).
  documents.roundE_up = posted(
    await roundingAdjustment(
      {
        financialAccountId: E.financialAccountId,
        billingAccountId: E.billingAccountId,
        amount: "0.02",
        eventAt: klDay("2026-10-11"),
        entryDate: klDay("2026-10-11"),
        referenceInfo: "Rounding - overpaid 0.02",
      },
      actorId,
    ),
  ).documentId;
  invoices.E2 = await invoice(E, { ...sep, net: "100.00", total: "100.00" });
  documents.payE2 = (
    await allocate(E, "99.99", invoices.E2, "2026-10-12", "TT-E-3")
  ).documentId;
  // A/R +0.01: cleared through the `charge` leg (receivables decrease).
  documents.roundE_down = posted(
    await roundingAdjustment(
      {
        financialAccountId: E.financialAccountId,
        billingAccountId: E.billingAccountId,
        amount: "0.01",
        eventAt: klDay("2026-10-13"),
        entryDate: klDay("2026-10-13"),
        referenceInfo: "Rounding - underpaid 0.01",
      },
      actorId,
    ),
  ).documentId;
  documents.dbnE = posted(
    await raiseDebitNote(
      {
        financialAccountId: E.financialAccountId,
        billingAccountId: E.billingAccountId,
        netAmount: "10.00",
        taxAmount: "0.80",
        eventAt: klDay("2026-10-14"),
        entryDate: klDay("2026-10-14"),
        referenceInfo: "Integration charge, with tax",
      },
      actorId,
    ),
  ).documentId;

  // ---- 202607: an INV whose posted_at is missing (a data fault) ---------------
  invoices.A_jul = await invoice(A, {
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    net: "40.00",
    total: "40.00",
    dueDate: "2026-09-04",
    postedAt: "2026-08-05T10:00:00+08:00",
  });
  invoices.A_jul_fault = await invoice(A, {
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    net: "45.00",
    total: "45.00",
    dueDate: "2026-09-04",
    postedAt: null,
  });

  return { actorId, managerId, accounts, invoices, documents };
}
