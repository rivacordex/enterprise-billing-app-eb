import { and, asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { document } from "@/db/schema/billing/documents";
import { contactMedium, organization, partyRole } from "@/db/schema/customer";
import { customerBillTaxItemRepository } from "@/db/repositories/billing/customer-bill-tax-item.repository";
import type { ChargeSource, InvoiceAddress, LineType } from "@/types/billing";

// bm47-spec §Implementation §3 — the binder's only repository (D1). Every
// amount is selected `::text` (code-standards §2.3); no JS arithmetic on
// money anywhere in this file — group/bill-level subtotals are SQL `SUM`s
// (D2/D3). No `rating.` reference (file-org rule 2 boundary test).

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
  // SQL window sums `OVER (PARTITION BY source)` — the group's own totals,
  // identical on every line of that group (D3).
  groupGrossTotal: string;
  groupDiscountTotal: string;
  groupNetTotal: string;
}

export interface RawInvoiceUsageRow {
  polygon: string;
  state: string | null;
  district: string | null;
  volume: string;
  amount: string;
  unit: string | null;
}

export type RawInvoiceUsageSubtotal =
  | { grain: "district"; state: string | null; district: string | null; amount: string }
  | { grain: "state"; state: string | null; district: null; amount: string }
  | { grain: "grand"; state: null; district: null; amount: string };

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
  };
  run: { billRunId: string; cycleName: string };
  lines: RawInvoiceLine[];
  taxItems: { category: string; rate: string; amount: string }[];
  // final only; `null` on a draft (no `billing.document` row yet).
  document: { documentId: string; postingDate: Date | null } | null;
  customer: {
    name: string;
    tradingName: string | null;
    registrationNumber: string | null;
    taxId: string | null;
    email: string | null;
    phone: string | null;
    address: InvoiceAddress | null;
  };
  // `null` when the bill has no appendix rows (D5).
  usage: {
    rows: RawInvoiceUsageRow[];
    subtotals: RawInvoiceUsageSubtotal[];
  } | null;
}

async function readBillHeader(
  tx: Database,
  runId: string,
  banId: string,
): Promise<
  | {
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
    }
  | null
