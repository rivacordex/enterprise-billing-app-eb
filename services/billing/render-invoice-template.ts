import { formatCalendarDate, formatCurrency } from "@/lib/formatters";

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

// bm19-spec §Design "Final render = draft renderer, no watermark, real
// number" — the final (posted) invoice reuses this same template/params
// shape, only substituting the real `INV…` number for the "pending
// posting" placeholder and dropping the watermark entirely.
export interface BuildFinalInvoiceHtmlParams extends BuildDraftInvoiceHtmlParams {
  invoiceNumber: string;
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
  { bill, taxItems, lines, run, locale }: BuildDraftInvoiceHtmlParams,
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
      <div><span class="label">Indicative due date</span><span class="value">${escapeHtml(formatCalendarDate(bill.paymentDueDate))}</span></div>
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
