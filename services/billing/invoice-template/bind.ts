import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { todayInZone } from "@/lib/timezone";
import {
  FinalInvoiceNotFoundError,
  INVOICE_USAGE_ROW_LIMIT,
  InvoiceRenderError,
  type InvoiceCapacityRegion,
  type InvoiceProfile,
  type InvoiceRenderInput,
} from "@/types/billing";

// bm47-spec §Implementation §4 — pure function: no DB, no Handlebars, no
// `next/*`. Builds `InvoiceRenderInput` from the repository's raw read.

export interface BindContext {
  isDraft: boolean;
  locale: string;
  timezone: string;
  // The final render's requested invoice number (D1's "the binder takes the
  // number from billing.document and asserts it equals invoiceNo" — render-
  // invoice.ts §6). Unused on a draft bind.
  invoiceNo?: string;
  // bm53-spec §Design D5 — the resolved layout code/version and generated
  // version (`resolveTemplate`), bound as `template.*`.
  template: InvoiceRenderInput["template"];
  // bm53-spec §Design D3/D5 — the resolved company profile with its verified
  // logo inlined, or `null` when none resolves (G15 A: issuer/payment
  // blocks hidden).
  profile: InvoiceProfile | null;
  // bm72-spec §Design (D19, Inv #41/#51) — the footnote of the structure in
  // use: the editor's unsaved structure in a preview, else the resolved
  // generated version's (stamped or family), so a posted bill always prints
  // the footnote of the version it was posted under.
  footnote: string[];
}

export function bind(
  raw: RawInvoiceRenderInput,
  ctx: BindContext,
): InvoiceRenderInput {
  // bm70-spec §Design "Binder guards" (D42, Inv #55) — fail loud, never
  // print. They run before the D2 outcome below is used.
  assertSummaryGuards(raw);

  // D2 — reconcile FIRST, before anything else is built. Both sides are
  // `numeric(18,2)::text` from the same snapshot, so a plain string compare
  // is exact (no float, no `services/accounts/money.ts` needed here — that
  // module is for arithmetic, this is an equality check).
  if (raw.bill.linesNetSum !== raw.bill.subtotal) {
    throw new InvoiceRenderError(
      "INVOICE_RECONCILIATION_FAILED",
      `customer_bill ${raw.bill.customerBillId}: lines net sum ${raw.bill.linesNetSum} does not equal subtotal ${raw.bill.subtotal}`,
      {
        subtotal: raw.bill.subtotal,
        linesNetSum: raw.bill.linesNetSum,
        customerBillId: raw.bill.customerBillId,
      },
    );
  }

  // A final render needs its posted `billing.document` row — without it the
  // bound invoice would carry no number or date under a "TAX INVOICE" title.
  // render-invoice.ts §6 — when the caller names the requested invoice
  // number, the bound document id must equal it; a mismatch indicates a
  // wiring bug, never a data problem, and is a typed render failure (D10).
  if (!ctx.isDraft) {
    if (!raw.document) {
      throw new FinalInvoiceNotFoundError(
        raw.run.billRunId,
        raw.bill.billingAccountId,
      );
    }
    if (
      ctx.invoiceNo !== undefined &&
      raw.document.documentId !== ctx.invoiceNo
    ) {
      throw new InvoiceRenderError(
        "INVOICE_DOCUMENT_MISMATCH",
        `bound document ${raw.document.documentId} does not match the requested invoice number ${ctx.invoiceNo}`,
        { documentId: raw.document.documentId, invoiceNo: ctx.invoiceNo },
      );
    }
  }

  // bm71-spec §Design "Guards" — the detail pages, guarded before render.
  const regionsByType = buildCapacityDetail(raw);

  return {
    template: ctx.template,
    company: ctx.profile?.company ?? null,
    payment: ctx.profile?.payment ?? null,
    invoice: {
      number: ctx.isDraft ? null : (raw.document?.documentId ?? null),
      isDraft: ctx.isDraft,
      date:
        !ctx.isDraft && raw.document?.postingDate
          ? toDateOnly(raw.document.postingDate, ctx.timezone)
          : null,
      periodStart: raw.bill.billingPeriodStart,
      periodEnd: raw.bill.billingPeriodEnd,
      dueDate: raw.bill.paymentDueDate,
      // D5 — "billing-account override ?? profile ?? null": the billing
      // account carries no payment-terms column today, so there is no override
      // to read; the profile's default applies.
      paymentTermsDays: ctx.profile?.paymentTermsDays ?? null,
      currency: raw.bill.currency,
      billRunId: raw.run.billRunId,
      cycleName: raw.run.cycleName,
      billRef: raw.bill.customerBillId,
      poRef: null,
      contractRef: null,
    },
    customer: {
      billingAccountId: raw.bill.billingAccountId,
      recipientName: raw.customer.recipientName,
      name: raw.customer.name,
      tradingName: raw.customer.tradingName,
      registrationNo: raw.customer.registrationNumber,
      tin: raw.customer.taxId,
      sstRegNo: null,
      address: raw.customer.address,
      email: raw.customer.email,
      phone: raw.customer.phone,
    },
    totals: {
      grossTotal: raw.bill.grossTotal,
      discountTotal: raw.bill.discountTotal,
      subtotalExclTax: raw.bill.subtotal,
      taxTotal: raw.bill.taxTotal,
      // bm72 (D22, P10) — the last page's Total Amount = Σ per-type Utilised,
      // summed in SQL; it is never the amount due nor the bill total (v1 pins
      // the name). A CSV column or layout wanting the invoice total reads
      // `amountDue`.
      totalAmount: raw.bill.utilisedTotal,
      // Inv #50 — "current charges only"; no balance brought forward (R2).
      amountDue: raw.bill.totalAmount,
      // bm70 (D14) — "Total charges" is the bill's subtotal.
      totalCharges: raw.bill.subtotal,
      adjustments: raw.bill.adjustments,
      otherChargesSubTotal: raw.bill.otherChargesSubTotal,
    },
    taxes: raw.taxItems,
    // bm70 (D15) — 0% this phase: no tax item → "0".
    taxRateLabel: raw.taxItems[0]?.rate ?? "0",
    serviceTypes: raw.serviceTypes.map((t) => ({
      offeringId: t.offeringId,
      label: t.label,
      utilised: t.utilised,
      unutilised: t.unutilised,
      total: t.total,
      // A type with a capacity line but no claimed row (0 Mbps, only the
      // commitment floor) prints "No utilised capacity this period."
      regions: regionsByType.get(t.offeringId) ?? [],
    })),
    otherCharges: raw.otherCharges,
    footnote: ctx.footnote,
    isDraft: ctx.isDraft,
    locale: ctx.locale,
    timezone: ctx.timezone,
  };
}

