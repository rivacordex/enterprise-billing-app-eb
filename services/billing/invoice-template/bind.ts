import type {
  RawInvoiceRenderInput,
  RawInvoiceUsageSubtotal,
} from "@/db/repositories/billing/invoice-render-input";
import { todayInZone } from "@/lib/timezone";
import {
  FinalInvoiceNotFoundError,
  InvoiceRenderError,
  type ChargeSource,
  type InvoiceLine,
  type InvoiceLineGroup,
  type InvoiceRenderInput,
  type InvoiceUsageSection,
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
}

// D3 — fixed order; a group with no lines is omitted.
const GROUP_ORDER: { source: ChargeSource; name: string }[] = [
  { source: "RECURRING", name: "Recurring charges" },
  { source: "USAGE", name: "Usage charges" },
  { source: "OCC", name: "Other charges" },
];

export function bind(
  raw: RawInvoiceRenderInput,
  ctx: BindContext,
): InvoiceRenderInput {
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
      throw new FinalInvoiceNotFoundError(raw.run.billRunId, raw.bill.billingAccountId);
    }
    if (ctx.invoiceNo !== undefined && raw.document.documentId !== ctx.invoiceNo) {
      throw new InvoiceRenderError(
        "INVOICE_DOCUMENT_MISMATCH",
        `bound document ${raw.document.documentId} does not match the requested invoice number ${ctx.invoiceNo}`,
        { documentId: raw.document.documentId, invoiceNo: ctx.invoiceNo },
      );
    }
  }

  const lineGroups = buildLineGroups(raw);
  const chargeSummary = lineGroups.map((g) => ({
    name: g.name,
    source: g.source,
    amount: g.subtotal,
  }));
  const usage = buildUsageSection(raw.usage);

  return {
    template: { layoutCode: "INVTPL-STD-A4", layoutVersion: 1, version: null },
    company: null,
    payment: null,
    invoice: {
      number: ctx.isDraft ? null : raw.document?.documentId ?? null,
      isDraft: ctx.isDraft,
      date:
        !ctx.isDraft && raw.document?.postingDate
          ? toDateOnly(raw.document.postingDate, ctx.timezone)
          : null,
      periodStart: raw.bill.billingPeriodStart,
      periodEnd: raw.bill.billingPeriodEnd,
      dueDate: raw.bill.paymentDueDate,
      currency: raw.bill.currency,
      billRunId: raw.run.billRunId,
      cycleName: raw.run.cycleName,
      billRef: raw.bill.customerBillId,
      poRef: null,
      contractRef: null,
    },
    customer: {
      billingAccountId: raw.bill.billingAccountId,
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
      totalAmount: raw.bill.totalAmount,
      // Inv #50 — "current charges only"; no balance brought forward (R2).
      amountDue: raw.bill.totalAmount,
    },
    taxes: raw.taxItems,
    chargeSummary,
    lineGroups,
    usage,
    isDraft: ctx.isDraft,
    locale: ctx.locale,
    timezone: ctx.timezone,
  };
}

function buildLineGroups(raw: RawInvoiceRenderInput): InvoiceLineGroup[] {
  const bySource = new Map<ChargeSource, RawInvoiceRenderInput["lines"]>();
  for (const line of raw.lines) {
    const arr = bySource.get(line.source) ?? [];
    arr.push(line);
    bySource.set(line.source, arr);
  }

  const groups: InvoiceLineGroup[] = [];
  for (const { source, name } of GROUP_ORDER) {
    const lines = bySource.get(source);
    if (!lines || lines.length === 0) continue;
    const first = lines[0]!;
    groups.push({
      name,
      source,
      grossTotal: first.groupGrossTotal,
      discountTotal: first.groupDiscountTotal,
      subtotal: first.groupNetTotal,
      lines: lines.map((line) => toInvoiceLine(line, raw.bill)),
    });
  }
  return groups;
}

function toInvoiceLine(
  line: RawInvoiceRenderInput["lines"][number],
  bill: RawInvoiceRenderInput["bill"],
): InvoiceLine {
  return {
    lineNo: line.lineNo,
    source: line.source,
    description: line.description ?? line.refProductOfferingId,
    productOfferingId: line.refProductOfferingId,
    udrType: line.udrType,
    udrCount: line.udrCount,
    periodStart: bill.billingPeriodStart,
    periodEnd: bill.billingPeriodEnd,
    quantity: line.quantity ?? line.snapshotQuantity,
    unit: line.unit,
    unitPrice: line.snapshotUnitPrice,
    grossAmount: line.grossAmount,
    discountAmount: line.discountAmount,
    netAmount: line.netAmount,
    discountNote: line.discountRate ? `Discount ${line.discountRate}%` : null,
  };
}

// D5 — the rows are already ordered `state, district, polygon` by the
// repository; grouping here is pure structuring (no money arithmetic — every
// subtotal was summed in SQL, `readUsage`). The "Unmapped (no ratecard
// entry)" group (a real `state IS NULL` row) sorts last.
function buildUsageSection(
  rawUsage: RawInvoiceRenderInput["usage"],
): InvoiceUsageSection | null {
  if (!rawUsage || rawUsage.rows.length === 0) return null;

  const districtSubtotal = (state: string | null, district: string | null): string =>
    findSubtotal(rawUsage.subtotals, "district", state, district);
  const stateSubtotal = (state: string | null): string =>
    findSubtotal(rawUsage.subtotals, "state", state, null);
  const grandTotal = findSubtotal(rawUsage.subtotals, "grand", null, null);

  const units = new Set(
    rawUsage.rows.map((r) => r.unit).filter((u): u is string => u !== null),
  );
  const unit = units.size === 1 ? Array.from(units)[0]! : null;

  type UsageRow = NonNullable<RawInvoiceRenderInput["usage"]>["rows"][number];
  const stateOrder: (string | null)[] = [];
  const byState = new Map<string | null, Map<string | null, UsageRow[]>>();
  for (const row of rawUsage.rows) {
    if (!byState.has(row.state)) {
      byState.set(row.state, new Map());
      stateOrder.push(row.state);
    }
    const districts = byState.get(row.state)!;
    if (!districts.has(row.district)) districts.set(row.district, []);
    districts.get(row.district)!.push(row);
  }

  stateOrder.sort((a, b) => (a === null ? 1 : b === null ? -1 : 0));

  const states = stateOrder.map((state) => {
    const districts = byState.get(state)!;
    return {
      state,
      label: state ?? "Unmapped (no ratecard entry)",
      subtotalAmount: stateSubtotal(state),
      districts: Array.from(districts.entries()).map(([district, rows]) => ({
        district,
        label: district ?? "Unmapped (no ratecard entry)",
        subtotalAmount: districtSubtotal(state, district),
        rows: rows.map((r) => ({
          polygon: r.polygon,
          volume: r.volume,
          unit: r.unit ?? "",
          amount: r.amount,
        })),
      })),
    };
  });

  return {
    unit,
    states,
    totalAmount: grandTotal,
    rowCount: rawUsage.rows.length,
  };
}

function findSubtotal(
  subtotals: RawInvoiceUsageSubtotal[],
  grain: RawInvoiceUsageSubtotal["grain"],
  state: string | null,
  district: string | null,
): string {
  const match = subtotals.find(
    (s) => s.grain === grain && s.state === state && s.district === district,
  );
  return match?.amount ?? "0.00";
}

// The posting instant's calendar day in the app timezone, not UTC — a
// posting at 00:30 MYT belongs to that local day, not the previous UTC one.
function toDateOnly(date: Date, timeZone: string): string {
  return todayInZone(date, timeZone);
}
