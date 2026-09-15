// bm05-spec §Visual — the Customers & Bills tab: one row per trial
// `customer_bill`, expandable to its charges. bm06-spec §Visual adds the Tax
// section to the expander (each `customer_bill_tax_item` as
// `{category} @ {rate}% → {amount}`) and the tax-inclusive total. bm28-spec
// §Implementation §5 replaces the phase-2 synthetic "Stub charges (fixture)"
// line with `BillLineTable` — the real `customer_bill_line` charge record (the
// invoice's face, Inv #3), each USAGE row's `udr_rated` drill-down fetched on
// expand. Server component: the outer expander is a native `<details>`
// disclosure (no `'use client'`); only the drill-down leaf is a client
// component (code-standards §3.7).

import { BillCategoryBadge } from "@/components/billing/bill-category-badge";
import { BillLineTable } from "@/components/billing/bill-line-table";
import {
  InvoicePreviewModal,
  StoredInvoiceModal,
} from "@/components/billing/invoice-preview-modal";
import { formatCalendarDate, formatCurrency } from "@/lib/formatters";
import type { CustomerBillRow } from "@/types/billing";

export interface CustomerBillTableProps {
  billRunId: string;
  rows: CustomerBillRow[];
  locale: string;
  timezone: string;
}

export function CustomerBillTable({
  billRunId,
  rows,
  locale,
  timezone,
}: CustomerBillTableProps): React.JSX.Element {
  if (rows.length === 0) {
    return (
      <div className="rounded-none bg-card p-10 text-center shadow-sm">
        <p className="text-body font-semibold text-foreground">
          No draft bills yet
        </p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          Draft bills appear here once Aggregation has run for this run&apos;s
          accounts.
        </p>
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-none bg-card shadow-sm">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Account
            </th>
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Category
            </th>
            <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Subtotal
            </th>
            <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Tax
            </th>
            <th className="px-4 py-3 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Total
            </th>
            <th className="px-4 py-3 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Due date
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr
              key={row.customerBillId}
              className="border-b border-[color:var(--border-subtle)] hover:bg-[color:var(--color-neutral-50)]"
            >
              <td className="px-4 py-3 align-top">
                <details>
                  <summary className="cursor-pointer text-foreground select-none">
                    <span className="font-medium">{row.accountName}</span>{" "}
                    <span className="font-mono text-mono text-muted-foreground">
                      {row.billingAccountId}
                    </span>
                  </summary>
                  <div className="mt-2 rounded-sm border border-dashed border-border bg-[color:var(--surface-sunken)] p-2">
                    {/* bm28 — the invoice's face: one row per customer_bill_line
                        (the stored charge record, Inv #3), each USAGE row's
                        udr_rated drill-down fetched on expand. Replaces bm05's
                        synthetic "Stub charges (fixture)" line. */}
                    <BillLineTable
                      billRunId={billRunId}
                      billingAccountId={row.billingAccountId}
                      lines={row.lines}
                      locale={locale}
                      timezone={timezone}
                    />
                    {row.taxItems.length > 0 && (
                      <div className="mt-2 border-t border-dashed border-border pt-2">
                        {row.taxItems.map((item, index) => (
                          <p
                            key={`${item.category}-${index}`}
                            className="flex items-center justify-between gap-4 tabular-nums"
                          >
                            <span className="text-body-sm text-muted-foreground">
                              {item.category} @ {item.rate}%
                            </span>
                            <span className="font-mono text-mono text-foreground">
                              {formatCurrency(
                                item.amount,
                                row.currency,
                                locale,
                              )}
                            </span>
                          </p>
                        ))}
                      </div>
                    )}
                    <p className="mt-2 flex items-center justify-between gap-4 border-t border-border pt-2 font-semibold tabular-nums">
                      <span className="text-body-sm text-foreground">
                        Total (incl. tax)
                      </span>
                      <span className="font-mono text-mono text-foreground">
                        {formatCurrency(row.totalAmount, row.currency, locale)}
                      </span>
                    </p>
                  </div>
                </details>
                <div className="mt-1">
                  {/* bm19-spec §Implementation §5 — once posted (invoiceId set)
                      the issued STORED record replaces the draft preview. But a
                      posted INV whose final render/store failed is a tolerated,
                      retryable render-pending state (D10) with no stored
                      artifact yet: offering StoredInvoiceModal there would only
                      404, so surface the pending state and point to the Posting
                      progress view, where the money-gated retry lives (this
                      viewer tab must not carry an approver-only action). */}
                  {!row.invoiceId ? (
                    <InvoicePreviewModal
                      billRunId={billRunId}
                      billingAccountId={row.billingAccountId}
                      accountName={row.accountName}
                    />
                  ) : row.hasStoredInvoice ? (
                    <StoredInvoiceModal
                      billRunId={billRunId}
                      billingAccountId={row.billingAccountId}
                      accountName={row.accountName}
                    />
                  ) : (
                    <p className="text-body-sm text-[color:var(--color-warning-700)]">
                      Final invoice still rendering — retry from the Posting
                      progress view.
                    </p>
                  )}
                </div>
              </td>
              <td className="px-4 py-3 whitespace-nowrap">
                <BillCategoryBadge category={row.category} />
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                {formatCurrency(row.subtotal, row.currency, locale)}
              </td>
              <td className="px-4 py-3 text-right whitespace-nowrap tabular-nums">
                {formatCurrency(row.taxTotal, row.currency, locale)}
              </td>
              <td className="px-4 py-3 text-right font-semibold whitespace-nowrap tabular-nums">
                {formatCurrency(row.totalAmount, row.currency, locale)}
              </td>
              <td className="px-4 py-3 text-body-sm whitespace-nowrap text-muted-foreground">
                {formatCalendarDate(row.paymentDueDate)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
