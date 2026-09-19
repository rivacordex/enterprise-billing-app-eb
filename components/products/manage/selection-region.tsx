import { PackageSearch, SearchX } from "lucide-react";

import { OfferingDetail } from "@/components/products/offering-detail";
import { PricesPanel } from "@/components/products/prices-panel";
import { SpecificationsPanel } from "@/components/products/specifications-panel";
import type { OfferingDetail as OfferingDetailModel } from "@/types/product";

// pm40 I5/D3/D4. Composes the selected version's detail, specifications and
// prices inside the D4 grid (detail full width → specs and prices side-by-side
// at `lg:`, stacking in that order on narrow viewports), so page.tsx stays a
// thin orchestrator. It renders View Product's read-only components directly
// (Inv. #29 — the import is one-directional and correct); it holds no state and
// no business rules. The version bar is rendered by the page above this region
// (D4 order: table → version bar → detail → specs → prices).
export interface SelectionRegionProps {
  // A family is selected in the URL (`?family=` present and well-formed).
  hasFamily: boolean;
  // The resolved version's detail; null when no family is selected, or when the
  // selected family matches no row (a stale link — the empty state says so).
  offering: OfferingDetailModel | null;
  locale: string;
  timezone: string;
}

function EmptyPanel({
  icon: Icon,
  children,
}: {
  icon: typeof SearchX;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-12 text-center">
      <Icon className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
      <p className="text-body text-muted-foreground">{children}</p>
    </div>
  );
}

export function SelectionRegion({
  hasFamily,
  offering,
  locale,
  timezone,
}: SelectionRegionProps): React.JSX.Element {
  if (!hasFamily) {
    return (
      <EmptyPanel icon={SearchX}>
        Select a product to see its versions, specifications and prices.
      </EmptyPanel>
    );
  }

  if (offering === null) {
    // A `?family=` that matches no row (D1 case 5): not a 404, a muted line.
    return (
      <EmptyPanel icon={PackageSearch}>
        That product no longer exists.
      </EmptyPanel>
    );
  }

  // A DRAFT with no prices yet cannot be submitted for testing; surface the
  // requirement pm42 acts on as a muted hint, never a save-blocking error (I6,
  // §1.19 / §4.16).
  const showNoPriceSubmitHint =
    offering.lifecycleStatus === "DRAFT" && offering.prices.length === 0;

  return (
    <div className="space-y-3">
      <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
        <h2 className="text-h3 font-semibold text-foreground">Details</h2>
        <div className="mt-2">
          <OfferingDetail
            offering={offering}
            locale={locale}
            timezone={timezone}
          />
        </div>
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
          <h2 className="text-h3 font-semibold text-foreground">
            Specifications
          </h2>
          <SpecificationsPanel specifications={offering.specifications} />
        </section>

        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
          <h2 className="text-h3 font-semibold text-foreground">Prices</h2>
          <PricesPanel
            prices={offering.prices}
            locale={locale}
            timezone={timezone}
          />
          {showNoPriceSubmitHint ? (
            <p className="mt-2 text-body-sm text-muted-foreground">
              At least one price is required before this version can be
              submitted for testing.
            </p>
          ) : null}
        </section>
      </div>
    </div>
  );
}
