import { formatCurrency } from "@/lib/formatters";
import type { PriceCard } from "@/types/product";
import type { Step } from "@/validation/product/pricing-component.schema";

// pm54/pm55: extracted from prices-panel.tsx (pm53's `renderAmount`) so the
// read-only View Product panel and Manage Products' editable row summary
// render the exact same figures off the exact same rule (code-standards
// §2.16 — no second copy) — Manage's editable surface may import from View's
// read-only surface (Inv. #29 one-directional import), and this module is
// itself read-only/presentational, imported by both, never the reverse.

export function formatChargePeriod(length: number, type: string): string {
  return `${length} ${type}`.trim();
}

function formatQuantity(quantity: number, locale: string): string {
  return new Intl.NumberFormat(locale).format(quantity);
}

// pm53-spec D5: ascending, semicolon-separated plain text — no table, no
// widget. The leading `base <rate>` comes from the same-unit `usage_rate` on
// the offering (found by the caller) when one exists; the schedule is
// meaningless without it, but this module never diagnoses that — it just
// renders the steps alone and lets pm54's blocking banner say why.
export function stepsText(steps: Step[], baseRate: string | null): string {
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
export function findBaseRate(
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
export function renderPriceAmount(
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
    // module never actually receives, not a fallback.
    case "negotiated_override":
      return null;
  }
}
