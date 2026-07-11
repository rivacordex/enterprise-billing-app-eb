import { Receipt } from "lucide-react";

import { PriceTypeBadge } from "@/components/products/price-type-badge";
import { formatCurrency, formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { EffectivityStatus, PriceCard } from "@/types/product";
import type { Tier } from "@/validation/product/pricing-characteristics.schema";

function tierText(tier: Tier): string {
  const to = tier.to === null ? "and above" : String(tier.to);
  return `${tier.from}–${to}: ${tier.rate}`;
}

type PricesPanelProps = {
  prices: PriceCard[];
  locale: string;
  timezone: string;
};

function stateTag(
  price: PriceCard,
  locale: string,
  timezone: string,
): React.JSX.Element | null {
  if (price.effectivityStatus === "future") {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-xs)] bg-[color:var(--color-info-50)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-info-700)] uppercase">
        {`Starts ${formatDatetime(price.startDateTime, locale, timezone)}`}
      </span>
    );
  }

  if (price.effectivityStatus === "superseded") {
    return (
      <span className="inline-flex items-center rounded-[var(--radius-xs)] bg-[color:var(--color-neutral-100)] px-1.5 py-0.5 text-[11px] font-semibold tracking-wider text-[color:var(--color-neutral-700)] uppercase">
        Superseded
      </span>
    );
  }

  return null;
}

function cardClassName(status: EffectivityStatus): string {
  const base = "rounded-md border border-[color:var(--border-subtle)] p-3";

  if (status === "current") {
    return cn(base, "border-l-4 border-l-[color:var(--color-cyan-500)]");
  }

  if (status === "superseded") {
    return cn(base, "text-muted-foreground");
  }

  return base;
}

function formatChargePeriod(length: number, type: string): string {
  return `${length} ${type}`.trim();
}

export function PricesPanel({
  prices,
  locale,
  timezone,
}: PricesPanelProps): React.JSX.Element {
  if (prices.length === 0) {
    return (
      <div className="mt-2 rounded-md bg-[color:var(--surface-sunken)] p-6 text-center">
        <Receipt
          className="mx-auto mb-2 size-8 text-[color:var(--text-muted)]"
          aria-hidden="true"
        />
        <p className="text-body-sm text-muted-foreground">
          No prices for this offering.
        </p>
      </div>
    );
  }

  return (
    <div className="mt-2 flex flex-col gap-2">
      {prices.map((price) => (
        <div
          key={price.productOfferingPriceId}
          className={cardClassName(price.effectivityStatus)}
        >
          <p className="font-mono text-overline text-muted-foreground tabular-nums">
            {price.productOfferingPriceId}
          </p>
          <div className="mt-1 flex flex-wrap items-center gap-2">
            <span className="text-body font-semibold text-foreground">
              {price.name}
            </span>
            <PriceTypeBadge priceType={price.priceType} />
            {stateTag(price, locale, timezone)}
          </div>

          <div className="mt-1.5">
            {price.pricingModel === "tiered" && price.pricingCharacteristics ? (
              <p className="font-mono text-body-sm text-foreground tabular-nums">
                {price.pricingCharacteristics.tiers.map((tier, index) => (
                  <span key={index}>
                    {index > 0 ? "; " : null}
                    {tierText(tier)}
                  </span>
                ))}
              </p>
            ) : (
              price.amount !== null && (
                <p>
                  <span className="text-h4 font-semibold text-foreground tabular-nums">
                    {formatCurrency(price.amount, price.currency, locale)}
                  </span>{" "}
                  <span className="text-caption text-muted-foreground">
                    {price.currency}
                  </span>
                </p>
              )
            )}
          </div>

          <dl className="mt-1.5 grid grid-cols-[max-content_1fr] gap-x-6 gap-y-1">
            {price.recurringChargePeriodLength !== null ? (
              <>
                <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Charge period
                </dt>
                <dd className="text-body-sm text-foreground">
                  {formatChargePeriod(
                    price.recurringChargePeriodLength,
                    price.recurringChargePeriodType ?? "",
                  )}
                </dd>
              </>
            ) : null}

            {price.unitOfMeasure !== null ? (
              <>
                <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Unit of measure
                </dt>
                <dd className="text-body-sm text-foreground">
                  {price.unitOfMeasure}
                </dd>
              </>
            ) : null}

            {price.glCode !== null ? (
              <>
                <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  GL code
                </dt>
                <dd className="font-mono text-body-sm text-foreground">
                  {price.glCode}
                </dd>
              </>
            ) : null}

            {price.policy !== null ? (
              <>
                <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
                  Policy
                </dt>
                <dd className="text-body-sm text-foreground">{price.policy}</dd>
              </>
            ) : null}

            <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Effective
            </dt>
            <dd className="text-body-sm text-foreground">
              <time dateTime={price.startDateTime.toISOString()}>
                {formatDatetime(price.startDateTime, locale, timezone)}
              </time>
              {" – "}
              {price.endDateTime === null ? (
                "Open-ended"
              ) : (
                <time dateTime={price.endDateTime.toISOString()}>
                  {formatDatetime(price.endDateTime, locale, timezone)}
                </time>
              )}
            </dd>

            <dt className="text-overline font-semibold tracking-wider text-muted-foreground uppercase">
              Created
            </dt>
            <dd className="text-caption text-muted-foreground">
              <time dateTime={price.createdAt.toISOString()}>
                {formatDatetime(price.createdAt, locale, timezone)}
              </time>
            </dd>
          </dl>
        </div>
      ))}
    </div>
  );
}
