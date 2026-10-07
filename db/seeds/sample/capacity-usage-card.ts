import { and, eq } from "drizzle-orm";

import { db, type Database } from "@/db/client";
import { ratecardRanUsageLkp, ratecardVersion } from "@/db/schema/product";

// bm45-spec §Implementation §4 — the capacity profile's own usage lookup
// card fixture: an ACTIVE `product.ratecard_version` named by the capacity
// offering's `productCardLookUp` spec (`SAMPLE_CAPACITY_CARD_NAME` in
// seed-billrun-sample.ts), carrying `product.ratecard_ran_usage_lkp` rows for
// the appendix's mapped polygons — `state`/`district`/`service_code` set,
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

export async function ensureSampleCapacityUsageCard(
  cardName: string,
  polygons: readonly SampleUsageCardPolygon[],
): Promise<{ cardVersionId: string }> {
  return db.transaction(async (tx) => {
    const cardVersionId = await findOrCreateActiveVersion(
      tx,
      cardName,
      polygons.length,
    );

    if (polygons.length > 0) {
      await tx
        .insert(ratecardRanUsageLkp)
        .values(
          polygons.map((p) => ({
            ratecardVersionId: cardVersionId,
            mnoPublicKey: p.mnoPublicKey,
            commercialUnitPublicKey: p.commercialUnitPublicKey,
            polygonId: p.polygonId,
            polygonStartDate: "2020-01-01",
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

    return { cardVersionId };
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
