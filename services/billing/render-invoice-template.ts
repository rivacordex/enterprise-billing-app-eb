import { formatCalendarDate, formatCurrency } from "@/lib/formatters";
import { sum as sumMoney } from "@/services/accounts/money";
import type { InvoiceUsageAppendixRow } from "@/types/billing";

// bm18-spec §Design "One throwaway template" — a single hand-built HTML/CSS
// invoice template, deliberately NOT the production `bill_template_version`/
// `bill_format`/i18n system (D18). Split out from render-invoice.ts (the
// DB/Chromium orchestrator) so this stays pure — no DB/Next.js/Playwright
// import — and unit-testable without a database or browser (code-standards
// general §2.7 idiom).

export interface DraftInvoiceBill {
  billingAccountId: string;
  accountName: string;
  currency: string;
  billingPeriodStart: string;
  billingPeriodEnd: string;
  subtotal: string;
  taxTotal: string;
  totalAmount: string;
  paymentDueDate: string;
}

export interface DraftInvoiceTaxItem {
  category: string;
  rate: string;
  amount: string;
}

export interface DraftInvoiceLine {
  udrId: string;
  udrType: string;
  startDatetime: Date;
  endDatetime: Date;
  udrUsageQuantity: string;
  udrUsageUnit: string;
  udrRatedPrice: string;
  udrCurrency: string;
}

export interface DraftInvoiceRun {
  billRunId: string;
  cycleName: string;
}

export interface BuildDraftInvoiceHtmlParams {
  bill: DraftInvoiceBill;
  taxItems: DraftInvoiceTaxItem[];
  lines: DraftInvoiceLine[];
  run: DraftInvoiceRun;
  locale: string;
}

// bm45-spec §Implementation §2/§3 — one per-polygon appendix row shaped for
// render: the stored `InvoiceUsageAppendixRow` (from `CapacityCalcTrace.
// appendix`, no `unit` field) plus the capacity line's own `unit`, attached
// by the orchestrator (`render-invoice.ts`) when it shapes the template
// param.
export interface InvoiceAppendixRenderRow extends InvoiceUsageAppendixRow {
  unit: string;
}

// bm19-spec §Design "Final render = draft renderer, no watermark, real
// number" — the final (posted) invoice reuses this same template/params
// shape, only substituting the real `INV…` number for the "pending
// posting" placeholder and dropping the watermark entirely. bm45-spec
// §Implementation §3/§Design D5 — `appendix` is optional and FINAL-ONLY (the
// draft params type below carries no such field at all); rendered only when
// present and non-empty.
export interface BuildFinalInvoiceHtmlParams extends BuildDraftInvoiceHtmlParams {
  invoiceNumber: string;
  appendix?: InvoiceAppendixRenderRow[] | undefined;
}

// Draft ≠ a valid invoice (Design): no invoice number exists pre-posting
// (the number IS `document_id`, consumed only at posting), so the number
// field always reads "— pending posting —" and a diagonal watermark repeats
// on every page. Money renders through the shared `formatCurrency`, dates
// through `formatCalendarDate` — no inline `toFixed`, no client-side sum
// (spec §Implementation §2). Every DB-sourced string (account/cycle names
// are free text) is escaped before interpolation.
export function buildDraftInvoiceHtml(
  params: BuildDraftInvoiceHtmlParams,
): string {
  return renderInvoiceHtml(params, { invoiceNumber: null });
}

// bm19-spec §Implementation §3 — the final, posted invoice: the real
// `INV…` document id in place of the pending-posting placeholder, and no
// DRAFT/PRO-FORMA watermark or preview-only subtitle/footer (this IS the
// issued record, ui-context §6c). Same template/CSS/money-and-date
// formatting as the draft otherwise (Design "Final render = draft renderer,
// no watermark, real number").
export function buildFinalInvoiceHtml({
  invoiceNumber,
  ...params
}: BuildFinalInvoiceHtmlParams): string {
  return renderInvoiceHtml(params, { invoiceNumber });
}

