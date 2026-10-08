import { desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  billAssetVersion,
  type BillAssetVersion,
} from "@/db/schema/billing/bill-asset";

// bm50-spec §Design D9 — READ-ONLY repository over `bill_asset_version`. The
// logo upload (bm60) writes; this unit only reads for the profile preview and
// the version-history view.
export const billAssetRepository = {
  async findVersionById(
    db: Database,
    id: string,
  ): Promise<BillAssetVersion | null> {
    const [row] = await db
      .select()
      .from(billAssetVersion)
      .where(eq(billAssetVersion.billAssetVersionId, id))
      .limit(1);
    return row ?? null;
  },

  async listVersions(
    db: Database,
    assetId: string,
  ): Promise<BillAssetVersion[]> {
    return db
      .select()
      .from(billAssetVersion)
      .where(eq(billAssetVersion.refBillAssetId, assetId))
      .orderBy(desc(billAssetVersion.versionNo));
  },
};
