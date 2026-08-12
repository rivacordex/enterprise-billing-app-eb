import { OrderStatusBadge } from "@/components/products/ordering/order-status-badge";
import { ReviewActions } from "@/components/products/ordering/review-actions";
import { formatCurrency, formatDatetime } from "@/lib/formatters";
import type { OrderDetail, OrderPriceLine } from "@/types/ordering";

export interface OrderReviewPanelProps {
  // Reuses pm26's `getOrderDetail` read model unchanged (the substantive
  // review data: item, resolved price lines, status, metadata timestamps).
  order: OrderDetail;
  // Resolved display fields the id-only OrderDetail doesn't carry, sourced by
  // the page from existing read services (pm31 "reuse existing services"):
  // customer name, BAN name + cycle/terms/currency, submitter/reviewer names.
  customerName: string;
  banName: string;
  banCurrency: string;
  billCycleName: string;
  paymentTermsDays: number;
  submittedByName: string;
  reviewedByName: string | null;
  // MANAGER ∧ EDIT ∧ not submitter, resolved server-side (platform Inv. #3 —
  // pm30 enforces regardless; this only drives the disabled/tooltip state).
  canReview: boolean;
  reviewDisabledReason: string | null;
  locale: string;
  timezone: string;
}

// Δ% is a display-only ratio computed from the two amounts (pm31-spec §Design:
// "Δ% computed display-side from the two amounts"). This is not the module's
// forbidden "money arithmetic" (code-standards §2.4 — no monetary value is
// produced or stored/rated); it's a percentage for the reviewer's eye, negative
// deltas flagged in danger text. Returns null when there's no override or no
// scalar list amount (tiered) to compare against.
function deltaPercent(line: OrderPriceLine): number | null {
  if (line.overrideAmount === null || line.listAmount === null) return null;
  const list = Number(line.listAmount);
  const negotiated = Number(line.overrideAmount);
  if (!Number.isFinite(list) || list === 0) return null;
  return ((negotiated - list) / list) * 100;
}

