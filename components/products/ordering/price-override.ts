import type { OverridePriceType } from "@/types/ordering";
import type { PriceCard } from "@/types/product";

// pm56b — the inverse of pm50's `OVERRIDE_TARGET_BY_PRICE_TYPE`
// (services/ordering/order-preconditions.ts): given a catalog `PriceCard`, which
// negotiated-override lane (if any) targets it. Keep in sync with that forward
// map. Only `usage_rate` and `flat_fee` are overridable, because a negotiated
// override resolves against a scalar catalog row (Inv. #16); a
// `capacity_commitment`/`capacity_motivation` carries a quantity/step shape with
// no single amount to negotiate, so it has no lane and renders read-only — this
// replaces the pre-pm47 `pricingModel === "tiered"` skip. The lane is the
// ordering module's OWN axis (`OverridePriceType`), never the deleted catalog
// `PriceType` (Inv. #38).
export function overrideLaneOf(price: PriceCard): OverridePriceType | null {
  const { component } = price;
  switch (component["@type"]) {
    case "usage_rate":
      return "usage";
    case "flat_fee":
      return component.priceType === "recurring" ? "recurring" : "once";
    default:
      return null;
  }
}

// pm56b D2.1 — a lane is overridable only when **exactly one** current price
// maps to it. A negotiated override resolves against a single scalar catalog
// row (Inv. #16), so a lane carrying two current prices — e.g. two `usage_rate`
// rows in different units, both mapping to the `usage` lane — is ambiguous and
// is offered read-only rather than mis-wiring the two rows onto one override
// slot (and tripping `create-order.schema`'s "at most one override per price
// type"). Only current prices count; a superseded/future row never claims a lane.
export function overridableLanes(prices: PriceCard[]): Set<OverridePriceType> {
  const counts = new Map<OverridePriceType, number>();
  for (const price of prices) {
    if (price.effectivityStatus !== "current") continue;
    const lane = overrideLaneOf(price);
    if (lane === null) continue;
    counts.set(lane, (counts.get(lane) ?? 0) + 1);
  }
  const lanes = new Set<OverridePriceType>();
  for (const [lane, n] of counts) {
    if (n === 1) lanes.add(lane);
  }
  return lanes;
}

// The scalar list amount a negotiated override strikes through: `usage_rate`'s
// per-unit rate or `flat_fee`'s amount. `null` for the non-overridable capacity
// components, which show no list amount.
export function overrideListAmount(price: PriceCard): string | null {
  const { component } = price;
  switch (component["@type"]) {
    case "usage_rate":
      return component.params.ratePerUnit;
    case "flat_fee":
      return component.params.amount;
    default:
      return null;
  }
}
