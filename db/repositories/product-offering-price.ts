import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import type {
  LifecycleStatus,
  PriceCard,
  PriceType,
  PricingModel,
  RecurringPeriodType,
  UnitOfMeasure,
} from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";
import type { TieredPricingCharacteristics } from "@/validation/product/pricing-characteristics.schema";

// The `LEAD` window column comes back as a JS `Date` in practice (the
// underlying PG type is still `timestamptz`), but this normalizes any
// string round-trip so `PriceCard.endDateTime`'s `Date | null` contract
// never leaks a string (pm03-spec §3.4).
function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

// The mutable snapshot of a price row that the update/delete services carry as
// the audit event's before/after payload — every column a write may change,
// plus the parent offering id. Not `PriceCard` (that has the derived
// `endDateTime`/`effectivityStatus`, which are not stored and not audited).
export interface PriceWriteSnapshot {
  productOfferingId: string;
  name: string;
  priceType: PriceType;
  currency: string;
  glCode: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  pricingModel: PricingModel;
  amount: string | null;
  pricingCharacteristics: TieredPricingCharacteristics | null;
  startDateTime: Date;
}

export type UpdatePriceRepoResult =
  | {
      ok: true;
      offeringId: string;
      before: PriceWriteSnapshot;
      after: PriceWriteSnapshot;
    }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT"; lifecycleStatus: LifecycleStatus };

export type DeletePriceRepoResult =
  | { ok: true; offeringId: string; before: PriceWriteSnapshot }
  | { ok: false; code: "PRICE_NOT_FOUND" }
  | { ok: false; code: "OFFERING_NOT_DRAFT"; lifecycleStatus: LifecycleStatus };

export interface PriceWriteData {
  name: string;
  priceType: PriceType;
  currency: string;
  glCode: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: RecurringPeriodType | null;
  unitOfMeasure: UnitOfMeasure | null;
  pricingModel: PricingModel;
  amount: string | null;
  pricingCharacteristics: TieredPricingCharacteristics | null;
  startDateTime: Date;
}

// Projects a validated, discriminated price input into the flat column shape the
// repository writes — the single place the per-price-type completeness rule is
// applied (recurring carries its charge period and no unit, usage a unit and no
// period, once neither), so insertPrice and updatePrice can never drift on which
// columns each type writes (pm38-spec I4). The discriminant makes each ternary
// only ever read a field its branch actually declares.
export function toPriceWriteData(input: InsertPriceInput): PriceWriteData {
  return {
    name: input.name,
    priceType: input.priceType,
    currency: input.currency,
    glCode: input.glCode,
    recurringChargePeriodLength:
      input.priceType === "recurring"
        ? input.recurringChargePeriodLength
        : null,
    recurringChargePeriodType:
      input.priceType === "recurring" ? input.recurringChargePeriodType : null,
    unitOfMeasure: input.priceType === "usage" ? input.unitOfMeasure : null,
    pricingModel: input.priceCharacteristics.pricing_model,
    amount: input.priceCharacteristics.amount,
    pricingCharacteristics: input.priceCharacteristics.pricing_characteristics,
    startDateTime: input.startDateTime,
  };
}

// The columns the write methods read back as a `PriceWriteSnapshot`.
const PRICE_SNAPSHOT_COLUMNS = {
  productOfferingId: productOfferingPrice.productOfferingId,
  name: productOfferingPrice.name,
  priceType: productOfferingPrice.priceType,
  currency: productOfferingPrice.currency,
  glCode: productOfferingPrice.glCode,
  recurringChargePeriodLength: productOfferingPrice.recurringChargePeriodLength,
  recurringChargePeriodType: productOfferingPrice.recurringChargePeriodType,
  unitOfMeasure: productOfferingPrice.unitOfMeasure,
  pricingModel: productOfferingPrice.pricingModel,
  amount: productOfferingPrice.amount,
  pricingCharacteristics: productOfferingPrice.pricingCharacteristics,
  startDateTime: productOfferingPrice.startDateTime,
} as const;

function toSnapshot(row: {
  productOfferingId: string;
  name: string;
  priceType: string;
  currency: string;
  glCode: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  pricingModel: string;
  amount: string | null;
  pricingCharacteristics: TieredPricingCharacteristics | null;
  startDateTime: Date;
}): PriceWriteSnapshot {
  return {
    ...row,
    priceType: row.priceType as PriceType,
    pricingModel: row.pricingModel as PricingModel,
  };
}

// Resolves a price's parent offering and locks that parent row
// (`FOR UPDATE OF product_offering`) — the TOCTOU-safe status read the DRAFT
// guard on every price mutation depends on (pm38-spec D3, code-standards §1.13).
// A `WHERE … AND status = 'DRAFT'` variant is deliberately NOT used: it could
// not tell the caller whether the price was missing or the version released,
// and it would not hold the parent still for the write's duration.
async function lockParentStatus(
  tx: Database,
  productOfferingPriceId: string,
): Promise<LifecycleStatus | null> {
  // Postgres requires an UNQUALIFIED relation name after `FOR UPDATE OF`, so the
  // parent is aliased: Drizzle emits the bare alias (`"o"`) in the lock clause
  // instead of the schema-qualified `"product"."product_offering"` that errors
  // 42601. Same idiom as customerBillRepository's locked-parent read
  // (db/repositories/billing/customer-bill.repository.ts). Locks the parent
  // offering row for the transaction's duration (pm38-spec D3).
  const o = alias(productOffering, "o");
  const rows = await tx
    .select({ lifecycleStatus: o.lifecycleStatus })
    .from(productOfferingPrice)
    .innerJoin(
      o,
      eq(o.productOfferingId, productOfferingPrice.productOfferingId),
    )
    .where(
      eq(productOfferingPrice.productOfferingPriceId, productOfferingPriceId),
    )
    .for("update", { of: o });
  return rows[0]?.lifecycleStatus ?? null;
}