// bm70-spec §Design "Binder guards" — the three page-1 conditions, in order.
// Every input is a SQL flag or a SQL `numeric(18,2)::text` sum; the third is
// a plain string compare (no TypeScript arithmetic, General rule 6).
function assertSummaryGuards(raw: RawInvoiceRenderInput): void {
  const banId = raw.bill.billingAccountId;
  for (const t of raw.serviceTypes) {
    if (t.missingRated) {
      throw new InvoiceRenderError(
        "INVOICE_RECONCILIATION_FAILED",
        `customer_bill ${raw.bill.customerBillId}: a capacity line of ${t.offeringId} has no rated_amount`,
        {
          banId,
          offeringId: t.offeringId,
          reason: "CAPACITY_LINE_WITHOUT_RATED_AMOUNT",
        },
      );
    }
  }
  for (const t of raw.serviceTypes) {
    if (t.negativeUtilised) {
      throw new InvoiceRenderError(
        "INVOICE_NEGATIVE_UTILISED",
        `customer_bill ${raw.bill.customerBillId}: Utilised ${t.utilised} for ${t.offeringId} is negative`,
        { banId, offeringId: t.offeringId, utilised: t.utilised },
      );
    }
  }
  if (raw.bill.summaryBlocksSum !== raw.bill.linesNetSum) {
    throw new InvoiceRenderError(
      "INVOICE_RECONCILIATION_FAILED",
      `customer_bill ${raw.bill.customerBillId}: summary blocks ${raw.bill.summaryBlocksSum} do not add up to the lines net sum ${raw.bill.linesNetSum}`,
      { banId, reason: "SUMMARY_BLOCKS_DO_NOT_ADD_UP" },
    );
  }
}