function renderInvoiceHtml(
  {
    bill,
    taxItems,
    lines,
    run,
    locale,
    appendix,
  }: BuildDraftInvoiceHtmlParams & {
    appendix?: InvoiceAppendixRenderRow[] | undefined;
  },
  { invoiceNumber }: { invoiceNumber: string | null },
): string {
  const isDraft = invoiceNumber === null;
  const invoiceNumberDisplay =
    invoiceNumber === null ? "— pending posting —" : escapeHtml(invoiceNumber);
  const lineRows = lines
    .map((line) => {
      const period = `${formatCalendarDate(toDateOnly(line.startDatetime))} – ${formatCalendarDate(toDateOnly(line.endDatetime))}`;
      return `<tr>
        <td>${escapeHtml(period)}</td>
        <td>${escapeHtml(line.udrType)}</td>
        <td class="num">${escapeHtml(line.udrUsageQuantity)} ${escapeHtml(line.udrUsageUnit)}</td>
        <td class="num">${escapeHtml(formatCurrency(line.udrRatedPrice, line.udrCurrency, locale))}</td>
      </tr>`;
    })
    .join("");

  const taxRows = taxItems
    .map(
      (item) => `<tr>
        <td colspan="3">${escapeHtml(item.category)} @ ${escapeHtml(item.rate)}%</td>
        <td class="num">${escapeHtml(formatCurrency(item.amount, bill.currency, locale))}</td>
      </tr>`,
    )
    .join("");

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8" />
<style>
  @page { size: A4; margin: 0; }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    font-family: Arial, Helvetica, sans-serif;
    color: #1a1a1a;
    font-size: 12px;
  }
  /* Fixed-position elements repeat on every printed page in Chromium's print
     engine — the mechanism this diagonal watermark relies on to appear on
     every page without a header/footer template per page. Kept behind the
     opaque .sheet card (z-index, solid background) so it never shows through
     printed figures — ui-context §6c: the watermark must never degrade the
     legibility of the totals it sits near. */
  .watermark {
    position: fixed;
    inset: 0;
    z-index: 0;
    display: flex;
    align-items: center;
    justify-content: center;
    overflow: hidden;
    pointer-events: none;
  }
  .watermark span {
    display: block;
    transform: rotate(-32deg);
    font-size: 30px;
    font-weight: 700;
    letter-spacing: 2px;
    color: #d92d2d;
    opacity: 0.14;
    white-space: nowrap;
    line-height: 3.4;
  }
  .sheet {
    position: relative;
    z-index: 1;
    background: #ffffff;
    padding: 24px 0;
  }
  h1 { font-size: 18px; margin: 0 0 4px; }
  .subtitle { color: #6a7283; margin: 0 0 20px; font-size: 12px; }
  .meta {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 8px 24px;
    margin-bottom: 20px;
    padding-bottom: 16px;
    border-bottom: 1px solid #e5e7eb;
  }
  .meta div span.label { display: block; color: #6a7283; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; }
  .meta div span.value { font-size: 13px; font-weight: 600; }
  table { width: 100%; border-collapse: collapse; margin-top: 8px; }
  th { text-align: left; font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6a7283; border-bottom: 1px solid #e5e7eb; padding: 6px 4px; }
  td { padding: 6px 4px; border-bottom: 1px solid #f1f2f4; font-variant-numeric: tabular-nums; }
  td.num, th.num { text-align: right; }
  tfoot td { border-bottom: none; padding-top: 8px; }
  tfoot tr.total td { font-weight: 700; font-size: 13px; border-top: 1px solid #1a1a1a; padding-top: 8px; }
  .footer-note { margin-top: 28px; font-size: 10px; color: #6a7283; }
  /* bm45-spec §Implementation §3 / ui-context §6d — the per-polygon usage
     appendix. Reuses the shared table/tabular-nums rules above; no new
     token. .section-label is the state/"Unmapped" heading (--text-overline
     shape: uppercase, letter-spaced, muted); .unmapped-label recolors it
     into the Info family (informational, never danger) per ui-context §6d. */
  .appendix { margin-top: 32px; page-break-inside: auto; }
  .appendix h2 { font-size: 14px; margin: 0 0 12px; border-top: 1px solid #1a1a1a; padding-top: 16px; }
  .appendix-state { margin-bottom: 16px; }
  .section-label { font-size: 10px; text-transform: uppercase; letter-spacing: 0.05em; color: #6a7283; margin: 12px 0 4px; }
  .unmapped-label { color: #0c4084; }
  table.appendix-district { margin-top: 4px; }
  table.appendix-district caption { text-align: left; font-size: 11px; font-weight: 600; color: #353b46; padding: 4px; }
  table.appendix-subtotal, table.appendix-grand-total { margin-top: 0; }
  tr.subtotal td { font-weight: 600; border-top: 1px solid #e5e7eb; }
</style>
</head>
<body>
  ${
    isDraft
      ? `<div class="watermark" aria-hidden="true">
    <span>DRAFT&nbsp;&middot;&nbsp;PRO-FORMA&nbsp;&middot;&nbsp;NOT&nbsp;A&nbsp;VALID&nbsp;INVOICE<br />DRAFT&nbsp;&middot;&nbsp;PRO-FORMA&nbsp;&middot;&nbsp;NOT&nbsp;A&nbsp;VALID&nbsp;INVOICE<br />DRAFT&nbsp;&middot;&nbsp;PRO-FORMA&nbsp;&middot;&nbsp;NOT&nbsp;A&nbsp;VALID&nbsp;INVOICE</span>
  </div>`
      : ""
  }
  <div class="sheet">
    ${
      isDraft
        ? `<h1>PRO-FORMA — Draft Invoice</h1>
    <p class="subtitle">Preview only. This document has not been issued and is not a valid tax invoice.</p>`
        : `<h1>Invoice</h1>
    <p class="subtitle">This is the final invoice issued for this billing period.</p>`
    }

    <div class="meta">
      <div><span class="label">Invoice #</span><span class="value">${invoiceNumberDisplay}</span></div>
      <div><span class="label">Bill run</span><span class="value">${escapeHtml(run.billRunId)} (${escapeHtml(run.cycleName)})</span></div>
      <div><span class="label">Billing account</span><span class="value">${escapeHtml(bill.accountName)} (${escapeHtml(bill.billingAccountId)})</span></div>
      <div><span class="label">Billing period</span><span class="value">${escapeHtml(formatCalendarDate(bill.billingPeriodStart))} – ${escapeHtml(formatCalendarDate(bill.billingPeriodEnd))}</span></div>
      <div><span class="label">${isDraft ? "Indicative due date" : "Due date"}</span><span class="value">${escapeHtml(formatCalendarDate(bill.paymentDueDate))}</span></div>
    </div>

    <table>
      <thead>
        <tr>
          <th>Period</th>
          <th>Description</th>
          <th class="num">Usage</th>
          <th class="num">Amount</th>
        </tr>
      </thead>
      <tbody>
        ${lineRows || `<tr><td colspan="4">No claimed charge lines for this account yet.</td></tr>`}
      </tbody>
      <tfoot>
        <tr><td colspan="3">Subtotal</td><td class="num">${escapeHtml(formatCurrency(bill.subtotal, bill.currency, locale))}</td></tr>
        ${taxRows}
        <tr class="total"><td colspan="3">${isDraft ? "Total (indicative)" : "Total due"}</td><td class="num">${escapeHtml(formatCurrency(bill.totalAmount, bill.currency, locale))}</td></tr>
      </tfoot>
    </table>

    ${
      !isDraft && appendix && appendix.length > 0
        ? buildAppendixHtml(appendix, bill.currency, locale)
        : ""
    }

    <p class="footer-note">
      ${
        isDraft
          ? "This is a computer-generated PRO-FORMA preview rendered on demand for internal review. It carries no invoice number, is never stored, and must not be sent to or relied upon by the customer."
          : "This is a computer-generated final invoice, issued and stored as the record of charge for this billing period."
      }
    </p>
  </div>
</body>
</html>`;
}

// bm45-spec §Implementation §3/§Design D3 — the per-polygon usage appendix,
// grouped state → district → polygon (ui-context §6d). Final-only and
// present-only (callers gate on `!isDraft && appendix.length > 0`). Money
// subtotals are summed via `services/accounts/money.ts` (code-standards
// §2.3 — never `Number()`/`reduce(+)` on a money string); `volume` is
// display-only text, never summed. A card-missing polygon (`state === null`)
// is collected into a trailing "Unmapped" group (D3), flagged in the Info
// family per ui-context §6d — informational, never danger.
function buildAppendixHtml(
  appendix: InvoiceAppendixRenderRow[],
  currency: string,
  locale: string,
): string {
  const mapped = appendix.filter((row) => row.state !== null);
  const unmapped = appendix.filter((row) => row.state === null);

  const stateOrder: string[] = [];
  const byState = new Map<string, Map<string, InvoiceAppendixRenderRow[]>>();
  for (const row of mapped) {
    const state = row.state as string;
    const district = row.district ?? "—";
    if (!byState.has(state)) {
      byState.set(state, new Map());
      stateOrder.push(state);
    }
    const districts = byState.get(state)!;
    if (!districts.has(district)) districts.set(district, []);
    districts.get(district)!.push(row);
  }

  const stateSections = stateOrder
    .map((state) =>
      buildAppendixStateSection(state, byState.get(state)!, currency, locale),
    )
    .join("");

  const unmappedSection =
    unmapped.length > 0
      ? buildAppendixUnmappedSection(unmapped, currency, locale)
      : "";

  const grandTotal = sumMoney(...appendix.map((row) => row.amount));

  return `<div class="appendix">
    <h2>Usage appendix — per-polygon detail</h2>
    ${stateSections}
    ${unmappedSection}
    <table class="appendix-grand-total">
      <tfoot>
        <tr class="total"><td>Total usage appendix</td><td class="num">${escapeHtml(formatCurrency(grandTotal, currency, locale))}</td></tr>
      </tfoot>
    </table>
  </div>`;
}

function buildAppendixStateSection(
  state: string,
  districts: Map<string, InvoiceAppendixRenderRow[]>,
  currency: string,
  locale: string,
): string {
  const districtSections = Array.from(districts.entries())
    .map(([district, rows]) =>
      buildAppendixDistrictTable(district, rows, currency, locale),
    )
    .join("");
  const stateRows = Array.from(districts.values()).flat();
  const stateSubtotal = sumMoney(...stateRows.map((row) => row.amount));

  return `<div class="appendix-state">
    <p class="section-label">${escapeHtml(state)}</p>
    ${districtSections}
    <table class="appendix-subtotal">
      <tfoot>
        <tr class="subtotal"><td colspan="2">State subtotal</td><td class="num">${escapeHtml(formatCurrency(stateSubtotal, currency, locale))}</td></tr>
      </tfoot>
    </table>
  </div>`;
}

function buildAppendixDistrictTable(
  district: string,
  rows: InvoiceAppendixRenderRow[],
  currency: string,
  locale: string,
): string {
  const polygonRows = rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.polygon)}</td>
        <td class="num">${escapeHtml(row.volume)} ${escapeHtml(row.unit)}</td>
        <td class="num">${escapeHtml(formatCurrency(row.amount, currency, locale))}</td>
      </tr>`,
    )
    .join("");
  const districtSubtotal = sumMoney(...rows.map((row) => row.amount));

  return `<table class="appendix-district">
    <caption>${escapeHtml(district)}</caption>
    <thead>
      <tr><th>Polygon</th><th class="num">Volume</th><th class="num">Amount</th></tr>
    </thead>
    <tbody>${polygonRows}</tbody>
    <tfoot>
      <tr class="subtotal"><td colspan="2">District subtotal</td><td class="num">${escapeHtml(formatCurrency(districtSubtotal, currency, locale))}</td></tr>
    </tfoot>
  </table>`;
}

function buildAppendixUnmappedSection(
  rows: InvoiceAppendixRenderRow[],
  currency: string,
  locale: string,
): string {
  const polygonRows = rows
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.polygon)}</td>
        <td class="num">${escapeHtml(row.volume)} ${escapeHtml(row.unit)}</td>
        <td class="num">${escapeHtml(formatCurrency(row.amount, currency, locale))}</td>
      </tr>`,
    )
    .join("");
  const subtotal = sumMoney(...rows.map((row) => row.amount));

  return `<div class="appendix-state appendix-unmapped">
    <p class="section-label unmapped-label">Unmapped (no ratecard entry)</p>
    <table class="appendix-district">
      <thead>
        <tr><th>Polygon</th><th class="num">Volume</th><th class="num">Amount</th></tr>
      </thead>
      <tbody>${polygonRows}</tbody>
      <tfoot>
        <tr class="subtotal"><td colspan="2">Unmapped subtotal</td><td class="num">${escapeHtml(formatCurrency(subtotal, currency, locale))}</td></tr>
      </tfoot>
    </table>
  </div>`;
}

function toDateOnly(date: Date): string {
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
