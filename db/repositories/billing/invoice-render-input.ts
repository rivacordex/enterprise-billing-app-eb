import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { document } from "@/db/schema/billing/documents";
import { contactMedium, organization, partyRole } from "@/db/schema/customer";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import {
  ratedLinesRepository,
  type CapacityDetailResult,
} from "@/db/repositories/billing/rated-lines.repository";
import { INVOICE_USAGE_ROW_LIMIT } from "@/types/billing";
import type {
  ChargeSource,
  InvoiceAddress,
  LineType,
  PostedBillStamps,
} from "@/types/billing";

// bm47-spec §Implementation §3 — the binder's only repository (D1). Every
// amount is selected `::text` (code-standards §2.3); no JS arithmetic on
// money anywhere in this file — bill-level sums are SQL `SUM`s (D2/D3). No
// rating-schema reference: the bm71 capacity detail read is delegated to
// `ratedLinesRepository.listCapacityDetailForInvoice` (the home of the read),
// so this file still never touches the rating schema (file-org rule 2 boundary
// test).

// bm71-spec §Design "The detail query" — the detail read result the binder
// guards, reconciles and shapes: the over-limit marker (D37) or the per-polygon
// rows + GROUPING SETS Sub Totals and per-type totals. Always read: the
// `chargeDetails` section that prints it is mandatory.
export type RawCapacityDetail = CapacityDetailResult;

export interface RawInvoiceLine {
  lineNo: number;
  source: ChargeSource;
  lineType: LineType;
  description: string | null;
  refProductOfferingId: string;
  udrType: string | null;
  udrCount: number | null;
  quantity: string | null;
  unit: string | null;
  snapshotQuantity: string | null;
  snapshotUnitPrice: string | null;
  grossAmount: string;
  discountAmount: string;
  netAmount: string;
  discountRate: string | null;
}

// bm70-spec §Design "Data" (D28/D30/D47) — one capacity type of service: the
// capacity lines (`line_type = 'charge'`, `grouping_key LIKE '%:CAPACITY:%'`)
// of one offering. Every figure is a SQL `numeric(18,2)::text`;
// `missingRated`/`negativeUtilised` are SQL flags the binder's guards read
// (code-standards Phase 3 General rule 6 — no TypeScript arithmetic). bm71:
// `ratedTotal` = Σ `rated_amount` of the type's capacity lines, the rated side
// of the per-type detail reconciliation (D37).
export interface RawInvoiceServiceType {
  offeringId: string;
  label: string;
  utilised: string;
  unutilised: string;
  total: string;
  ratedTotal: string;
  missingRated: boolean;
  negativeUtilised: boolean;
}

export interface RawInvoiceRenderInput {
  bill: {
    customerBillId: string;
    periodPartition: string;
    billingAccountId: string;
    currency: string;
    billingPeriodStart: string;
    billingPeriodEnd: string;
    paymentDueDate: string;
    subtotal: string;
    taxTotal: string;
    totalAmount: string;
    // D2 — compared as strings against `subtotal` before anything is bound.
    linesNetSum: string;
    grossTotal: string;
    discountTotal: string;
    // bm70 — the page-1 summary sums (SQL `FILTER` aggregates):
    // `otherChargesSubTotal` over non-capacity charge lines, `adjustments`
    // over `line_type = 'adjustment'` (`0.00` when none), and
    // `summaryBlocksSum` = Σ capacity totals + other charges + adjustments,
    // compared as a string against `linesNetSum` in `bind()`.
    otherChargesSubTotal: string;
    adjustments: string;
    summaryBlocksSum: string;
    // bm72 (D22) — the last page's Total Amount: Σ per-type Utilised (SQL).
    utilisedTotal: string;
  };
  run: { billRunId: string; cycleName: string };
  lines: RawInvoiceLine[];
  // bm70 — one row per capacity offering, ordered by label then offering id.
  serviceTypes: RawInvoiceServiceType[];
  // bm70 — non-capacity charge lines in `line_no` order.
  otherCharges: { description: string; amount: string }[];
  taxItems: { category: string; rate: string; amount: string }[];
  // bm71 — the per-polygon capacity detail (or the over-limit marker).
  capacityDetail: RawCapacityDetail;
  // final only; `null` on a draft (no `billing.document` row yet).
  document: { documentId: string; postingDate: Date | null } | null;
  customer: {
    // bm70 — the bill-to contact's name; `null` when blank (D16).
    recipientName: string | null;
    name: string;
    tradingName: string | null;
    registrationNumber: string | null;
    taxId: string | null;
    email: string | null;
    phone: string | null;
    address: InvoiceAddress | null;
  };
}

