import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  PRICING_COMPONENT_BADGE_VARIANTS,
  PricingComponentBadge,
} from "@/components/products/pricing-component-badge";
import { COMPONENT_TYPES } from "@/types/product";
import type { ComponentType, EnvelopePriceType } from "@/types/product";

// Every rendered case, pm53-spec D1: `flat_fee` is the one componentType with
// two variants (keyed by envelope priceType); the other three each have one.
const CASES: {
  componentType: ComponentType;
  priceType: EnvelopePriceType;
  label: string;
}[] = [
  { componentType: "usage_rate", priceType: "usage", label: "Usage rate" },
  {
    componentType: "flat_fee",
    priceType: "recurring",
    label: "Recurring charge",
  },
  { componentType: "flat_fee", priceType: "oneTime", label: "One-time charge" },
  {
    componentType: "capacity_commitment",
    priceType: "commitment",
    label: "Target capacity commitment",
  },
  {
    componentType: "capacity_motivation",
    priceType: "discount",
    label: "Target capacity motivation",
  },
];

describe("PricingComponentBadge", () => {
  for (const { componentType, priceType, label } of CASES) {
    it(`renders "${label}" for ${componentType}/${priceType} with an aria-hidden icon`, () => {
      render(
        <PricingComponentBadge
          componentType={componentType}
          priceType={priceType}
        />,
      );
      const text = screen.getByText(label);
      expect(text).toBeInTheDocument();
      const badge = text.closest("span");
      expect(badge?.querySelector("svg")).toHaveAttribute(
        "aria-hidden",
        "true",
      );
    });
  }

  it("renders a distinct icon for each of the five variants", () => {
    const iconClasses = new Set<string>();
    for (const { componentType, priceType } of CASES) {
      const { container, unmount } = render(
        <PricingComponentBadge
          componentType={componentType}
          priceType={priceType}
        />,
      );
      const cls = container.querySelector("svg")?.getAttribute("class") ?? "";
      expect(cls).toContain("lucide-");
      iconClasses.add(cls);
      unmount();
    }
    expect(iconClasses.size).toBe(CASES.length);
  });

  // pm53-spec D1/I5.1: the label/hue come from the envelope `priceType`,
  // never from a charge-period column — this badge has no period prop at
  // all, so a `flat_fee` renders purely off `priceType` regardless of
  // whatever a `recurringChargePeriodLength` row column happens to hold
  // alongside it.
  it("a recurring flat_fee renders Recurring charge with no period input available to the badge", () => {
    render(
      <PricingComponentBadge componentType="flat_fee" priceType="recurring" />,
    );
    expect(screen.getByText("Recurring charge")).toBeInTheDocument();
    expect(screen.queryByText("One-time charge")).not.toBeInTheDocument();
  });

  it("a oneTime flat_fee is never labelled Recurring even though a charge period could exist elsewhere on the row", () => {
    render(
      <PricingComponentBadge componentType="flat_fee" priceType="oneTime" />,
    );
    expect(screen.getByText("One-time charge")).toBeInTheDocument();
    expect(screen.queryByText("Recurring charge")).not.toBeInTheDocument();
  });

  // D2 guard: componentType/envelope-priceType disagreement is corruption,
  // not a variant — render nothing rather than guess.
  it("renders nothing when the componentType and envelope priceType disagree", () => {
    const { container } = render(
      <PricingComponentBadge componentType="flat_fee" priceType="usage" />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("colours every variant from globals.css tokens, never a hex literal", () => {
    const variants = [
      PRICING_COMPONENT_BADGE_VARIANTS.usage_rate,
      PRICING_COMPONENT_BADGE_VARIANTS.flat_fee.recurring,
      PRICING_COMPONENT_BADGE_VARIANTS.flat_fee.oneTime,
      PRICING_COMPONENT_BADGE_VARIANTS.capacity_commitment,
      PRICING_COMPONENT_BADGE_VARIANTS.capacity_motivation,
    ];
    for (const variant of variants) {
      expect(variant.className).toContain("var(--color-");
      expect(variant.className).not.toContain("#");
    }
  });

  // The map is total over ComponentType (pm53-spec D1, code-standards §2.2):
  // `PRICING_COMPONENT_BADGE_VARIANTS`'s type is
  // `Record<Exclude<ComponentType, "flat_fee">, Variant> & { flat_fee: … }`,
  // so removing a member from `COMPONENT_TYPES` — or adding one without a
  // matching key here — fails `tsc --noEmit`, not this test. This asserts
  // the runtime object actually carries every current member, as a live
  // cross-check against that compile-time guarantee.
  it("carries a variant for every current ComponentType", () => {
    for (const componentType of COMPONENT_TYPES) {
      if (componentType === "flat_fee") {
        expect(
          PRICING_COMPONENT_BADGE_VARIANTS.flat_fee.recurring,
        ).toBeDefined();
        expect(PRICING_COMPONENT_BADGE_VARIANTS.flat_fee.oneTime).toBeDefined();
      } else {
        expect(PRICING_COMPONENT_BADGE_VARIANTS[componentType]).toBeDefined();
      }
    }
  });
});
