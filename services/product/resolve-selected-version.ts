import type { VersionSummary } from "@/types/product";

// pm40 D1 — the pure resolution of which version the panels show, given the
// family's versions (newest-first from findFamilyVersions) and the optional
// `?version=`. `version` is subordinate to `family`:
//
//   • family present, version absent            → the family's primary version
//   • family + version, version in the family   → that version
//   • version not a member of the family         → the primary version (silent
//     fallback for a stale link or hand-edited URL — never a 404, §3.3)
//   • family matches no row (no versions)        → null; the page renders the
//     empty-selection state, not an error boundary
//
// Primary is the same rule the families list uses (pm39 D1): the ACTIVE version,
// else the single open (DRAFT/TESTING) version, else the highest version number.
// Unit-tested on its own (pm40 I7) so the branch coverage does not depend on the
// page render.
export function resolveSelectedVersion(
  versions: VersionSummary[],
  requestedVersionId: string | null,
): string | null {
  if (versions.length === 0) return null;

  if (requestedVersionId !== null) {
    const requested = versions.find(
      (version) => version.productOfferingId === requestedVersionId,
    );
    if (requested) return requested.productOfferingId;
  }

  return primaryVersionId(versions);
}

// The primary-version priority (ACTIVE → open DRAFT/TESTING → highest version)
// is the SAME rule findFamilyPage encodes in SQL as its ROW_NUMBER `CASE`
// (db/repositories/product-offering.ts) to pick each family's primary row for the
// families table. The two must agree — the table row and the version this page
// auto-selects for that family are meant to be identical. If this priority
// changes, change findFamilyPage's CASE in the same edit (and vice versa).
function primaryVersionId(versions: VersionSummary[]): string | null {
  const active = versions.find(
    (version) => version.lifecycleStatus === "ACTIVE",
  );
  if (active) return active.productOfferingId;

  const open = versions.find(
    (version) =>
      version.lifecycleStatus === "DRAFT" ||
      version.lifecycleStatus === "TESTING",
  );
  if (open) return open.productOfferingId;

  // Versions arrive newest-first (version DESC), so the first is the highest.
  const highest = versions[0];
  return highest ? highest.productOfferingId : null;
}
