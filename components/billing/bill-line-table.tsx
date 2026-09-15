// bm28-spec §Design/§Implementation §5, code-standards §4.1b — the bill's charge
// record rendered as the invoice's face: one row per `customer_bill_line` at
// `(product_offering_id, udr_type)` grain. Server component (mono ids,
// tabular-nums money, `--radius-none` grid, ui-context §6); each USAGE row's
// `udr_rated` drill-down is a client leaf (`UsageLineDrillDown`) fetched on
// expand only, never eager, and scoped to that line's grain. `discount_amount`
// is hidden while every value is `0.00` (D-delta, §4.1c — no discount is
// computed this phase, so suppressing the column keeps the invoice honest). The
// `ChargeSourceBadge` that labels a line's origin (USAGE vs RECURRING) lands with
// recurring (bm29); every line here is USAGE. Each line carries its own
// `currency` (char(3), NOT NULL), so money formats off `line.currency` directly.

import { formatCurrency } from "@/lib/formatters";
import { UsageLineDrillDown } from "@/components/billing/usage-line-drill-down";
import type { BillLineRow } from "@/types/billing";

export interface BillLineTableProps {
  billRunId: string;
  billingAccountId: string;
  lines: BillLineRow[];
  locale: string;
  timezone: string;
}

export function BillLineTable({
  billRunId,
  billingAccountId,
  lines,
  locale,
  timezone,
}: BillLineTableProps): React.JSX.Element {
  if (lines.length === 0) {
    return (
      <p className="text-caption text-muted-foreground">
        No charge lines — this account produced no usage this period.
      </p>
    );
  }

  // §4.1c — show the discount column only when some line actually carries a
  // discount; every line is `0.00` this phase, so it stays hidden.
  const showDiscount = lines.some((line) => line.discountAmount !== "0.00");

  return (
    <div className="overflow-x-auto rounded-none border border-[color:var(--border-subtle)] bg-card">
      <table className="w-full border-collapse text-body-sm">
        <thead>
          <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
            <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              #
            </th>
            <th className="px-3 py-2 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Charge
            </th>
            <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Quantity
            </th>
            <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Gross
            </th>
            {showDiscount && (
              <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Discount
              </th>
            )}
            <th className="px-3 py-2 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Net
            </th>
          </tr>
        </thead>
        <tbody>
          {lines.map((line) => (
            <BillLineRows
              key={line.customerBillLineId}
              billRunId={billRunId}
              billingAccountId={billingAccountId}
              line={line}
              showDiscount={showDiscount}
              locale={locale}
              timezone={timezone}
            />
          ))}
        </tbody>
      </table>
    </div>
  );
}

function BillLineRows({
  billRunId,
  billingAccountId,
  line,
  showDiscount,
  locale,
  timezone,
}: {
  billRunId: string;
  billingAccountId: string;
  line: BillLineRow;
  showDiscount: boolean;
  locale: string;
  timezone: string;
}): React.JSX.Element {
  return (
    <>
      <tr className="border-b border-[color:var(--border-subtle)]">
        <td className="px-3 py-2 text-right text-muted-foreground tabular-nums">
          {line.lineNo}
        </td>
        <td className="px-3 py-2">
          <span className="font-medium text-foreground">
            {line.description ?? line.refProductOfferingId}
          </span>
          {line.udrType && (
            <span className="ms-2 font-mono text-mono text-muted-foreground">
              {line.udrType}
            </span>
          )}
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
          {line.quantity !== null ? (
            <>
              {line.quantity}
              {line.unit ? ` ${line.unit}` : ""}
            </>
          ) : (
            "—"
          )}
        </td>
        <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
          {formatCurrency(line.grossAmount, line.currency, locale)}
        </td>
        {showDiscount && (
          <td className="px-3 py-2 text-right whitespace-nowrap tabular-nums">
            {formatCurrency(line.discountAmount, line.currency, locale)}
          </td>
        )}
        <td className="px-3 py-2 text-right font-semibold whitespace-nowrap tabular-nums">
          {formatCurrency(line.netAmount, line.currency, locale)}
        </td>
      </tr>
      {/* USAGE lines carry the lazy udr_rated drill-down; a RECURRING line has
          no drill-down (its evidence is the price snapshot, rendered when
          recurring lands in bm29). The drill-down row spans the columns after
          the leading line-no cell (Charge, Quantity, Gross, [Discount], Net). */}
      {line.source === "USAGE" && line.udrType && (
        <tr className="border-b border-[color:var(--border-subtle)] bg-[color:var(--surface-sunken)]">
          <td className="px-3 py-1" />
          <td className="px-3 py-1" colSpan={showDiscount ? 5 : 4}>
            <UsageLineDrillDown
              billRunId={billRunId}
              billingAccountId={billingAccountId}
              productOfferingId={line.refProductOfferingId}
              udrType={line.udrType}
              locale={locale}
              timezone={timezone}
            />
          </td>
        </tr>
      )}
    </>
  );
}
