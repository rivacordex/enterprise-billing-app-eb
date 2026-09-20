import { EditableSpecifications } from "@/components/products/manage/editable-specifications";
import { SpecificationsPanel } from "@/components/products/specifications-panel";
import type { LifecycleStatus, SpecificationCard } from "@/types/product";

// pm41 I1/D1. One component per panel with a `canEdit` boolean, not two parallel
// components — the read-only and editable layouts must not drift apart. Stays a
// server component (D5/§3.6): the editable body is the client leaf, not this
// panel. When `!canEdit` it renders View Product's read-only SpecificationsPanel
// untouched (pm40's path, Inv. #29 one-directional import); when editable it
// hands the specs to the DRAFT-only client editor. The family + list params are
// carried so the editor can navigate to a new draft if a mid-edit ACTIVE race
// branches one (pm41 review #2 / D4).
export interface ManageSpecificationsPanelProps {
  canEdit: boolean;
  offeringId: string;
  specifications: SpecificationCard[];
  familyId: string | null;
  query: string;
  status: LifecycleStatus | null;
  page: number;
}

export function ManageSpecificationsPanel({
  canEdit,
  offeringId,
  specifications,
  familyId,
  query,
  status,
  page,
}: ManageSpecificationsPanelProps): React.JSX.Element {
  if (!canEdit) {
    return <SpecificationsPanel specifications={specifications} />;
  }

  return (
    <EditableSpecifications
      offeringId={offeringId}
      specifications={specifications}
      familyId={familyId}
      query={query}
      status={status}
      page={page}
    />
  );
}
