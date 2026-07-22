import { asc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { productOfferingPrice } from "@/db/schema/product";
import type { PriceCard, PriceType, PricingModel } from "@/types/product";
import type { TieredPricingCharacteristics } from "@/validation/product/pricing-characteristics.schema";

// The `LEAD` window column comes back as a JS `Date` in practice (the
// underlying PG type is still `timestamptz`), but this normalizes any
// string round-trip so `PriceCard.endDateTime`'s `Date | null` contract
// never leaks a string (pm03-spec §3.4).
function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

// v1 exports finders only (Inv. #11) — and permanently, never `update*`/
// `delete*` (Inv. #1). The future `insertPrice` (INSERT successor + bump
// offering `version` in one transaction) is the only write the CRUD
// fast-follow may add to this module.
export const productOfferingPriceRepository = {
  // Backs the prices panel (pm03-spec §3.4, §3.6) — all price rows for the
  // offering, oldest to newest per `price_type`, with the derived end
  // (Design #3) computed by a `LEAD` window function partitioned per
  // `(product_offering_id, price_type)` so a different price_type's chain
  // never truncates this one's.
  async findByOfferingIdWithDerivedEnd(
    db: Database,
    productOfferingId: string,
  ): Promise<Array<Omit<PriceCard, "effectivityStatus">>> {
    const rows = await db
      .select({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
        name: productOfferingPrice.name,
        priceType: productOfferingPrice.priceType,
        pricingModel: productOfferingPrice.pricingModel,
        amount: productOfferingPrice.amount,
        currency: productOfferingPrice.currency,
        recurringChargePeriodLength:
          productOfferingPrice.recurringChargePeriodLength,
        recurringChargePeriodType:
          productOfferingPrice.recurringChargePeriodType,
        unitOfMeasure: productOfferingPrice.unitOfMeasure,
        glCode: productOfferingPrice.glCode,
        policy: productOfferingPrice.policy,
        pricingCharacteristics: productOfferingPrice.pricingCharacteristics,
        startDateTime: productOfferingPrice.startDateTime,
        createdAt: productOfferingPrice.createdAt,
        endDateTime: sql<
          Date | string | null
        >`lead(${productOfferingPrice.startDateTime}) over (
          partition by ${productOfferingPrice.productOfferingId}, ${productOfferingPrice.priceType}
          order by ${productOfferingPrice.startDateTime}
        )`.as("end_date_time"),
      })
      .from(productOfferingPrice)
      .where(eq(productOfferingPrice.productOfferingId, productOfferingId))
      .orderBy(
        asc(productOfferingPrice.priceType),
        asc(productOfferingPrice.startDateTime),
        asc(productOfferingPrice.productOfferingPriceId),
      );

    return rows.map((row) => ({
      ...row,
      priceType: row.priceType as PriceType,
      pricingModel: row.pricingModel as PricingModel,
      endDateTime: toDateOrNull(row.endDateTime),
    }));
  },

  // pm15-spec §3.2. The only write this repository will ever gain (Inv. #1,
  // permanent) — no update*/delete*, ever. `productOfferingId` is supplied by
  // the caller — the service already knows whether that's the original DRAFT
  // offering or a freshly branched clone (Design, mirroring pm14's
  // insertSpecification). No status backstop here: this table has no
  // lifecycle_status column of its own, and "target is always DRAFT" is a
  // caller guarantee (build plan's own wording, §pm15 header).
  async insertPrice(
    tx: Database,
    data: {
      productOfferingId: string;
      name: string;
      priceType: PriceType;
      currency: string;
      glCode: string | null;
      pricingModel: PricingModel;
      amount: string | null;
      pricingCharacteristics: TieredPricingCharacteristics | null;
      startDateTime: Date;
    },
  ): Promise<{ productOfferingPriceId: string }> {
    const [row] = await tx
      .insert(productOfferingPrice)
      .values({
        productOfferingId: data.productOfferingId,
        name: data.name,
        priceType: data.priceType,
        // Not yet user-settable in this phase (Design, field-scope note) —
        // columns stay nullable and untouched, matching Phase 1's own shape.
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
        unitOfMeasure: null,
        amount: data.amount,
        currency: data.currency,
        glCode: data.glCode,
        pricingModel: data.pricingModel,
        policy: null,
        pricingCharacteristics: data.pricingCharacteristics,
        startDateTime: data.startDateTime,
        // `productOfferingPriceId` and `createdAt` both absent — fall through
        // to their column defaults (fresh PRDOFP… id, `now()`), the same
        // "omitted, not merely coincidentally unset" discipline insertOffering
        // used for its own auto-generated id.
      })
      .returning({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
      });
    if (!row) {
      throw new Error("insertPrice: insert returned no row");
    }
    return { productOfferingPriceId: row.productOfferingPriceId };
  },
};
