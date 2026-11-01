import { eq } from "drizzle-orm";
import type postgresjs from "postgres";

import { db } from "@/db/client";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { billingAccount } from "@/db/schema/billing/accounts";
import { appuser } from "@/db/schema/identity";
import { allocatePayment } from "@/services/accounts/allocate-payment";
import { captureDeposit } from "@/services/accounts/capture-deposit";
import { capturePayment } from "@/services/accounts/capture-payment";
import {
  approveDocument,
  submitDocument,
} from "@/services/accounts/document-state-machine";
import type { SubmitDocumentResult } from "@/services/accounts/document-state-machine";
import { raiseCreditNote } from "@/services/accounts/raise-credit-note";
import { raiseDebitNote } from "@/services/accounts/raise-debit-note";
import { refundDeposit } from "@/services/accounts/refund-deposit";
import { refundPayment } from "@/services/accounts/refund-payment";
import { reverseDeposit } from "@/services/accounts/reverse-deposit";
import { reverseDocument } from "@/services/accounts/reverse-document";
import { roundingAdjustment } from "@/services/accounts/rounding-adjustment";
import { writeOff } from "@/services/accounts/write-off";
import { createPostedInvoiceFixtures } from "@/tests/fixtures/reporting/posted-invoice-fixtures";
import type { PostedInvoice } from "@/tests/fixtures/reporting/posted-invoice-fixtures";

// rpt09-spec Implementation §5 — the Part E seed: one day's postings
// (2026-10-26, Asia/Kuala_Lumpur) covering every §E.1 row kind. Its own seed,
// as rpt08's is: Part C reports every party role with a billing account, so new
// MNOs in the Part A seed would change rpt05's expected file.
//
// - Capacity invoices go through the real bill-run path
//   (posted-invoice-fixtures.ts, shared with the rpt08 seed), so the polygon
//   lines, capacity lines, discount and commitment floor are the ones billing
//   writes and posts.
// - Recurring, one-time, taxed and annual invoices are hand-built bills
//   (customer_bill + customer_bill_line, then an INV through submitDocument
//   latched to the bill, the rpt03 seed's precedent): the real path writes no
//   tax and no recurring line for a capacity-only offering.
// - Every payment-side document is posted through the real Accounts services,
//   so each line's pgledger transfer is the one production would write.
//
// Set directly, because posting stamps `now()`: every document's `posted_at`
// and its transfers' `created_at` (`pin`). The GL feed takes documents by
// `posted_at` day and GL20(b) reconciles against the transfers' `created_at`
// day, so both are pinned to the same instant, as one posting would make them.
//
// 2026-10-26 (the default run, `GL_DAY`):
//   MNO10 — J1 09:00, capacity: polygons 500.00 / 300.00 / 200.00 with a
//           100.00 motivation discount (R09-T1, R09-T2, G-T1), price GL 4010;
//           a 1,500.00 capture (G-T5); 600.00 to J_old1 (G-T3, partial) and
//           400.00 to J_old2 (G-T2, full; entry date 2026-10-21, R09-T6), both
//           ref TT-57001 (G-T4); a CRN, a DBN MANUAL_CHARGE and a write-off
//           (G-T7; G-T8 with occ_reason_codes=MANUAL_CHARGE); a 5,000.00 deposit
//           (G-T9); a CRN at 23:59 (G-T17)
//   MNO11 — K1 11:00, an annual-cycle invoice: recurring 12,000.00 + tax
//           960.00, every row P (G-T10); the reversal of a 300.00 allocation to
//           K_old (G-T6); a cash refund of a 200.00 allocation to K_old2 (a
//           release and a payout); a deposit released to account and refunded
//           (G-T9)
//   MNO12 — L1 12:00: recurring 300.00 + one-time 50.00 + tax 28.00 = 378.00
//           (G-T20)
//   MNO13 — 100.02 applied to a 100.00 invoice, the 0.02 cleared by a rounding
//           adjustment through its `release` leg (+0.02)
//   MNO14 — N1 09:30, capacity: 2.5 Mbps under a 5 Mbps commitment, a 250.00
//           top-up (R09-T3), and a price with no GL code (G-T11:
//           GL_CODE_FALLBACK, WARNING). Its own MNO: Part C fails two party
//           roles sharing a key, and G-T18 ties to Part C.
// 2026-10-27 00:01: a CRN of MNO10 (G-T17's other side).
// Earlier days: the invoices, captures, allocations and deposit the 26th's
// documents settle, reverse or release (2026-10-05, 2026-10-20). Nothing on the
// 25th (G-T13).