// bm70 — the bm42 capacity line identity (`<offering>:CAPACITY:<unit>`); every
// other charge line is an "Other charges" row.
const CAPACITY_CHARGE = sql`(${customerBillLine.lineType} = 'charge' AND ${customerBillLine.groupingKey} LIKE '%:CAPACITY:%')`;
const OTHER_CHARGE = sql`(${customerBillLine.lineType} = 'charge' AND ${customerBillLine.groupingKey} NOT LIKE '%:CAPACITY:%')`;

async function readBillHeader(
  tx: Database,
  runId: string,
  banId: string,
): Promise<{
  customerBillId: string;
  periodPartition: string;
  billingAccountId: string;
  currency: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  paymentDueDate: string;
  subtotal: string;
  taxTotal: string;
  totalAmount: string;
  refPartyRoleId: string;
  billRunId: string;
  cycleName: string;
  // bm49-spec §Implementation §2 — `bill_run_account.attempt_count`, the
  // same value `post-run.ts` stamps as `posted_attempt`; it scopes the
  // capacity detail read to the attempt the bill was built on (bm71).
  attempt: number;
} | null> {
  const [row] = await tx
    .select({
      customerBillId: customerBill.customerBillId,
      periodPartition: customerBill.periodPartition,
      billingAccountId: customerBill.refBillingAccountId,
      billingPeriodStart: customerBill.billingPeriodStart,
      billingPeriodEnd: customerBill.billingPeriodEnd,
      paymentDueDate: customerBill.paymentDueDate,
      subtotal: customerBill.subtotal,
      taxTotal: customerBill.taxTotal,
      totalAmount: customerBill.totalAmount,
      currency: billingAccount.currency,
      refPartyRoleId: billingAccount.refPartyRoleId,
      billRunId: billRun.billRunId,
      cycleName: billCycle.name,
      attempt: billRunAccount.attemptCount,
    })
    .from(customerBill)
    .innerJoin(billRun, eq(billRun.billRunId, customerBill.refBillRunId))
    .innerJoin(billCycle, eq(billCycle.billCycleId, billRun.refBillCycleId))
    .innerJoin(
      billingAccount,
      eq(billingAccount.billingAccountId, customerBill.refBillingAccountId),
    )
    .innerJoin(
      billRunAccount,
      and(
        eq(billRunAccount.refBillRunId, customerBill.refBillRunId),
        eq(
          billRunAccount.refBillingAccountId,
          customerBill.refBillingAccountId,
        ),
        eq(billRunAccount.periodPartition, customerBill.periodPartition),
      ),
    )
    .where(
      and(
        eq(customerBill.refBillRunId, runId),
        eq(customerBill.refBillingAccountId, banId),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readLines(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{
  lines: RawInvoiceLine[];
  linesNetSum: string;
  grossTotal: string;
  discountTotal: string;
  otherChargesSubTotal: string;
  adjustments: string;
  summaryBlocksSum: string;
}> {
  const scope = and(
    eq(customerBillLine.refCustomerBillId, customerBillId),
    eq(customerBillLine.periodPartition, periodPartition),
  );

  const rows = await tx
    .select({
      lineNo: customerBillLine.lineNo,
      source: customerBillLine.source,
      lineType: customerBillLine.lineType,
      description: customerBillLine.description,
      refProductOfferingId: customerBillLine.refProductOfferingId,
      udrType: customerBillLine.udrType,
      udrCount: customerBillLine.udrCount,
      quantity: customerBillLine.quantity,
      unit: customerBillLine.unit,
      snapshotQuantity: customerBillLine.snapshotQuantity,
      snapshotUnitPrice: customerBillLine.snapshotUnitPrice,
      grossAmount: customerBillLine.grossAmount,
      discountAmount: customerBillLine.discountAmount,
      netAmount: customerBillLine.netAmount,
      discountRate: customerBillLine.discountRate,
    })
    .from(customerBillLine)
    .where(scope)
    .orderBy(asc(customerBillLine.lineNo));

  const [sums] = await tx
    .select({
      linesNetSum: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}), 0)::numeric(18,2)::text`,
      grossTotal: sql<string>`COALESCE(SUM(${customerBillLine.grossAmount}), 0)::numeric(18,2)::text`,
      discountTotal: sql<string>`COALESCE(SUM(${customerBillLine.discountAmount}), 0)::numeric(18,2)::text`,
      // bm70 §Design "Data" — the page-1 summary sums.
      otherChargesSubTotal: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}) FILTER (WHERE ${OTHER_CHARGE}), 0)::numeric(18,2)::text`,
      adjustments: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}) FILTER (WHERE ${customerBillLine.lineType} = 'adjustment'), 0)::numeric(18,2)::text`,
      summaryBlocksSum: sql<string>`(COALESCE(SUM(${customerBillLine.netAmount}) FILTER (WHERE ${CAPACITY_CHARGE}), 0)
        + COALESCE(SUM(${customerBillLine.netAmount}) FILTER (WHERE ${OTHER_CHARGE}), 0)
        + COALESCE(SUM(${customerBillLine.netAmount}) FILTER (WHERE ${customerBillLine.lineType} = 'adjustment'), 0))::numeric(18,2)::text`,
    })
    .from(customerBillLine)
    .where(scope);

  return {
    lines: rows.map((r) => ({
      ...r,
      source: r.source as ChargeSource,
      lineType: r.lineType as LineType,
    })),
    linesNetSum: sums?.linesNetSum ?? "0.00",
    grossTotal: sums?.grossTotal ?? "0.00",
    discountTotal: sums?.discountTotal ?? "0.00",
    otherChargesSubTotal: sums?.otherChargesSubTotal ?? "0.00",
    adjustments: sums?.adjustments ?? "0.00",
    summaryBlocksSum: sums?.summaryBlocksSum ?? "0.00",
  };
}

// bm70-spec §Implementation §1 — the per-type capacity summary (D28/D30/D47):
// Unutilised = Σ(gross − rated), Utilised = Σ net − Unutilised, Total = Σ net,
// all in SQL. `missingRated` and `negativeUtilised` feed the binder's
// fail-loud guards (a NULL `rated_amount` or a negative Utilised never prints,
// Inv #55). Label = the offering name carried on the line (D27).
// bm72-spec §Design "The last page" (D22, D30) — `utilisedTotal` is the last
// page's Total Amount: a SQL `SUM` over the same per-offering Utilised figures
// (each at its printed `numeric(18,2)` scale), taken as a window over the
// per-type rows in the same scan, `0.00` with no capacity line.
async function readCapacitySummary(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{ serviceTypes: RawInvoiceServiceType[]; utilisedTotal: string }> {
  const l = customerBillLine;
  const unutilised = sql`SUM(${l.grossAmount} - ${l.ratedAmount})`;
  const utilised = sql`(SUM(${l.netAmount}) - ${unutilised})`;
  // Sort on the printed label, so a type whose lines carry no description
  // sorts by its offering-id fallback rather than last (NULLS LAST).
  const label = sql`COALESCE(min(${l.description}), ${l.refProductOfferingId})`;
  const scope = and(
    eq(l.refCustomerBillId, customerBillId),
    eq(l.periodPartition, periodPartition),
    CAPACITY_CHARGE,
  );
  const rows = await tx
    .select({
      offeringId: l.refProductOfferingId,
      label: sql<string>`${label}`,
      utilised: sql<string>`${utilised}::numeric(18,2)::text`,
      unutilised: sql<string>`${unutilised}::numeric(18,2)::text`,
      total: sql<string>`SUM(${l.netAmount})::numeric(18,2)::text`,
      ratedTotal: sql<string>`COALESCE(SUM(${l.ratedAmount}), 0)::numeric(18,2)::text`,
      missingRated: sql<boolean>`bool_or(${l.ratedAmount} IS NULL)`,
      negativeUtilised: sql<boolean>`COALESCE(${utilised} < 0, false)`,
      utilisedTotal: sql<string>`(SUM(${utilised}::numeric(18,2)) OVER ())::numeric(18,2)::text`,
    })
    .from(l)
    .where(scope)
    .groupBy(l.refProductOfferingId)
    .orderBy(label, asc(l.refProductOfferingId));
  return {
    serviceTypes: rows.map(({ utilisedTotal: _total, ...type }) => type),
    utilisedTotal: rows[0]?.utilisedTotal ?? "0.00",
  };
}

// bm70-spec §Design "Data" — the "Other charges" rows: every non-capacity
// charge line in `line_no` order, the description falling back to the
// offering id.
async function readOtherCharges(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{ description: string; amount: string }[]> {
  const l = customerBillLine;
  return tx
    .select({
      description: sql<string>`COALESCE(${l.description}, ${l.refProductOfferingId})`,
      amount: sql<string>`${l.netAmount}::text`,
    })
    .from(l)
    .where(
      and(
        eq(l.refCustomerBillId, customerBillId),
        eq(l.periodPartition, periodPartition),
        OTHER_CHARGE,
      ),
    )
    .orderBy(asc(l.lineNo));
}

async function readDocument(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{ documentId: string; postingDate: Date | null } | null> {
  const [row] = await tx
    .select({ documentId: document.documentId, postingDate: document.postedAt })
    .from(document)
    .where(
      and(
        eq(document.refCustomerBillId, customerBillId),
        eq(document.periodPartition, periodPartition),
      ),
    )
    .limit(1);
  return row ?? null;
}

async function readCustomer(
  tx: Database,
  refPartyRoleId: string,
): Promise<{
  recipientName: string | null;
  name: string;
  tradingName: string | null;
  registrationNumber: string | null;
  taxId: string | null;
  email: string | null;
  phone: string | null;
  address: InvoiceAddress | null;
}> {
  const [org] = await tx
    .select({
      name: organization.name,
      tradingName: organization.tradingName,
      registrationNumber: organization.registrationNumber,
      taxId: organization.taxId,
      preferredContactMediumId: partyRole.contactMedium,
    })
    .from(partyRole)
    .innerJoin(
      organization,
      eq(organization.organizationId, partyRole.engagedParty),
    )
    .where(eq(partyRole.partyRoleId, refPartyRoleId))
    .limit(1);
  if (!org) {
    throw new Error(
      `invoiceRenderInputRepository: no organization for party role ${refPartyRoleId}`,
    );
  }

  const contactSelect = {
    // bm70 (D16) — a blank contact name reads as `null` (the line is omitted).
    contactName: sql<
      string | null
    >`NULLIF(btrim(${contactMedium.contactName}), '')`,
    emailAddress: contactMedium.emailAddress,
    phoneNumber: contactMedium.phoneNumber,
    gaAddressLine1: contactMedium.gaAddressLine1,
    gaAddressLine2: contactMedium.gaAddressLine2,
    gaCity: contactMedium.gaCity,
    gaStateProvince: contactMedium.gaStateProvince,
    gaPostalCode: contactMedium.gaPostalCode,
    gaCountry: contactMedium.gaCountry,
  };

  interface ContactRow {
    contactName: string | null;
    emailAddress: string | null;
    phoneNumber: string | null;
    gaAddressLine1: string | null;
    gaAddressLine2: string | null;
    gaCity: string | null;
    gaStateProvince: string | null;
    gaPostalCode: string | null;
    gaCountry: string | null;
  }

  let contact: ContactRow | undefined;
  if (org.preferredContactMediumId) {
    [contact] = await tx
      .select(contactSelect)
      .from(contactMedium)
      .where(eq(contactMedium.contactMediumId, org.preferredContactMediumId))
      .limit(1);
  }
  if (!contact) {
    [contact] = await tx
      .select(contactSelect)
      .from(contactMedium)
      .where(eq(contactMedium.refPartyRole, refPartyRoleId))
      .orderBy(asc(contactMedium.contactMediumId))
      .limit(1);
  }

  const address: InvoiceAddress | null =
    contact?.gaAddressLine1 != null
      ? {
          line1: contact.gaAddressLine1,
          line2: contact.gaAddressLine2,
          city: contact.gaCity,
          stateProvince: contact.gaStateProvince,
          postalCode: contact.gaPostalCode,
          country: contact.gaCountry,
        }
      : null;

  return {
    recipientName: contact?.contactName ?? null,
    name: org.name,
    tradingName: org.tradingName,
    registrationNumber: org.registrationNumber,
    taxId: org.taxId,
    email: contact?.emailAddress ?? null,
    phone: contact?.phoneNumber ?? null,
    address,
  };
}

export const invoiceRenderInputRepository = {
  // bm53-spec §Design D5 step 1 — the bill's three version stamps (all `null`
  // until bm54 stamps them at posting), read in the binder's own repeatable-
  // read transaction BEFORE `read()`: resolution needs them. `null` when
  // no bill exists for the run/account. bm62 D1 — `refInvDocumentId` tells a
  // caller whether the bill is posted (its CSV caller was retired by bm88).
  async readBillStamps(
    tx: Database,
    { runId, banId }: { runId: string; banId: string },
  ): Promise<(PostedBillStamps & { refInvDocumentId: string | null }) | null> {
    const [row] = await tx
      .select({
        refBillTemplateFamilyId: customerBill.refBillTemplateFamilyId,
        refBillTemplateVersionId: customerBill.refBillTemplateVersionId,
        refInvoiceProfileVersion: customerBill.refInvoiceProfileVersion,
        refInvDocumentId: customerBill.refInvDocumentId,
      })
      .from(customerBill)
      .where(
        and(
          eq(customerBill.refBillRunId, runId),
          eq(customerBill.refBillingAccountId, banId),
        ),
      )
      .limit(1);
    return row ?? null;
  },

  // bm71-spec §Implementation §2 — the capacity detail is always read (the
  // `chargeDetails` section is mandatory; bm49's `includeUsage` flag is
  // gone). The read is delegated to `ratedLinesRepository` so this file keeps
  // no rating-schema reference; it runs under the same transaction the binder
  // opened.
  async read(
    tx: Database,
    { runId, banId }: { runId: string; banId: string },
  ): Promise<RawInvoiceRenderInput | null> {
    const header = await readBillHeader(tx, runId, banId);
    if (!header) return null;

    const [
      lineData,
      { serviceTypes, utilisedTotal },
      otherCharges,
      taxItems,
      doc,
      customer,
      capacityDetail,
    ] = await Promise.all([
      readLines(tx, header.customerBillId, header.periodPartition),
      readCapacitySummary(tx, header.customerBillId, header.periodPartition),
      readOtherCharges(tx, header.customerBillId, header.periodPartition),
      customerBillTaxItemRepository.listForBill(
        tx,
        header.customerBillId,
        header.periodPartition,
      ),
      readDocument(tx, header.customerBillId, header.periodPartition),
      readCustomer(tx, header.refPartyRoleId),
      ratedLinesRepository.listCapacityDetailForInvoice(tx, {
        runId,
        banId,
        attempt: header.attempt,
        customerBillId: header.customerBillId,
        periodPartition: header.periodPartition,
        limit: INVOICE_USAGE_ROW_LIMIT,
      }),
    ]);

    return {
      bill: {
        customerBillId: header.customerBillId,
        periodPartition: header.periodPartition,
        billingAccountId: header.billingAccountId,
        currency: header.currency,
        billingPeriodStart: header.billingPeriodStart,
        billingPeriodEnd: header.billingPeriodEnd,
        paymentDueDate: header.paymentDueDate,
        subtotal: header.subtotal,
        taxTotal: header.taxTotal,
        totalAmount: header.totalAmount,
        linesNetSum: lineData.linesNetSum,
        grossTotal: lineData.grossTotal,
        discountTotal: lineData.discountTotal,
        otherChargesSubTotal: lineData.otherChargesSubTotal,
        adjustments: lineData.adjustments,
        summaryBlocksSum: lineData.summaryBlocksSum,
        utilisedTotal,
      },
      run: { billRunId: header.billRunId, cycleName: header.cycleName },
      lines: lineData.lines,
      serviceTypes,
      otherCharges,
      taxItems,
      capacityDetail,
      document: doc,
      customer,
    };
  },
};
