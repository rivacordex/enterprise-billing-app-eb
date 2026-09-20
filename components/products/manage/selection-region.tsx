import { PackageSearch, SearchX } from "lucide-react";

import { ManagePricesPanel } from "@/components/products/manage/manage-prices-panel";
import { ManageSpecificationsPanel } from "@/components/products/manage/manage-specifications-panel";
import { VersionActionHeader } from "@/components/products/manage/version-action-header";
import { OfferingDetail } from "@/components/products/offering-detail";
import type {
  LifecycleStatus,
  OfferingDetail as OfferingDetailModel,
} from "@/types/product";

// pm40 I5/D3/D4, extended by pm41 I4. Composes the selected version's detail,
// specifications and prices inside the D4 grid (detail full width → specs and
// prices side-by-side at `lg:`, stacking on narrow viewports), so page.tsx
// stays a thin orchestrator. The detail read view is View Product's read-only
// OfferingDetail (Inv. #29 — one-directional import); the specs and prices go
// through the Manage panels, which render read-only or inline-editable per
// `canEdit`. The version bar is rendered by the page above this region.
export interface SelectionRegionProps {
  // A family is selected in the URL (`?family=` present and well-formed).
  hasFamily: boolean;
  // The resolved version's detail; null when no family is selected, or when the
  // selected family matches no row (a stale link — the empty state says so).
  offering: OfferingDetailModel | null;
  // pm41 I4 — the version's panels edit inline only when true (DRAFT). Computed
  // by the page from PANEL_EDITABLE_BY_STATUS; defaults to read-only.
  canEdit?: boolean;
  // The selected family id, needed by the header's branch-then-navigate (D4).
  familyId?: string | null;
  // Carried through so the header's branch navigation preserves the list state.
  query?: string;
  status?: LifecycleStatus | null;
  page?: number;
  // Live-subscription count for the selected version — read by the page only for
  // an OBSOLETE version (pm43 I7), feeds the Retire dialog's blocked state.
  liveCount?: number;
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
  canEdit = false,
  familyId = null,
  query = "",
  status = null,
  page = 1,
  liveCount = 0,
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
        <div className="flex items-start justify-between gap-3">
          <h2 className="text-h3 font-semibold text-foreground">Details</h2>
          {familyId !== null ? (
            <VersionActionHeader
              offering={offering}
              familyId={familyId}
              query={query}
              status={status}
              page={page}
              liveCount={liveCount}
            />
          ) : null}
        </div>
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
          <ManageSpecificationsPanel
            canEdit={canEdit}
            offeringId={offering.productOfferingId}
            specifications={offering.specifications}
            familyId={familyId}
            query={query}
            status={status}
            page={page}
          />
        </section>

        <section className="rounded-md border border-border bg-[color:var(--surface-card)] p-3">
          <h2 className="text-h3 font-semibold text-foreground">Prices</h2>
          <ManagePricesPanel
            canEdit={canEdit}
            offeringId={offering.productOfferingId}
            offeringName={offering.name}
            prices={offering.prices}
            locale={locale}
            timezone={timezone}
            familyId={familyId}
            query={query}
            status={status}
            page={page}
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
