import { Archive, SearchX } from "lucide-react";

export interface OfferingDetailRegionProps {
  hasSelection: boolean;
  notFound: boolean;
  // pm06 will add `offering: OfferingDetail | null` here.
}

export function OfferingDetailRegion({
  hasSelection,
  notFound,
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
    <div className="space-y-4">
      <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-4">
        <h2 className="text-h3 font-semibold text-foreground">Details</h2>
        {/* pm06: populated detail */}
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-4">
          <h2 className="text-h3 font-semibold text-foreground">
            Specifications
          </h2>
          {/* pm07: specs cards */}
        </section>

        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-4">
          <h2 className="text-h3 font-semibold text-foreground">Prices</h2>
          {/* pm08: prices cards */}
        </section>
      </div>
    </div>
  );
}
