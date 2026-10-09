import { db } from "@/db/client";
import {
  getCompanyProfilePageModel,
  getVerifiedLogo,
  type VerifiedLogo,
} from "@/services/billing/invoice-profile/read-profile";
import type { CompanyProfilePageModel } from "@/types/billing";

// bm56-spec §Design D1/D3: the Company profile page's and the logo route's
// reads. Pages and route handlers reach the DB only through a service
// (code-standards §3.1), so these bind the shared `db` to the view-model
// and verified-logo reads. Nothing is cached.
export function getCompanyProfilePage(input: {
  version?: number | undefined;
  canEdit: boolean;
}): Promise<CompanyProfilePageModel> {
  return getCompanyProfilePageModel(db, input);
}

export function getCompanyProfileLogo(
  assetVersionId: string,
): Promise<VerifiedLogo | null> {
  return getVerifiedLogo(db, assetVersionId);
}
