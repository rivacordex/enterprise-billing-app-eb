import { Archive, SearchX } from "lucide-react";

import { OfferingDetail } from "@/components/products/offering-detail";
import { PricesPanel } from "@/components/products/prices-panel";
import { SpecificationsPanel } from "@/components/products/specifications-panel";
import type { OfferingDetail as OfferingDetailModel } from "@/types/product";

export interface OfferingDetailRegionProps {
  hasSelection: boolean;
  notFound: boolean;
  offering: OfferingDetailModel | null;
  locale: string;
  timezone: string;
}

export function OfferingDetailRegion({
  hasSelection,
  notFound,
  offering,
  locale,
  timezone,
}: OfferingDetailRegionProps): React.JSX.Element {
  if (notFound) {
    return (
      <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-12 text-center">
        <Archive className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
        <p className="text-body font-medium text-foreground">
          Offering not found
        </p>
        <p className="mt-1 text-body-sm text-muted-foreground">
          The selected offering no longer exists or the link is stale.
        </p>
      </div>
    );
  }

  if (!hasSelection) {
    return (
      <div className="rounded-md border border-border bg-[color:var(--surface-sunken)] p-12 text-center">
        <SearchX className="mx-auto mb-3 size-12 text-[color:var(--text-muted)]" />
        <p className="text-body text-muted-foreground">
          Select an offering to view its details, specifications, and prices.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
        <h2 className="text-h3 font-semibold text-foreground">Details</h2>
        {offering ? (
          <div className="mt-2">
            <OfferingDetail
              offering={offering}
              locale={locale}
              timezone={timezone}
            />
          </div>
        ) : null}
      </section>

      <div className="grid gap-3 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
          <h2 className="text-h3 font-semibold text-foreground">
            Specifications
          </h2>
          {offering ? (
            <SpecificationsPanel specifications={offering.specifications} />
          ) : null}
        </section>

        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
          <h2 className="text-h3 font-semibold text-foreground">Prices</h2>
          {offering ? (
            <PricesPanel
              prices={offering.prices}
              locale={locale}
              timezone={timezone}
            />
          ) : null}
        </section>
      </div>
    </div>
  );
}
