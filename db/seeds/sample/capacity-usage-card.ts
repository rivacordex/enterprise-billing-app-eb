import { and, eq } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { ratecardRanUsageLkp, ratecardVersion } from "@/db/schema/product";

// bm45-spec §Implementation §4 — the capacity profile's own usage lookup
// card fixture: an ACTIVE `product.ratecard_version` named by the capacity
// offering's `productCardLookUp` spec (`SAMPLE_CAPACITY_CARD_NAME` in
// seed-billrun-sample.ts), carrying `product.ratecard_ran_usage_lkp` rows for
// the appendix's mapped polygons and, since rm29, the anchor scenarios'
// synthetic polygons — `state`/`district`/`service_code` set,
// `rate_per_unit` left NULL (OV-2 — a validation/mapping card, never a rate
// source). Mirrors `sample-5g-fixture.ts`'s `insertRanRatecard` precedent
// (the bm45 spec's own §0 citation), extended to carry a distinct state/
// district PER row (the 5G fixture's rows all share one state) since the
// appendix fixture spans >= 2 states and >= 2 districts (bm45-spec
// §Implementation §4).
//
// Deliberately its OWN file, not folded into `seed-billrun-sample.ts`: the
// pm67 `ratecard-demo-seed-boundary` guardrail forbids that file from naming
// the card module/table at all (it exists to catch a FUTURE leak into that
// file); this is a different, sanctioned, spec-mandated direct-table seed
// (never the upload/activate service pipeline that guardrail actually
// polices), so it stays out of the two files that guardrail reads.
//
// Idempotent (bm45-spec §Implementation §4 "Seed (idempotently)"): a re-seed
// without teardown reuses the card name's existing ACTIVE version rather than
// inserting a second one, which would trip `ratecard_version_one_active_per_card`
// — `db:seed-sample`'s purge is scoped to the billing/customer graph and never
// touches this product-owned table. Each lookup row's natural key
// (`ratecard_version_id, mno_public_key, commercial_unit_public_key,
// polygon_id`) is `onConflictDoNothing`-guarded for the same reason.

export interface SampleUsageCardPolygon {
  mnoPublicKey: string;
  commercialUnitPublicKey: string;
  polygonId: string;
  state: string;
  district: string;
  serviceCode?: string | undefined;
}

// The labels a card cell actually holds, read back after the insert (rm29,
// Inv 28): a seeded udr_rated row mirrors these, never the caller's
// constants, so a cell kept from an earlier seed (onConflictDoNothing) can
// never disagree with the row that claims to match it.
export interface SampleUsageCardCell {
  state: string | null;
  district: string | null;
  polygonStartDate: string;
}

export function usageCardCellKey(p: {
  mnoPublicKey: string;
  commercialUnitPublicKey: string;
  polygonId: string;
}): string {
  return JSON.stringify([
    p.mnoPublicKey,
    p.commercialUnitPublicKey,
    p.polygonId,
  ]);
}

const SAMPLE_USAGE_CARD_START_DATE = "2020-01-01";
// rm29 — the anchor scenarios add one cell per 1-EA row (3,800), so the
// insert is chunked to stay well under Postgres's 65,535 bind-parameter cap.
const INSERT_CHUNK = 1000;

export async function ensureSampleCapacityUsageCard(
  cardName: string,
  polygons: readonly SampleUsageCardPolygon[],
): Promise<{
  cardVersionId: string;
  cells: Map<string, SampleUsageCardCell>;
}> {
  return db.transaction(async (tx) => {
    const cardVersionId = await findOrCreateActiveVersion(
      tx,
      cardName,
      polygons.length,
    );

    for (let i = 0; i < polygons.length; i += INSERT_CHUNK) {
      await tx
        .insert(ratecardRanUsageLkp)
        .values(
          polygons.slice(i, i + INSERT_CHUNK).map((p) => ({
            ratecardVersionId: cardVersionId,
            mnoPublicKey: p.mnoPublicKey,
            commercialUnitPublicKey: p.commercialUnitPublicKey,
            polygonId: p.polygonId,
            polygonStartDate: SAMPLE_USAGE_CARD_START_DATE,
            polygonEndDate: null,
            state: p.state,
            district: p.district,
            lkpSubscriberRefId: "_SAMPLE_billrun",
            serviceCode: p.serviceCode ?? null,
            ratePerUnit: null,
          })),
        )
        .onConflictDoNothing();
    }

    const rows = await tx
      .select({
        mnoPublicKey: ratecardRanUsageLkp.mnoPublicKey,
        commercialUnitPublicKey: ratecardRanUsageLkp.commercialUnitPublicKey,
        polygonId: ratecardRanUsageLkp.polygonId,
        state: ratecardRanUsageLkp.state,
        district: ratecardRanUsageLkp.district,
        polygonStartDate: ratecardRanUsageLkp.polygonStartDate,
      })
      .from(ratecardRanUsageLkp)
      .where(eq(ratecardRanUsageLkp.ratecardVersionId, cardVersionId));
    const cells = new Map<string, SampleUsageCardCell>(
      rows.map((r) => [
        usageCardCellKey(r),
        {
          state: r.state,
          district: r.district,
          polygonStartDate: r.polygonStartDate,
        },
      ]),
    );

    return { cardVersionId, cells };
  });
}

async function findOrCreateActiveVersion(
  tx: Database,
  cardName: string,
  rowCount: number,
): Promise<string> {
  const [existing] = await tx
    .select({ id: ratecardVersion.ratecardVersionId })
    .from(ratecardVersion)
    .where(
      and(
        eq(ratecardVersion.cardName, cardName),
        eq(ratecardVersion.status, "ACTIVE"),
      ),
    )
    .limit(1);
  if (existing) return existing.id;

  const [created] = await tx
    .insert(ratecardVersion)
    .values({
      cardName,
      versionNum: 1,
      status: "ACTIVE",
      snapshotDate: "2026-01-01",
      sourceFile: "_SAMPLE_billrun-usage-card",
      rowCount,
    })
    .returning({ id: ratecardVersion.ratecardVersionId });
  if (!created) {
    throw new Error(
      `ensureSampleCapacityUsageCard: insert of "${cardName}" returned no row.`,
    );
  }
  return created.id;
}