> {
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
    })
    .from(customerBill)
    .innerJoin(billRun, eq(billRun.billRunId, customerBill.refBillRunId))
    .innerJoin(billCycle, eq(billCycle.billCycleId, billRun.refBillCycleId))
    .innerJoin(
      billingAccount,
      eq(billingAccount.billingAccountId, customerBill.refBillingAccountId),
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
      groupGrossTotal: sql<string>`COALESCE(SUM(${customerBillLine.grossAmount}) OVER (PARTITION BY ${customerBillLine.source}), 0)::numeric(18,2)::text`,
      groupDiscountTotal: sql<string>`COALESCE(SUM(${customerBillLine.discountAmount}) OVER (PARTITION BY ${customerBillLine.source}), 0)::numeric(18,2)::text`,
      groupNetTotal: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}) OVER (PARTITION BY ${customerBillLine.source}), 0)::numeric(18,2)::text`,
    })
    .from(customerBillLine)
    .where(scope)
    .orderBy(asc(customerBillLine.lineNo));

  const [sums] = await tx
    .select({
      linesNetSum: sql<string>`COALESCE(SUM(${customerBillLine.netAmount}), 0)::numeric(18,2)::text`,
      grossTotal: sql<string>`COALESCE(SUM(${customerBillLine.grossAmount}), 0)::numeric(18,2)::text`,
      discountTotal: sql<string>`COALESCE(SUM(${customerBillLine.discountAmount}), 0)::numeric(18,2)::text`,
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
  };
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
    .innerJoin(organization, eq(organization.organizationId, partyRole.engagedParty))
    .where(eq(partyRole.partyRoleId, refPartyRoleId))
    .limit(1);
  if (!org) {
    throw new Error(
      `invoiceRenderInputRepository: no organization for party role ${refPartyRoleId}`,
    );
  }

  const contactSelect = {
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
    name: org.name,
    tradingName: org.tradingName,
    registrationNumber: org.registrationNumber,
    taxId: org.taxId,
    email: contact?.emailAddress ?? null,
    phone: contact?.phoneNumber ?? null,
    address,
  };
}

// D5 — reads the bm45 `additional_info->'appendix'` snapshot (G4 interim,
// C1) via `jsonb_to_recordset`, with `GROUP BY GROUPING SETS ((state,
// district), (state), ())` for the subtotals, so no JS money sum is
// introduced. `GROUPING(state)`/`GROUPING(district)` disambiguate a real
// `state IS NULL` ("Unmapped") row from a rolled-up grouping-set row — both
// would otherwise serialize to the same `(NULL, NULL)` pair.
async function readUsage(
  tx: Database,
  customerBillId: string,
  periodPartition: string,
): Promise<{ rows: RawInvoiceUsageRow[]; subtotals: RawInvoiceUsageSubtotal[] } | null> {
  const rowsResult = await tx.execute<{
    polygon: string;
    state: string | null;
    district: string | null;
    volume: string;
    amount: string;
    unit: string | null;
  }>(sql`
    SELECT r.polygon, r.state, r.district, r.volume::text AS volume,
           r.amount::numeric(18,2)::text AS amount, cbl.unit
    FROM billing.customer_bill_line cbl
    CROSS JOIN LATERAL jsonb_to_recordset(
      COALESCE(cbl.additional_info->'appendix', '[]'::jsonb)
    ) AS r(polygon text, state text, district text, volume text, amount text)
    WHERE cbl.ref_customer_bill_id = ${customerBillId}
      AND cbl.period_partition = ${periodPartition}
      AND cbl.additional_info IS NOT NULL
    ORDER BY r.state NULLS LAST, r.district NULLS LAST, r.polygon
  `);
  const rows = Array.from(rowsResult);
  if (rows.length === 0) return null;

  const subtotalsResult = await tx.execute<{
    state: string | null;
    district: string | null;
    state_grouped: number;
    district_grouped: number;
    subtotal: string;
  }>(sql`
    SELECT r.state, r.district,
           GROUPING(r.state) AS state_grouped,
           GROUPING(r.district) AS district_grouped,
           SUM(r.amount::numeric(18,2))::text AS subtotal
    FROM billing.customer_bill_line cbl
    CROSS JOIN LATERAL jsonb_to_recordset(
      COALESCE(cbl.additional_info->'appendix', '[]'::jsonb)
    ) AS r(polygon text, state text, district text, volume text, amount text)
    WHERE cbl.ref_customer_bill_id = ${customerBillId}
      AND cbl.period_partition = ${periodPartition}
      AND cbl.additional_info IS NOT NULL
    GROUP BY GROUPING SETS ((r.state, r.district), (r.state), ())
  `);

  const subtotals: RawInvoiceUsageSubtotal[] = Array.from(subtotalsResult).map((r) => {
    if (Number(r.state_grouped) === 1) {
      return { grain: "grand", state: null, district: null, amount: r.subtotal };
    }
    if (Number(r.district_grouped) === 1) {
      return { grain: "state", state: r.state, district: null, amount: r.subtotal };
    }
    return {
      grain: "district",
      state: r.state,
      district: r.district,
      amount: r.subtotal,
    };
  });

  return { rows, subtotals };
}

export const invoiceRenderInputRepository = {
  async read(
    tx: Database,
    { runId, banId }: { runId: string; banId: string },
  ): Promise<RawInvoiceRenderInput | null> {
    const header = await readBillHeader(tx, runId, banId);
    if (!header) return null;

    const [lineData, taxItems, doc, customer, usage] = await Promise.all([
      readLines(tx, header.customerBillId, header.periodPartition),
      customerBillTaxItemRepository.listForBill(
        tx,
        header.customerBillId,
        header.periodPartition,
      ),
      readDocument(tx, header.customerBillId, header.periodPartition),
      readCustomer(tx, header.refPartyRoleId),
      readUsage(tx, header.customerBillId, header.periodPartition),
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
      },
      run: { billRunId: header.billRunId, cycleName: header.cycleName },
      lines: lineData.lines,
      taxItems,
      document: doc,
      customer,
      usage,
    };
  },
};
