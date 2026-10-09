import type { RawInvoiceRenderInput } from "@/db/repositories/billing/invoice-render-input";
import { todayInZone } from "@/lib/timezone";
import {
  FinalInvoiceNotFoundError,
  INVOICE_USAGE_ROW_LIMIT,
  InvoiceRenderError,
  type ChargeSource,
  type InvoiceLine,
  type InvoiceLineGroup,
  type InvoiceProfile,
  type InvoiceRenderInput,
  type InvoiceUsageRow,
  type InvoiceUsageSection,
} from "@/types/billing";

// bm47-spec §Implementation §4 — pure function: no DB, no Handlebars, no
// `next/*`. Builds `InvoiceRenderInput` from the repository's raw read.

export interface BindContext {
  isDraft: boolean;
  locale: string;
  timezone: string;
  // bm49-spec §Design D4 — when the template hides the Usage annex
  // (`structure.sections.usageAnnex === false`) the usage read is skipped and
  // the over-limit/reconcile checks never run. In bm49 the only template is
  // the all-on default; bm53 derives it from the resolved version's
  // `structure.sections.usageAnnex`.
  includeUsage: boolean;
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

  const lineGroups = buildLineGroups(raw);
  const chargeSummary = lineGroups.map((g) => ({
    name: g.name,
    source: g.source,
    amount: g.subtotal,
  }));

  // D3/D4/D6 — the usage annex. When the section is hidden the read was
  // skipped (`raw.usage` is `null`): no over-limit throw, no reconcile, `usage`
  // is `null`.
  let usage: InvoiceUsageSection | null = null;
  if (ctx.includeUsage && raw.usage) {
    if (raw.usage.overLimit) {
      // D3 — fail loud (no truncation, no partial annex). The draft preview
      // surfaces the code; the final render parks the account (bm47 D10).
      throw new InvoiceRenderError(
        "INVOICE_USAGE_OVER_LIMIT",
        `customer_bill ${raw.bill.customerBillId}: ${raw.usage.rowCount} billed usage rows exceed the ${INVOICE_USAGE_ROW_LIMIT}-row annex limit`,
        { rowCount: raw.usage.rowCount, limit: INVOICE_USAGE_ROW_LIMIT },
      );
    }
    usage = buildUsageSection(raw.usage);

    // D6 — the annex's grand total must equal `Σ rated_amount` over the bill's
    // USAGE lines (both `::text` from the same snapshot). A `null` grand total
    // (no billed rows) and a `"0.00"` rated total are the matching empty case.
    const annexTotal = grandTotal(raw.usage) ?? "0.00";
    if (annexTotal !== raw.bill.usageRatedTotal) {
      throw new InvoiceRenderError(
        "INVOICE_RECONCILIATION_FAILED",
        `customer_bill ${raw.bill.customerBillId}: usage annex total ${annexTotal} does not equal USAGE rated_amount ${raw.bill.usageRatedTotal}`,
        {
          detail: "usage",
          annexTotal,
          usageRatedTotal: raw.bill.usageRatedTotal,
          customerBillId: raw.bill.customerBillId,
        },
      );
    }
  }

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

// D5 — the rows arrive already ordered `state ASC NULLS LAST, district ASC
// NULLS LAST, start_datetime, udr_id`, so structuring here preserves that
// order (the "Unassigned region" group lands last) and does NO money
// arithmetic — every subtotal was summed in SQL (`listBilledUsageForInvoice`'s
// GROUPING SETS). Labels: `state ?? 'Unassigned region'`, `district ?? '—'`.
type UsageRead = Extract<RawInvoiceRenderInput["usage"], { overLimit: false }>;
type UsageGroup = UsageRead["groups"][number];

// A NULL-safe composite key so a real `state/district IS NULL` group is never
// confused with a non-null one.
function groupKey(state: string | null, district: string | null): string {
  return `${state ?? " "}|${district ?? " "}`;
}

function grandTotal(usage: UsageRead): string | null {
  return usage.groups.find((g) => g.gState === 1)?.amount ?? null;
}

function buildUsageSection(usage: UsageRead): InvoiceUsageSection | null {
  if (usage.rows.length === 0) return null;

  const grand = usage.groups.find((g) => g.gState === 1);
  const stateGroups = new Map<string | null, UsageGroup>();
  const districtGroups = new Map<string, UsageGroup>();
  for (const g of usage.groups) {
    if (g.gState === 1) continue;
    if (g.gDistrict === 1) stateGroups.set(g.state, g);
    else districtGroups.set(groupKey(g.state, g.district), g);
  }

  const stateOrder: (string | null)[] = [];
  const byState = new Map<
    string | null,
    Map<string | null, InvoiceUsageRow[]>
  >();
  for (const row of usage.rows) {
    if (!byState.has(row.state)) {
      byState.set(row.state, new Map());
      stateOrder.push(row.state);
    }
    const districts = byState.get(row.state)!;
    if (!districts.has(row.district)) districts.set(row.district, []);
    districts.get(row.district)!.push({
      startDate: row.startDate,
      cell: row.cell,
      udrType: row.udrType,
      quantity: row.quantity,
      unit: row.unit,
      amount: row.amount,
    });
  }

  const states = stateOrder.map((state) => {
    const sg = stateGroups.get(state);
    const districts = byState.get(state)!;
    return {
      state,
      label: state ?? "Unassigned region",
      rowCount: sg?.rowCount ?? 0,
      amount: sg?.amount ?? "0.00",
      quantity: sg?.quantity ?? null,
      unit: sg?.unit ?? null,
      districts: Array.from(districts.entries()).map(([district, rows]) => {
        const dg = districtGroups.get(groupKey(state, district));
        return {
          district,
          label: district ?? "—",
          rowCount: dg?.rowCount ?? rows.length,
          amount: dg?.amount ?? "0.00",
          quantity: dg?.quantity ?? null,
          unit: dg?.unit ?? null,
          rows,
        };
      }),
    };
  });

  return {
    rowCount: usage.rows.length,
    totalAmount: grand?.amount ?? "0.00",
    totalQuantity: grand?.quantity ?? null,
    unit: grand?.unit ?? null,
    states,
  };
}

// The posting instant's calendar day in the app timezone, not UTC — a
// posting at 00:30 MYT belongs to that local day, not the previous UTC one.
function toDateOnly(date: Date, timeZone: string): string {
  return todayInZone(date, timeZone);
}
