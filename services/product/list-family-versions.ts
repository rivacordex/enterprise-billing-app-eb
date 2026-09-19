import { db } from "@/db/client";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import type { VersionSummary } from "@/types/product";

// Backs the Manage Products version bar (pm40 I2). A thin pass-through with an
// explicit return type — it exists only so the page never touches a repository
// (architecture §2's boundary rule), not because it holds logic. The repository
// owns the family-key resolution and the version-DESC ordering. Framework-
// agnostic: a parsed offering id in, a `VersionSummary[]` read model out (§2.2).
export async function listFamilyVersions(
  familyId: string,
): Promise<VersionSummary[]> {
  return productOfferingRepository.findFamilyVersions(db, familyId);
}