// bm71-spec §Design "Guards" (D29/D37, Inv #56) — the four detail guards,
// then the detail pages keyed by offering id. The rows arrive in the D21
// order (type label, region label with "Unassigned region" last, polygon
// id), so grouping here keeps that order. No money arithmetic: every Sub
// Total and per-type total was summed in SQL, and the reconciliation is a
// plain string compare of SQL sums (General rule 6). The first failing row
// is reported; nothing is printed blank (General rule 7).
function buildCapacityDetail(
  raw: RawInvoiceRenderInput,
): Map<string, InvoiceCapacityRegion[]> {
  const banId = raw.bill.billingAccountId;
  const detail = raw.capacityDetail;
  if (detail.overLimit) {
    throw new InvoiceRenderError(
      "INVOICE_USAGE_OVER_LIMIT",
      `customer_bill ${raw.bill.customerBillId}: ${detail.rowCount} capacity detail rows exceed the ${INVOICE_USAGE_ROW_LIMIT}-row limit`,
      { banId, rowCount: detail.rowCount },
    );
  }

  // Each type's Sub Totals by region label, and each type's detail total.
  const subTotals = new Map<string, Map<string, string>>();
  const typeTotals = new Map<string, string>();
  for (const g of detail.groups) {
    if (g.gRegion === 1) {
      typeTotals.set(g.offeringId, g.amount);
    } else if (g.regionLabel !== null) {
      const byRegion = subTotals.get(g.offeringId) ?? new Map<string, string>();
      byRegion.set(g.regionLabel, g.amount);
      subTotals.set(g.offeringId, byRegion);
    }
  }

  const regionsByType = new Map<string, InvoiceCapacityRegion[]>();
  for (const row of detail.rows) {
    if (row.polygonId === null) {
      throw polygonDataMissing(raw, row.udrId, "polygon_id");
    }
    if (!row.resourceOk) {
      throw polygonDataMissing(raw, row.udrId, "udr_resource");
    }
    const regions = regionsByType.get(row.offeringId) ?? [];
    regionsByType.set(row.offeringId, regions);
    let region = regions.at(-1);
    if (region?.label !== row.regionLabel) {
      region = {
        label: row.regionLabel,
        rows: [],
        subTotal: subTotals.get(row.offeringId)?.get(row.regionLabel) ?? "0.00",
      };
      regions.push(region);
    }
    region.rows.push({
      polygonStartDate: row.polygonStartDate,
      polygonName: row.polygonId,
      capacityMbps: row.capacityMbps,
      ratePerMbps: row.ratePerMbps,
      amount: row.amount,
    });
  }

  // D37 — each type's detail total equals Σ `rated_amount` of its capacity
  // lines; a type with no claimed row has no detail total ("0.00").
  for (const t of raw.serviceTypes) {
    const detailTotal = typeTotals.get(t.offeringId) ?? "0.00";
    if (detailTotal !== t.ratedTotal) {
      throw new InvoiceRenderError(
        "INVOICE_RECONCILIATION_FAILED",
        `customer_bill ${raw.bill.customerBillId}: detail total ${detailTotal} for ${t.offeringId} does not equal its rated_amount ${t.ratedTotal}`,
        {
          banId,
          offeringId: t.offeringId,
          reason: "DETAIL_DOES_NOT_MATCH_RATED_AMOUNT",
        },
      );
    }
  }

  return regionsByType;
}

function polygonDataMissing(
  raw: RawInvoiceRenderInput,
  udrRatedId: string,
  missing: "polygon_id" | "udr_resource",
): InvoiceRenderError {
  return new InvoiceRenderError(
    "INVOICE_POLYGON_DATA_MISSING",
    `customer_bill ${raw.bill.customerBillId}: billed record ${udrRatedId} has no ${missing === "polygon_id" ? "polygon_id= segment in udr_key" : "well-formed udr_resource"}`,
    { banId: raw.bill.billingAccountId, udrRatedId, missing },
  );
}

// The posting instant's calendar day in the app timezone, not UTC — a
// posting at 00:30 MYT belongs to that local day, not the previous UTC one.
function toDateOnly(date: Date, timeZone: string): string {
  return todayInZone(date, timeZone);
}
