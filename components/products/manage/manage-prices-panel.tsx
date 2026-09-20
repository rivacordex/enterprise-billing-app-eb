import { EditablePrices } from "@/components/products/manage/editable-prices";
import { PricesPanel } from "@/components/products/prices-panel";
import type { LifecycleStatus, PriceCard } from "@/types/product";

// pm41 I2/D1. One component per panel with a `canEdit` boolean; stays a server
// component (D5/§3.6). When `!canEdit` it renders View Product's read-only
// PricesPanel untouched (pm40's path, Inv. #29); when editable it hands the
// prices to the DRAFT-only client editor. The effectivity tags, tier rendering
// and warning banners all come from the reused components — this unit adds no
// new copy. The family + list params are carried so the editor can navigate to
// a new draft if a mid-edit ACTIVE race branches one (pm41 review #2 / D4).
export interface ManagePricesPanelProps {
  canEdit: boolean;
  offeringId: string;
  offeringName: string;
  prices: PriceCard[];
  locale: string;
  timezone: string;
  familyId: string | null;
  query: string;
  status: LifecycleStatus | null;
  page: number;
}

export function ManagePricesPanel({
  canEdit,
  offeringId,
  offeringName,
  prices,
  locale,
  timezone,
  familyId,
  query,
  status,
  page,
}: ManagePricesPanelProps): React.JSX.Element {
  if (!canEdit) {
    return <PricesPanel prices={prices} locale={locale} timezone={timezone} />;
  }

  return (
    <EditablePrices
      offeringId={offeringId}
      offeringName={offeringName}
      prices={prices}
      locale={locale}
      timezone={timezone}
      familyId={familyId}
      query={query}
      status={status}
      page={page}
    />
  );
}