export const GL_DAY = "20261026";
export const NEXT_DAY = "20261027";
export const EMPTY_DAY = "20261025";

export const MNO = {
  J: "MNO10",
  K: "MNO11",
  L: "MNO12",
  M: "MNO13",
  N: "MNO14",
} as const;

// The product price GL codes the fixture sets (G-T11's N1 has none).
export const PRICE_GL = {
  capacity: "4010",
  recurring: "4020",
  oneTime: "4030",
};

const PREFIX = "RPT09";
const PERIOD_START = "2026-09-01";
const PERIOD_END = "2026-09-30";
const CLAIM_AT = "2026-09-10T00:00:00.000Z";

const at = (time: string, day = "2026-10-26") => `${day}T${time}+08:00`;

export interface Account {
  financialAccountId: string;
  billingAccountId: string;
}

export interface GlFeedFixture {
  accounts: Record<"J" | "K" | "L" | "M" | "N", Account>;
  // Capacity invoices (real bill-run path), by fixture name.
  capacity: Record<"J1" | "N1", PostedInvoice>;
  // Every other document id, by fixture name.
  documents: Record<string, string>;
}

function posted(result: SubmitDocumentResult | { ok: false; code: string }) {
  if (!result.ok) throw new Error(`seed: post failed: ${result.code}`);
  return result.value;
}

