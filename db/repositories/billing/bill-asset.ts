import { asc, desc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import {
  billAsset,
  billAssetVersion,
  type BillAsset,
  type BillAssetVersion,
} from "@/db/schema/billing/bill-asset";
import type { LogoMimeType } from "@/types/billing";

// bm50-spec §Design D9 — repository over `bill_asset` / `bill_asset_version`.
// bm60 adds the logo-upload writes (`ensureLogoAsset`, `insertVersion`). Both
// tables are write-once / retire-only (`bill_asset_version_guard`, Inv #44):
// nothing here updates or deletes a version.
const LOGO_KIND = "logo";
const LOGO_NAME = "Company logo";

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

  // bm60 D8 — the single `kind = 'logo'` asset, or `null` before the first
  // upload.
  async findLogoAsset(db: Database): Promise<BillAsset | null> {
    const [row] = await db
      .select()
      .from(billAsset)
      .where(eq(billAsset.kind, LOGO_KIND))
      .orderBy(asc(billAsset.billAssetId))
      .limit(1);
    return row ?? null;
  },

  // bm60 D5 step 2 — the single logo asset, created on first upload. Run in a
  // short transaction of its own (before the blob write); the advisory lock
  // makes two concurrent first uploads share one asset (there is no unique
  // key on `kind`).
  async ensureLogoAsset(tx: Database, actor: string): Promise<BillAsset> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`billing.bill_asset:${LOGO_KIND}`}))`,
    );
    const existing = await this.findLogoAsset(tx);
    if (existing) return existing;
    const [created] = await tx
      .insert(billAsset)
      .values({ kind: LOGO_KIND, name: LOGO_NAME, createdBy: actor })
      .returning();
    if (!created) throw new Error("ensureLogoAsset returned no row");
    return created;
  },

  // bm60 D5 step 4 — a new ACTIVE version at `max(version_no) + 1` under the
  // per-asset lock (`basv_version_uq` is the backstop). Earlier versions are
  // never retired here: profiles pin them (Inv #44).
  async insertVersion(
    tx: Database,
    input: {
      assetId: string;
      mime: LogoMimeType;
      width: number;
      height: number;
      byteSize: number;
      blobRef: string;
      checksum: string;
      actor: string;
    },
  ): Promise<BillAssetVersion> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`billing.bill_asset_version:${input.assetId}`}))`,
    );
    const [max] = await tx
      .select({
        versionNo: sql<number>`COALESCE(max(${billAssetVersion.versionNo}), 0)::int`,
      })
      .from(billAssetVersion)
      .where(eq(billAssetVersion.refBillAssetId, input.assetId));
    const [row] = await tx
      .insert(billAssetVersion)
      .values({
        refBillAssetId: input.assetId,
        versionNo: (max?.versionNo ?? 0) + 1,
        status: "ACTIVE",
        mime: input.mime,
        width: input.width,
        height: input.height,
        byteSize: input.byteSize,
        blobRef: input.blobRef,
        checksum: input.checksum,
        checksumAlgorithm: "sha256",
        createdBy: input.actor,
      })
      .returning();
    if (!row) throw new Error("insertVersion returned no row");
    return row;
  },
};
