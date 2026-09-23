import { Receipt } from "lucide-react";

import { PricingComponentBadge } from "@/components/products/pricing-component-badge";
import {
  formatChargePeriod,
  renderPriceAmount,
} from "@/components/products/price-amount";
import {
  PriceEffectivityTag,
  effectivityAccentClass,
} from "@/components/products/price-effectivity";
import { formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { EffectivityStatus, PriceCard } from "@/types/product";

// Effectivity tag + card accent come from the shared price-effectivity module
// (pm41 review #8), so Manage Products' inline editor renders the same signal.
function cardClassName(status: EffectivityStatus): string {
  return cn(
    "rounded-md border border-[color:var(--border-subtle)] p-3",
    effectivityAccentClass(status),
  );
}

type PricesPanelProps = {
  prices: PriceCard[];
  locale: string;
  timezone: string;
};

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
            {price.componentType === price.component["@type"] ? (
              <PricingComponentBadge
                componentType={price.componentType}
                priceType={price.component.priceType}
              />
            ) : null}
            <PriceEffectivityTag
              price={price}
              locale={locale}
              timezone={timezone}
            />
          </div>

          <div className="mt-1.5">
            {renderPriceAmount(price, prices, locale)}
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