function formatDelta(pct: number): string {
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function KeyValue({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
        {label}
      </dt>
      <dd className="text-body text-foreground">{children}</dd>
    </div>
  );
}

// pm31-spec §2. The Orders page's selection panel for the `?order=`-selected
// order — the same component serves as the read-only order detail view for
// every status; Approve/Reject only render on a PENDING order. Sections:
// context strip, order summary (kv grid), pricing table with Δ%, an info banner
// stating approval re-validates at approval time, and submitted/reviewed
// metadata.
export function OrderReviewPanel({
  order,
  customerName,
  banName,
  banCurrency,
  billCycleName,
  paymentTermsDays,
  submittedByName,
  reviewedByName,
  canReview,
  reviewDisabledReason,
  locale,
  timezone,
}: OrderReviewPanelProps): React.JSX.Element {
  const { item, prices } = order;
  const characteristics = item.orderedCharacteristics
    ? Object.entries(item.orderedCharacteristics)
    : [];

  return (
    <section
      aria-label={`Order ${order.productOrderId}`}
      className="space-y-5 rounded-md bg-card p-5 shadow-sm"
    >
      {/* Context strip — customer · BAN · currency · cycle · terms (the pm29
          wizard's own strip, mirrored on the review surface). */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border pb-4 text-body-sm text-muted-foreground">
        <span className="font-mono text-mono text-foreground tabular-nums">
          {order.productOrderId}
        </span>
        <span aria-hidden>·</span>
        <span className="text-foreground">{customerName}</span>
        <span aria-hidden>·</span>
        <span className="font-mono text-mono tabular-nums">
          {order.billingAccountId}
        </span>
        <span aria-hidden>·</span>
        <span>{banCurrency}</span>
        <span aria-hidden>·</span>
        <span>{billCycleName}</span>
        <span aria-hidden>·</span>
        <span>Net {paymentTermsDays}d</span>
        <span className="ml-auto">
          <OrderStatusBadge status={order.status} />
        </span>
      </div>

      {/* Order summary — kv grid. */}
      <dl className="grid grid-cols-2 gap-4 sm:grid-cols-3">
        <KeyValue label="Customer">{customerName}</KeyValue>
        <KeyValue label="Billing account">
          <span className="font-mono text-mono tabular-nums">{banName}</span>
        </KeyValue>
        <KeyValue label="Cycle / terms">
          {billCycleName} · Net {paymentTermsDays}d
        </KeyValue>
        <KeyValue label="Offer">
          {item.offeringName}{" "}
          <span className="font-mono text-mono text-muted-foreground">
            (v{item.offeringVersion})
          </span>
        </KeyValue>
        <KeyValue label="Quantity">
          <span className="tabular-nums">{item.quantity}</span>
        </KeyValue>
        <KeyValue label="Start date">
          <span className="tabular-nums">{item.startDate}</span>
        </KeyValue>
        <div className="col-span-full flex flex-col gap-0.5">
          <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Characteristics
          </dt>
          <dd className="text-body text-foreground">
            {characteristics.length > 0 ? (
              <span className="flex flex-wrap gap-x-4 gap-y-1">
                {characteristics.map(([key, value]) => (
                  <span key={key}>
                    <span className="text-muted-foreground">{key}: </span>
                    <span className="font-mono text-mono">{value}</span>
                  </span>
                ))}
              </span>
            ) : (
              <span className="text-muted-foreground">None</span>
            )}
          </dd>
        </div>
      </dl>

      {/* Pricing table — list vs negotiated with Δ%. */}
      <div className="overflow-x-auto rounded-md border border-border">
        <table className="w-full border-collapse text-body">
          <thead>
            <tr className="border-b border-border bg-[color:var(--surface-sunken)]">
              <th className="px-4 py-2.5 text-left text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Price type
              </th>
              <th className="px-4 py-2.5 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                List
              </th>
              <th className="px-4 py-2.5 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Negotiated
              </th>
              <th className="px-4 py-2.5 text-right text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                Δ%
              </th>
            </tr>
          </thead>
          <tbody>
            {prices.length === 0 ? (
              <tr>
                <td
                  colSpan={4}
                  className="px-4 py-6 text-center text-body text-muted-foreground"
                >
                  No effective prices on the pinned version.
                </td>
              </tr>
            ) : (
              prices.map((line) => {
                const pct = deltaPercent(line);
                return (
                  <tr
                    key={line.priceType}
                    className="border-b border-[color:var(--border-subtle)] last:border-0"
                  >
                    <td className="px-4 py-2.5 text-foreground">
                      {line.priceName}
                    </td>
                    <td className="px-4 py-2.5 text-right text-foreground tabular-nums">
                      {line.listAmount !== null ? (
                        formatCurrency(line.listAmount, line.currency, locale)
                      ) : (
                        <span className="text-muted-foreground">tiered</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {line.overrideAmount !== null ? (
                        <span className="font-semibold text-foreground">
                          {formatCurrency(
                            line.overrideAmount,
                            line.currency,
                            locale,
                          )}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-4 py-2.5 text-right tabular-nums">
                      {pct !== null ? (
                        <span
                          className={
                            pct < 0
                              ? "text-[color:var(--color-danger-700)]"
                              : "text-foreground"
                          }
                        >
                          {formatDelta(pct)}
                        </span>
                      ) : (
                        <span className="text-muted-foreground">—</span>
                      )}
                    </td>
                  </tr>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {/* Info banner — approval re-validates at approval time (Inv. #3/#19). */}
      <div className="rounded-md bg-[color:var(--color-info-50)] px-4 py-3 text-body-sm text-[color:var(--color-info-700)]">
        Approval re-runs the full order validation under locks at approval time.
        An order approved later must still pass every precondition or it stays
        pending.
      </div>

      {/* Submitted / reviewed metadata. */}
      <dl className="grid grid-cols-1 gap-4 border-t border-border pt-4 sm:grid-cols-2">
        <KeyValue label="Submitted">
          {submittedByName} ·{" "}
          {formatDatetime(order.submittedAt, locale, timezone)}
        </KeyValue>
        <KeyValue label="Reviewed">
          {reviewedByName !== null && order.reviewedAt !== null ? (
            <>
              {reviewedByName} ·{" "}
              {formatDatetime(order.reviewedAt, locale, timezone)}
            </>
          ) : (
            <span className="text-muted-foreground">—</span>
          )}
        </KeyValue>
        {order.failureReason !== null && (
          <div className="col-span-full">
            <KeyValue label="Rejection reason">{order.failureReason}</KeyValue>
          </div>
        )}
      </dl>

      {order.status === "PENDING" && (
        <div className="flex justify-end border-t border-border pt-4">
          <ReviewActions
            orderId={order.productOrderId}
            canReview={canReview}
            disabledReason={reviewDisabledReason}
            prices={prices}
            locale={locale}
          />
        </div>
      )}
    </section>
  );
}