export async function seedGlFeedFixture(
  sql: postgresjs.Sql,
): Promise<GlFeedFixture> {
  const fx = await createPostedInvoiceFixtures(sql, {
    prefix: PREFIX,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    claimAt: CLAIM_AT,
  });
  const { actorId } = fx;
  const [manager] = await fx.db
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName: `${PREFIX}-fixture-manager`,
      userEmail: `${crypto.randomUUID()}@example.invalid`,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  const managerId = manager!.id;

  // posted_at and the transfers' created_at, as one posting at `instant`.
  async function pin(documentId: string, instant: string): Promise<string> {
    await sql`
      UPDATE billing.document SET posted_at = ${instant}::timestamptz
      WHERE document_id = ${documentId}
    `;
    await sql`
      UPDATE billing.pgledger_transfers SET created_at = ${instant}::timestamptz
      WHERE id IN (SELECT pgledger_transfer_id FROM billing.document_line
                   WHERE ref_document_id = ${documentId})
    `;
    return documentId;
  }

  async function account(banId: string): Promise<Account> {
    const [ban] = await fx.db
      .select({ faId: billingAccount.refFinancialAccountId })
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, banId));
    return { financialAccountId: ban!.faId, billingAccountId: banId };
  }

  // An MNO with no capacity invoice: an account, its ledger, its key.
  async function newMno(label: string, mno: string): Promise<Account> {
    const ban = await fx.flow.newAccount(label);
    await fx.bindLedger(ban);
    await fx.setKey(ban, mno);
    return account(ban);
  }

  async function price(
    offeringId: string,
    priceType: "recurring" | "oneTime",
    amount: string,
    glCode: string,
  ): Promise<string> {
    const recurring = priceType === "recurring";
    const [row] = await sql<{ id: string }[]>`
      INSERT INTO product.product_offering_price
        (product_offering_id, name, component_type, price_component,
         recurring_charge_period_length, recurring_charge_period_type,
         currency, gl_code, start_date_time)
      VALUES
        (${offeringId}, ${`${PREFIX} ${priceType} fee`}, 'flat_fee',
         ${JSON.stringify({
           "@type": "flat_fee",
           specVersion: 1,
           plaSpecId: null,
           priceType,
           appliesAt: "billing",
           basis: "flat",
           boundTo: null,
           params: { amount },
         })}::jsonb,
         ${recurring ? 1 : null}, ${recurring ? "months" : null},
         'MYR', ${glCode}, '2026-01-01T00:00:00Z'::timestamptz)
      RETURNING product_offering_price_id AS id
    `;
    return row!.id;
  }

  // A hand-built posted bill: run → customer_bill → its lines → an INV
  // (revenue charge line, plus a tax line when given) through submitDocument
  // → latch → pin.
  let runs = 0;
  async function manualInvoice(
    acct: Account,
    opts: {
      lines: {
        source: "RECURRING" | "OCC";
        offeringId: string;
        net: string;
        priceRef?: string;
      }[];
      tax?: string;
      postedAt: string;
    },
  ): Promise<string> {
    runs += 1;
    const [runCycle] = await sql<{ id: string }[]>`
      INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
      VALUES (${`${PREFIX} manual run cycle ${runs}`}, 'monthly', 1, 30, 'active')
      RETURNING bill_cycle_id AS id
    `;
    const [run] = await sql<{ id: string }[]>`
      INSERT INTO billing.bill_run (ref_bill_cycle_id, period_start, period_end, scheduled_run_date, status)
      VALUES (${runCycle!.id}, ${PERIOD_START}, ${PERIOD_END}, '2026-10-01', 'COMPLETED')
      RETURNING bill_run_id AS id
    `;
    const cents = (amount: string) => Math.round(Number(amount) * 100);
    const money = (c: number) =>
      `${Math.trunc(c / 100)}.${String(c % 100).padStart(2, "0")}`;
    const netCents = opts.lines.reduce((sum, l) => sum + cents(l.net), 0);
    const subtotal = money(netCents);
    const tax = opts.tax ?? "0.00";
    const total = money(netCents + cents(tax));
    const [bill] = await sql<{ id: string }[]>`
      INSERT INTO billing.customer_bill
        (ref_bill_run_id, ref_billing_account_id, period_partition, category, state,
         billing_period_start, billing_period_end, subtotal, tax_total, total_amount, payment_due_date)
      VALUES (${run!.id}, ${acct.billingAccountId}, ${PERIOD_START}, 'normal', 'sent',
              ${PERIOD_START}, ${PERIOD_END}, ${subtotal}, ${tax}, ${total}, '2026-11-25')
      RETURNING customer_bill_id AS id
    `;
    for (const [i, line] of opts.lines.entries()) {
      await sql`
        INSERT INTO billing.customer_bill_line
          (ref_customer_bill_id, period_partition, line_no, source, line_type,
           ref_product_offering_id, gross_amount, discount_amount, net_amount,
           grouping_key, currency, snapshot_price_ref)
        VALUES (${bill!.id}, ${PERIOD_START}, ${i + 1}, ${line.source}, 'charge',
                ${line.offeringId}, ${line.net}, 0.00, ${line.net},
                ${`${line.offeringId}:${line.source}:${i + 1}`}, 'MYR', ${line.priceRef ?? null})
      `;
    }
    const eventAt = new Date(`${PERIOD_END}T12:00:00+08:00`);
    const result = await db.transaction(async (tx) => {
      const doc = await documentRepository.insert(tx, "INV", {
        state: "draft",
        refFinancialAccountId: acct.financialAccountId,
        refBillingAccountId: acct.billingAccountId,
        reasonCode: "STANDARD_INVOICE",
        currency: "MYR",
        totalAmount: total,
        paymentMode: null,
        modeRef: null,
        entryDate: eventAt,
        referenceInfo: `${PREFIX} invoice ${bill!.id}`,
        eventAt,
        postedAt: null,
        reversalOf: null,
        createdBy: actorId,
        approvedBy: null,
        metadata: null,
        lastEditedBy: actorId,
        refCustomerBillId: bill!.id,
        periodPartition: PERIOD_START,
      });
      const lines: [string, "charge" | "release"][] = [[subtotal, "charge"]];
      if (opts.tax) lines.push([opts.tax, "release"]);
      for (const [i, [amount, lineKind]] of lines.entries()) {
        await documentLineRepository.insert(tx, {
          refDocumentId: doc.documentId,
          lineNo: i + 1,
          lineKind,
          refBillingAccountId: acct.billingAccountId,
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
    return pin(inv.documentId, opts.postedAt);
  }

  const day = (instant: string) => new Date(instant);

  async function capture(
    acct: Account,
    amount: string,
    instant: string,
    ref: string,
  ) {
    const doc = posted(
      await capturePayment(
        {
          financialAccountId: acct.financialAccountId,
          reasonCode: "CUST_PAYMENT",
          amount,
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: ref },
          eventAt: day(instant),
          entryDate: day(instant),
          referenceInfo: ref,
        },
        actorId,
      ),
    );
    return pin(doc.documentId, instant);
  }

  async function allocate(
    acct: Account,
    amount: string,
    invoiceId: string,
    instant: string,
    ref: string,
    entryDate = instant,
  ) {
    const doc = posted(
      await allocatePayment(
        {
          financialAccountId: acct.financialAccountId,
          billingAccountId: acct.billingAccountId,
          amount,
          refSettledDocumentId: invoiceId,
          eventAt: day(entryDate),
          entryDate: day(entryDate),
          referenceInfo: ref,
        },
        actorId,
      ),
    );
    await pin(doc.documentId, instant);
    return doc;
  }

  async function approve(documentId: string, instant: string) {
    const doc = posted(
      await db.transaction((tx) => approveDocument(tx, documentId, managerId)),
    );
    return pin(doc.documentId, instant);
  }

  const docs: Record<string, string> = {};

  // ---- Offerings for the hand-built bills -----------------------------------
  const annualOffering = await fx.flow.newOffering(`${PREFIX} Annual Access`);
  const annualPrice = await price(
    annualOffering,
    "recurring",
    "12000.00",
    PRICE_GL.recurring,
  );
  const portOffering = await fx.flow.newOffering(`${PREFIX} Port Fee`);
  const portPrice = await price(
    portOffering,
    "recurring",
    "300.00",
    PRICE_GL.recurring,
  );
  const integrationOffering = await fx.flow.newOffering(
    `${PREFIX} Integration Fee`,
  );
  await price(integrationOffering, "oneTime", "50.00", PRICE_GL.oneTime);
  // Earlier invoices' content doesn't reach the 26th's file.
  const oldInvoice = (acct: Account, net: string) =>
    manualInvoice(acct, {
      lines: [
        {
          source: "RECURRING",
          offeringId: portOffering,
          net,
          priceRef: portPrice,
        },
      ],
      postedAt: at("10:00:00", "2026-10-05"),
    });

  // ---- MNO10 -----------------------------------------------------------------
  const J1 = await fx.postedInvoice({
    label: "J1",
    mno: MNO.J,
    product: "RPT09 eMBB Wholesale",
    // 10 Mbps: the 5 above 5 at RM80 instead of RM100, a 100.00 line discount.
    offering: {
      baseRate: "100",
      committedQuantity: null,
      steps: [{ aboveQuantity: 5, ratePerUnit: "80" }],
    },
    polygons: [
      { polygonId: "PCU-J-0001", commercialUnit: "CU-J-1", ea: 5 },
      {
        polygonId: "PCU-J-0002",
        commercialUnit: "CU-J-1",
        ea: 3,
        start: "2025-04-15",
      },
      { polygonId: "PCU-J-0003", commercialUnit: "CU-J-1", ea: 2 },
    ],
    postedAt: at("09:00:00"),
  });
  await sql`
    UPDATE product.product_offering_price SET gl_code = ${PRICE_GL.capacity}
    WHERE product_offering_price_id = ${J1.usageRatePriceId}
  `;
  await pin(J1.invoiceId, at("09:00:00"));
  const N1 = await fx.postedInvoice({
    label: "N1",
    mno: MNO.N,
    product: "RPT09 FWA Committed",
    // 5 Mbps committed at RM100, 2.5 used: a 250.00 commitment top-up.
    offering: { baseRate: "100", committedQuantity: 5, steps: null },
    polygons: [
      { polygonId: "PCU-N-0001", commercialUnit: "CU-N-1", ea: 1 },
      { polygonId: "PCU-N-0002", commercialUnit: "CU-N-1", ea: 1.5 },
    ],
    postedAt: at("09:30:00"),
  });
  await pin(N1.invoiceId, at("09:30:00"));
  const J = await account(J1.banId);

  docs.J_old1 = await oldInvoice(J, "1000.00");
  docs.J_old2 = await oldInvoice(J, "400.00");
  docs.captureJ = await capture(J, "1500.00", at("10:00:00"), "TT-57001");
  docs.payJ1 = (
    await allocate(J, "600.00", docs.J_old1, at("10:05:00"), "TT-57001")
  ).documentId;
  docs.payJ2 = (
    await allocate(
      J,
      "400.00",
      docs.J_old2,
      at("10:06:00"),
      "TT-57001",
      at("10:06:00", "2026-10-21"),
    )
  ).documentId;
  docs.crnJ = await pin(
    posted(
      await raiseCreditNote(
        {
          financialAccountId: J.financialAccountId,
          billingAccountId: J.billingAccountId,
          amount: "75.00",
          eventAt: day(at("10:10:00")),
          entryDate: day(at("10:10:00")),
          referenceInfo: "Service credit Oct outage",
        },
        actorId,
      ),
    ).documentId,
    at("10:10:00"),
  );
  docs.dbnJ = await pin(
    posted(
      await raiseDebitNote(
        {
          financialAccountId: J.financialAccountId,
          billingAccountId: J.billingAccountId,
          netAmount: "50.00",
          taxAmount: null,
          eventAt: day(at("10:15:00")),
          entryDate: day(at("10:15:00")),
          referenceInfo: "Late payment charge",
        },
        actorId,
      ),
    ).documentId,
    at("10:15:00"),
  );
  const writeOffJ = posted(
    await writeOff(
      {
        financialAccountId: J.financialAccountId,
        billingAccountId: J.billingAccountId,
        amount: "20.00",
        eventAt: day(at("10:20:00")),
        entryDate: day(at("10:20:00")),
        referenceInfo: "Bad debt write-off",
      },
      actorId,
    ),
  );
  docs.adjJ = await approve(writeOffJ.documentId, at("10:20:00")); // always four-eyes
  docs.depJ = await pin(
    posted(
      await captureDeposit(
        {
          financialAccountId: J.financialAccountId,
          amount: "5000.00",
          payment_mode: "bank_transfer",
          mode_ref: { bankRef: "TT-57010" },
          eventAt: day(at("10:25:00")),
          entryDate: day(at("10:25:00")),
          referenceInfo: "Security deposit",
        },
        actorId,
      ),
    ).documentId,
    at("10:25:00"),
  );
  // G-T17 — 23:59 on the 26th, and 00:01 on the 27th.
  const credit = async (amount: string, instant: string, ref: string) =>
    pin(
      posted(
        await raiseCreditNote(
          {
            financialAccountId: J.financialAccountId,
            billingAccountId: J.billingAccountId,
            amount,
            eventAt: day(instant),
            entryDate: day(instant),
            referenceInfo: ref,
          },
          actorId,
        ),
      ).documentId,
      instant,
    );
  docs.crnJ_late = await credit(
    "10.00",
    at("23:59:00"),
    "Credit before midnight",
  );
  docs.crnJ_next = await credit(
    "5.00",
    at("00:01:00", "2026-10-27"),
    "Credit after midnight",
  );

  // ---- MNO11 (annual bill cycle) -----------------------------------------------
  const K = await newMno("K", MNO.K);
  const [annual] = await sql<{ id: string }[]>`
    INSERT INTO billing.bill_cycle (name, frequency, cycle_day, payment_due_days, state)
    VALUES (${`${PREFIX} Annual`}, 'annually', 1, 30, 'active')
    RETURNING bill_cycle_id AS id
  `;
  await sql`
    UPDATE billing.billing_account SET ref_bill_cycle_id = ${annual!.id}
    WHERE billing_account_id = ${K.billingAccountId}
  `;
  docs.K_old = await oldInvoice(K, "300.00");
  docs.K_old2 = await oldInvoice(K, "200.00");
  const earlier = (time: string) => at(time, "2026-10-20");
  docs.captureK = await capture(K, "500.00", earlier("10:00:00"), "TT-58001");
  const payK = await allocate(
    K,
    "300.00",
    docs.K_old,
    earlier("10:05:00"),
    "TT-58001",
  );
  docs.payK = payK.documentId;
  docs.payK2 = (
    await allocate(K, "200.00", docs.K_old2, earlier("10:06:00"), "TT-58001")
  ).documentId;
  docs.depK = await pin(
    posted(
      await captureDeposit(
        {
          financialAccountId: K.financialAccountId,
          amount: "1000.00",
          payment_mode: "cheque",
          mode_ref: { chequeNo: "CHQ-4471", bank: "Maybank" },
          eventAt: day(earlier("10:10:00")),
          entryDate: day(earlier("10:10:00")),
          referenceInfo: "Security deposit",
        },
        actorId,
      ),
    ).documentId,
    earlier("10:10:00"),
  );

  docs.K1 = await manualInvoice(K, {
    lines: [
      {
        source: "RECURRING",
        offeringId: annualOffering,
        net: "12000.00",
        priceRef: annualPrice,
      },
    ],
    tax: "960.00",
    postedAt: at("11:00:00"),
  });
  docs.revK = await pin(
    posted(
      await reverseDocument(
        {
          originalDocumentId: payK.documentId,
          financialAccountId: K.financialAccountId,
          lastModified: payK.lastModified,
          eventAt: day(at("11:10:00")),
          entryDate: day(at("11:10:00")),
          referenceInfo: "Reversal - TT returned",
          reversalComment: "Payment returned by the bank",
        },
        actorId,
      ),
    ).documentId,
    at("11:10:00"),
  );
  const [allocationK2] = await sql<{ id: string }[]>`
    SELECT document_line_id AS id FROM billing.document_line
    WHERE ref_document_id = ${docs.payK2} AND line_kind = 'allocation'
  `;
  const refundK = posted(
    await refundPayment(
      {
        financialAccountId: K.financialAccountId,
        billingAccountId: K.billingAccountId,
        refundType: "cash",
        items: [
          { allocationLineId: allocationK2!.id, refundedAmount: "200.00" },
        ],
        eventAt: day(at("11:20:00")),
        entryDate: day(at("11:20:00")),
        referenceInfo: "Refund to customer",
      },
      actorId,
    ),
  );
  docs.refundK = await approve(refundK.documentId, at("11:20:00")); // always four-eyes
  const releaseK = posted(
    await reverseDeposit(
      {
        financialAccountId: K.financialAccountId,
        amount: "1000.00",
        eventAt: day(at("11:30:00")),
        entryDate: day(at("11:30:00")),
        referenceInfo: "Deposit released to account",
      },
      actorId,
    ),
  );
  docs.depReleaseK = await approve(releaseK.documentId, at("11:30:00"));
  const depRefundK = posted(
    await refundDeposit(
      {
        financialAccountId: K.financialAccountId,
        amount: "1000.00",
        paymentMode: "bank_transfer",
        modeRef: { bankRef: "TT-58020" },
        eventAt: day(at("11:40:00")),
        entryDate: day(at("11:40:00")),
        referenceInfo: "Deposit refund",
      },
      actorId,
    ),
  );
  docs.depRefundK = await approve(depRefundK.documentId, at("11:40:00"));

  // ---- MNO12 ----------------------------------------------------------------
  const L = await newMno("L", MNO.L);
  docs.L1 = await manualInvoice(L, {
    lines: [
      {
        source: "RECURRING",
        offeringId: portOffering,
        net: "300.00",
        priceRef: portPrice,
      },
      { source: "OCC", offeringId: integrationOffering, net: "50.00" },
    ],
    tax: "28.00",
    postedAt: at("12:00:00"),
  });

  // ---- MNO13 (rounding through the release leg) ---------------------------------
  const M = await newMno("M", MNO.M);
  docs.M_old = await oldInvoice(M, "100.00");
  docs.captureM = await capture(M, "250.00", earlier("10:00:00"), "TT-59001");
  docs.payM = (
    await allocate(M, "100.02", docs.M_old, at("12:10:00"), "TT-59002")
  ).documentId;
  docs.roundM = await pin(
    posted(
      await roundingAdjustment(
        {
          financialAccountId: M.financialAccountId,
          billingAccountId: M.billingAccountId,
          amount: "0.02",
          eventAt: day(at("12:15:00")),
          entryDate: day(at("12:15:00")),
          referenceInfo: "Rounding - overpaid 0.02",
        },
        actorId,
      ),
    ).documentId,
    at("12:15:00"),
  );

  return {
    accounts: { J, K, L, M, N: await account(N1.banId) },
    capacity: { J1, N1 },
    documents: docs,
  };
}
