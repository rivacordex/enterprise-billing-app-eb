import { Receipt } from "lucide-react";

import { PricingComponentBadge } from "@/components/products/pricing-component-badge";
import {
  PriceEffectivityTag,
  effectivityAccentClass,
} from "@/components/products/price-effectivity";
import { formatCurrency, formatDatetime } from "@/lib/formatters";
import { cn } from "@/lib/utils";
import type { EffectivityStatus, PriceCard } from "@/types/product";
import type { Step } from "@/validation/product/pricing-component.schema";

// Effectivity tag + card accent come from the shared price-effectivity module
// (pm41 review #8), so Manage Products' inline editor renders the same signal.
function cardClassName(status: EffectivityStatus): string {
  return cn(
    "rounded-md border border-[color:var(--border-subtle)] p-3",
    effectivityAccentClass(status),
  );
}

function formatChargePeriod(length: number, type: string): string {
  return `${length} ${type}`.trim();
}

function formatQuantity(quantity: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(quantity);
}

// pm53-spec D5: ascending, semicolon-separated plain text — no table, no
// widget. The leading `base <rate>` comes from the same-unit `usage_rate` on
// the offering (found by the caller) when one exists; the schedule is
// meaningless without it, but this panel never diagnoses that — it just
// renders the steps alone and lets pm54's blocking banner say why.
function stepsText(steps: Step[], baseRate: string | null): string {
  const parts = steps.map(
    (step) => `above ${step.aboveQuantity}: ${step.ratePerUnit}`,
  );
  if (baseRate !== null) {
    parts.unshift(`base ${baseRate}`);
  }
  return parts.join("; ");
}

// The same-unit `usage_rate` sibling a `capacity_motivation` schedule reads
// its base rate from (D5) — a per-lane read, never a global "the" usage rate.
// Among same-unit siblings, prefer the one sharing the motivation card's own
// effectivityStatus (so a superseded motivation reads its superseded base,
// not a newer/older one), falling back to the current sibling.
function findBaseRate(
  prices: PriceCard[],
  motivationCard: PriceCard,
): string | null {
  const siblings = prices.filter(
    (candidate) =>
      candidate.componentType === "usage_rate" &&
      candidate.unitOfMeasure === motivationCard.unitOfMeasure,
  );
  const sibling =
    siblings.find(
      (candidate) =>
        candidate.effectivityStatus === motivationCard.effectivityStatus,
    ) ??
    siblings.find((candidate) => candidate.effectivityStatus === "current");
  if (sibling === undefined || sibling.component["@type"] !== "usage_rate") {
    return null;
  }
  return sibling.component.params.ratePerUnit;
}

// pm53-spec D4/D6: amount rendering is keyed to `component_type`, and the
// row (never `params`) owns unit and period. `rateCardLookUp` renders as a
// name beside the rate, never as a reference (D6, Inv. #42).
function renderAmount(
  price: PriceCard,
  allPrices: PriceCard[],
  locale: string,
): React.ReactNode {
  const { component, currency, unitOfMeasure } = price;

  switch (component["@type"]) {
    case "usage_rate":
      return (
        <p>
          <span className="text-h4 font-semibold text-foreground tabular-nums">
            {formatCurrency(component.params.ratePerUnit, currency, locale)}
          </span>{" "}
          <span className="text-caption text-muted-foreground">
            / {unitOfMeasure}
          </span>{" "}
          <span className="font-mono text-caption text-muted-foreground">
            {component.params.rateCardLookUp ?? "default rate"}
          </span>
        </p>
      );

    case "flat_fee": {
      const amountText = formatCurrency(
        component.params.amount,
        currency,
        locale,
      );
      if (component.priceType === "recurring") {
        return (
          <p>
            <span className="text-h4 font-semibold text-foreground tabular-nums">
              {amountText}
            </span>{" "}
            <span className="text-caption text-muted-foreground">
              /{" "}
              {formatChargePeriod(
                price.recurringChargePeriodLength ?? 0,
                price.recurringChargePeriodType ?? "",
              )}
            </span>
          </p>
        );
      }
      // `oneTime` — the bare amount, no unit (unit_of_measure is NULL on
      // every flat_fee row).
      return (
        <p>
          <span className="text-h4 font-semibold text-foreground tabular-nums">
            {amountText}
          </span>
        </p>
      );
    }

    case "capacity_commitment":
      return (
        <p className="text-body font-semibold text-foreground tabular-nums">
          committed {formatQuantity(component.params.committedQuantity, locale)}{" "}
          {unitOfMeasure}
        </p>
      );

    case "capacity_motivation": {
      const baseRate = findBaseRate(allPrices, price);
      return (
        <p className="font-mono text-body-sm text-foreground tabular-nums">
          {stepsText(component.params.steps, baseRate)}
        </p>
      );
    }

    // `negotiated_override` never reaches this table (Inv. #39) — its row
    // lives in `ordering.order_item_price_override`, not
    // `product.product_offering_price`. This is a guard against a shape this
    // panel never actually receives, not a fallback.
    case "negotiated_override":
      return null;
  }
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

          <div className="mt-1.5">{renderAmount(price, prices, locale)}</div>

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