// pm38-spec I3 (amended Inv. #1). This repository exports exactly three writes —
// `insertPrice`, `updatePrice`, `deletePrice` — and no fourth is ever added; the
// latter two refuse any parent whose `lifecycle_status` is not `DRAFT`, read
// under `FOR UPDATE` in the same transaction, mirroring the §3.5 trigger that
// backstops a direct SQL write (prodmgmt-code-standards.md §1.2, Appendix A).
// The original "insertPrice is the only write this repository will ever gain"
// wording predated any editable draft state.
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

  // pm15-spec §3.2, extended by pm38-spec I4. `productOfferingId` is supplied by
  // the caller — the service already knows whether that's the original DRAFT
  // offering or a freshly branched clone. The per-price-type completeness
  // columns (`recurring_charge_period_*` for recurring, `unit_of_measure` for
  // usage) are now written from the parsed discriminated input rather than
  // hardcoded `NULL`, so a recurring/usage insert satisfies pm35's CHECKs
  // (`product_offering_price_recurring_period_check` / `_usage_unit_check`). No
  // status backstop here: "target is always DRAFT" is a caller guarantee, and
  // the §3.5 trigger refuses a write against a non-DRAFT parent regardless.
  async insertPrice(
    tx: Database,
    data: { productOfferingId: string } & PriceWriteData,
  ): Promise<{ productOfferingPriceId: string }> {
    const [row] = await tx
      .insert(productOfferingPrice)
      .values({
        productOfferingId: data.productOfferingId,
        name: data.name,
        priceType: data.priceType,
        recurringChargePeriodLength: data.recurringChargePeriodLength,
        recurringChargePeriodType: data.recurringChargePeriodType,
        unitOfMeasure: data.unitOfMeasure,
        amount: data.amount,
        currency: data.currency,
        glCode: data.glCode,
        pricingModel: data.pricingModel,
        policy: null,
        pricingCharacteristics: data.pricingCharacteristics,
        startDateTime: data.startDateTime,
        // `productOfferingPriceId` and `createdAt` both absent — fall through
        // to their column defaults (fresh PRDOFP… id, `now()`).
      })
      .returning({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
      });
    if (!row) {
      throw new Error("insertPrice: insert returned no row");
    }
    return { productOfferingPriceId: row.productOfferingPriceId };
  },

  // pm38-spec D3/I3. Locks the parent offering, refuses unless it is `DRAFT`,
  // then updates the price in place and returns before/after for the audit
  // event. Does NOT branch (D4): changing a specific existing price row on a
  // released version is not a request to create a new version. A duplicate
  // `(offering, price_type, start_date_time)` surfaces as a raw 23505 that the
  // service translates to `DUPLICATE_START`.
  async updatePrice(
    tx: Database,
    productOfferingPriceId: string,
    data: PriceWriteData,
  ): Promise<UpdatePriceRepoResult> {
    const status = await lockParentStatus(tx, productOfferingPriceId);
    if (status === null) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }
    if (status !== "DRAFT") {
      return { ok: false, code: "OFFERING_NOT_DRAFT", lifecycleStatus: status };
    }

    const [beforeRow] = await tx
      .select(PRICE_SNAPSHOT_COLUMNS)
      .from(productOfferingPrice)
      .where(
        eq(productOfferingPrice.productOfferingPriceId, productOfferingPriceId),
      );
    // The parent lock is held; the row that produced `status` still exists.
    if (!beforeRow) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }

    const [afterRow] = await tx
      .update(productOfferingPrice)
      .set({
        name: data.name,
        priceType: data.priceType,
        currency: data.currency,
        glCode: data.glCode,
        recurringChargePeriodLength: data.recurringChargePeriodLength,
        recurringChargePeriodType: data.recurringChargePeriodType,
        unitOfMeasure: data.unitOfMeasure,
        pricingModel: data.pricingModel,
        amount: data.amount,
        pricingCharacteristics: data.pricingCharacteristics,
        startDateTime: data.startDateTime,
      })
      .where(
        and(
          eq(
            productOfferingPrice.productOfferingPriceId,
            productOfferingPriceId,
          ),
          eq(
            productOfferingPrice.productOfferingId,
            beforeRow.productOfferingId,
          ),
        ),
      )
      .returning(PRICE_SNAPSHOT_COLUMNS);
    if (!afterRow) {
      throw new Error(
        `updatePrice: price ${productOfferingPriceId} not found on offering ${beforeRow.productOfferingId}`,
      );
    }

    return {
      ok: true,
      offeringId: beforeRow.productOfferingId,
      before: toSnapshot(beforeRow),
      after: toSnapshot(afterRow),
    };
  },

  // pm38-spec D3/I3. Locks the parent, refuses unless `DRAFT`, then hard-deletes
  // the price and returns its prior snapshot as the audit event's `beforeData`.
  // Does NOT branch (D4).
  async deletePrice(
    tx: Database,
    productOfferingPriceId: string,
  ): Promise<DeletePriceRepoResult> {
    const status = await lockParentStatus(tx, productOfferingPriceId);
    if (status === null) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }
    if (status !== "DRAFT") {
      return { ok: false, code: "OFFERING_NOT_DRAFT", lifecycleStatus: status };
    }

    const [deleted] = await tx
      .delete(productOfferingPrice)
      .where(
        eq(productOfferingPrice.productOfferingPriceId, productOfferingPriceId),
      )
      .returning(PRICE_SNAPSHOT_COLUMNS);
    if (!deleted) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }

    return {
      ok: true,
      offeringId: deleted.productOfferingId,
      before: toSnapshot(deleted),
    };
  },
};
