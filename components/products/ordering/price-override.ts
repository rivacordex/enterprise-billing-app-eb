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
