import { and, asc, eq, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import { productOffering, productOfferingPrice } from "@/db/schema/product";
import type {
  ComponentType,
  LifecycleStatus,
  PriceCard,
  RecurringPeriodType,
  UnitOfMeasure,
} from "@/types/product";
import type { InsertPriceInput } from "@/validation/product/insert-price.schema";
import {
  persistablePricingComponentSchema,
  type PersistablePricingComponent,
  type PricingComponent,
} from "@/validation/product/pricing-component.schema";

// The `LEAD` window column comes back as a JS `Date` in practice (the
// underlying PG type is still `timestamptz`), but this normalizes any
// string round-trip so `PriceCard.endDateTime`'s `Date | null` contract
// never leaks a string (pm03-spec §3.4).
function toDateOrNull(value: Date | string | null): Date | null {
  if (value === null) return null;
  return value instanceof Date ? value : new Date(value);
}

// The cross-row validator's result shape (services/product/validate-offering-
// components.ts, code-standards §2.14) — restated structurally here, not
// imported: this repository is an inner layer and never imports from
// services/ (code-standards §2, dependency rule). `updatePrice`/`deletePrice`
// below accept a `validate` callback typed against this shape so the caller
// (always a services/product/ write service) can run pm49's offering-level
// validator strictly between the DRAFT lock and the actual write, without the
// repository ever knowing the validator exists.
type OfferingComponentValidationResult =
  | { ok: true }
  | OfferingComponentValidationFailure;

// The `validate` callback's failure shapes only — the repository methods
// below only ever forward a REFUSAL past their own `{ ok: true }` |
// success-with-fields union (a bare, fieldless `{ ok: true }` is never
// actually returned to a caller, since the methods keep going past a
// successful validation to perform the write and return their own richer
// success shape). Declaring the method return type against this narrower
// failure-only type — instead of the full `OfferingComponentValidationResult`
// — is what lets a caller read `.before`/`.after`/`.offeringId` off a
// successful `UpdatePriceRepoResult`/`DeletePriceRepoResult` without TS
// widening to the validator's own, unrelated `{ ok: true }` shape.
type OfferingComponentValidationFailure =
  | {
      ok: false;
      code: "MODIFIER_WITHOUT_BASE_RATE";
      unitOfMeasure: UnitOfMeasure;
    }
  | { ok: false; code: "AMBIGUOUS_BASE_RATE" }
  | {
      ok: false;
      code: "CURRENCY_MISMATCH";
      existingCurrency: string;
      candidateCurrency: string;
    };

// The mutable snapshot of a price row that the update/delete services carry as
// the audit event's before/after payload — every column a write may change,
// plus the parent offering id. Not `PriceCard` (that has the derived
// `endDateTime`/`effectivityStatus`, which are not stored and not audited).
export interface PriceWriteSnapshot {
  productOfferingId: string;
  name: string;
  componentType: ComponentType;
  component: PricingComponent;
  currency: string;
  glCode: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
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
  componentType: ComponentType;
  component: PersistablePricingComponent;
  currency: string;
  glCode: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: RecurringPeriodType | null;
  unitOfMeasure: UnitOfMeasure | null;
  startDateTime: Date;
}

// Builds the envelope's own eight fields from a parsed price-input branch —
// row-level data (currency, unit, period) never enters `params`
// (code-standards §1.25); mirrors db/seeds/demo/product-demo.ts's
// `buildPriceEnvelope`, the seed's own copy of this same per-branch shape
// (pm48). `plaSpecId` is a cross-field literal per branch (code-standards
// §2.12), not a caller's choice.
function buildComponentEnvelope(
  input: InsertPriceInput,
): PersistablePricingComponent {
  switch (input.componentType) {
    case "usage_rate":
      return {
        "@type": "usage_rate",
        specVersion: 1,
        plaSpecId:
          input.params.rateCardLookUp !== null ? "PLA_USAGE_RATE" : null,
        priceType: "usage",
        appliesAt: "rating",
        basis: "quantity",
        boundTo: { unitOfMeasure: input.unitOfMeasure },
        params: input.params,
      };
    case "flat_fee":
      return {
        "@type": "flat_fee",
        specVersion: 1,
        plaSpecId: null,
        priceType: input.priceType,
        appliesAt: "billing",
        basis: "flat",
        boundTo: null,
        params: input.params,
      };
    case "capacity_commitment":
      return {
        "@type": "capacity_commitment",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_COMMITMENT",
        priceType: "commitment",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: input.unitOfMeasure },
        params: input.params,
      };
    case "capacity_motivation":
      return {
        "@type": "capacity_motivation",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_MOTIVATION",
        priceType: "discount",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: input.unitOfMeasure },
        params: input.params,
      };
    default: {
      const exhaustive: never = input;
      throw new Error(
        `Unhandled price input componentType: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// The row columns a branch allows — a usage_rate/capacity component always
// carries its unit and never a period; a flat_fee carries the period pair iff
// its envelope priceType is `recurring`, and never a unit (pm46 §3.3
// completeness).
function toComponentRowColumns(input: InsertPriceInput): {
  unitOfMeasure: UnitOfMeasure | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: RecurringPeriodType | null;
} {
  switch (input.componentType) {
    case "usage_rate":
    case "capacity_commitment":
    case "capacity_motivation":
      return {
        unitOfMeasure: input.unitOfMeasure,
        recurringChargePeriodLength: null,
        recurringChargePeriodType: null,
      };
    case "flat_fee":
      return input.priceType === "recurring"
        ? {
            unitOfMeasure: null,
            recurringChargePeriodLength: input.recurringChargePeriodLength,
            recurringChargePeriodType: input.recurringChargePeriodType,
          }
        : {
            unitOfMeasure: null,
            recurringChargePeriodLength: null,
            recurringChargePeriodType: null,
          };
    default: {
      const exhaustive: never = input;
      throw new Error(
        `Unhandled price input componentType: ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// Projects a validated price input into the write shape the repository
// writes — the single place a discriminated input becomes a component
// envelope plus its row columns, so insertPrice and updatePrice can never
// drift on which columns each component type writes (pm49-spec I1.2,
// carrying forward pm38-spec I4's original intent). `component` is parsed
// through `persistablePricingComponentSchema` here, once, so every caller
// downstream carries an already-validated envelope (Inv. #31).
export function toPriceWriteData(input: InsertPriceInput): PriceWriteData {
  const component = persistablePricingComponentSchema.parse(
    buildComponentEnvelope(input),
  );
  return {
    name: input.name,
    componentType: component["@type"],
    component,
    currency: input.currency,
    glCode: input.glCode,
    ...toComponentRowColumns(input),
    startDateTime: input.startDateTime,
  };
}

// The columns the write methods read back as a `PriceWriteSnapshot`.
const PRICE_SNAPSHOT_COLUMNS = {
  productOfferingId: productOfferingPrice.productOfferingId,
  name: productOfferingPrice.name,
  componentType: productOfferingPrice.componentType,
  priceComponent: productOfferingPrice.priceComponent,
  currency: productOfferingPrice.currency,
  glCode: productOfferingPrice.glCode,
  recurringChargePeriodLength: productOfferingPrice.recurringChargePeriodLength,
  recurringChargePeriodType: productOfferingPrice.recurringChargePeriodType,
  unitOfMeasure: productOfferingPrice.unitOfMeasure,
  startDateTime: productOfferingPrice.startDateTime,
} as const;

function toSnapshot(row: {
  productOfferingId: string;
  name: string;
  componentType: string;
  priceComponent: PricingComponent;
  currency: string;
  glCode: string | null;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  startDateTime: Date;
}): PriceWriteSnapshot {
  const { priceComponent, ...rest } = row;
  return {
    ...rest,
    componentType: row.componentType as ComponentType,
    component: priceComponent,
  };
}

// Resolves a price's parent offering, locks that parent row (`FOR UPDATE OF
// product_offering`) and returns the parent id alongside the locked status in
// one statement — the TOCTOU-safe status read the DRAFT guard on every price
// mutation depends on (pm38-spec D3, code-standards §1.13), now also the read
// pm49's cross-row validator's own sibling query runs after (the offering id
// is needed there too, so bundling it here keeps the write's query budget
// from growing, D10). A `WHERE … AND status = 'DRAFT'` variant is
// deliberately NOT used: it could not tell the caller whether the price was
// missing or the version released, and it would not hold the parent still for
// the write's duration.
async function lockParent(
  tx: Database,
  productOfferingPriceId: string,
): Promise<{ offeringId: string; lifecycleStatus: LifecycleStatus } | null> {
  // Postgres requires an UNQUALIFIED relation name after `FOR UPDATE OF`, so the
  // parent is aliased: Drizzle emits the bare alias (`"o"`) in the lock clause
  // instead of the schema-qualified `"product"."product_offering"` that errors
  // 42601. Same idiom as customerBillRepository's locked-parent read
  // (db/repositories/billing/customer-bill.repository.ts). Locks the parent
  // offering row for the transaction's duration (pm38-spec D3).
  const o = alias(productOffering, "o");
  const rows = await tx
    .select({
      offeringId: productOfferingPrice.productOfferingId,
      lifecycleStatus: o.lifecycleStatus,
    })
    .from(productOfferingPrice)
    .innerJoin(
      o,
      eq(o.productOfferingId, productOfferingPrice.productOfferingId),
    )
    .where(
      eq(productOfferingPrice.productOfferingPriceId, productOfferingPriceId),
    )
    .for("update", { of: o });
  const row = rows[0];
  return row
    ? {
        offeringId: row.offeringId,
        lifecycleStatus: row.lifecycleStatus as LifecycleStatus,
      }
    : null;
}

// pm38-spec I3 (amended Inv. #1), reshaped by pm49 (D1/D2). This repository
// exports exactly three writes — `insertPrice`, `updatePrice`, `deletePrice`
// — and no fourth is ever added; the latter two refuse any parent whose
// `lifecycle_status` is not `DRAFT`, read under `FOR UPDATE` in the same
// transaction, mirroring the §3.5 trigger that backstops a direct SQL write
// (prodmgmt-code-standards.md §1.2, Appendix A). Authoring four component
// types is four *payloads* through one insert, not four writes.
export const productOfferingPriceRepository = {
  // Backs the prices panel (pm03-spec §3.4, §3.6), reshaped by pm49 D2/D3.
  // Reads `component_type` + `price_component` instead of the four dropped
  // columns; the derived end (`LEAD` window) is now partitioned by
  // `(product_offering_id, component_type, unit_of_measure)` — the same key
  // as pm46's uniqueness constraint — so a newly added `capacity_motivation`
  // never appears to supersede the `usage_rate` beside it (D3). Ordering
  // follows the partition: `component_type`, then `unit_of_measure`, then
  // `start_date_time`, then id. The envelope is parsed once here, at the read
  // boundary, with `persistablePricingComponentSchema` (D2) — a row that
  // fails to parse is a corruption and throws, rather than rendering a
  // partial card.
  async findByOfferingIdWithDerivedEnd(
    db: Database,
    productOfferingId: string,
  ): Promise<Array<Omit<PriceCard, "effectivityStatus">>> {
    const rows = await db
      .select({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
        name: productOfferingPrice.name,
        priceComponent: productOfferingPrice.priceComponent,
        currency: productOfferingPrice.currency,
        recurringChargePeriodLength:
          productOfferingPrice.recurringChargePeriodLength,
        recurringChargePeriodType:
          productOfferingPrice.recurringChargePeriodType,
        unitOfMeasure: productOfferingPrice.unitOfMeasure,
        glCode: productOfferingPrice.glCode,
        policy: productOfferingPrice.policy,
        startDateTime: productOfferingPrice.startDateTime,
        createdAt: productOfferingPrice.createdAt,
        endDateTime: sql<
          Date | string | null
        >`lead(${productOfferingPrice.startDateTime}) over (
          partition by ${productOfferingPrice.productOfferingId}, ${productOfferingPrice.componentType}, ${productOfferingPrice.unitOfMeasure}
          order by ${productOfferingPrice.startDateTime}
        )`.as("end_date_time"),
      })
      .from(productOfferingPrice)
      .where(eq(productOfferingPrice.productOfferingId, productOfferingId))
      .orderBy(
        asc(productOfferingPrice.componentType),
        asc(productOfferingPrice.unitOfMeasure),
        asc(productOfferingPrice.startDateTime),
        asc(productOfferingPrice.productOfferingPriceId),
      );

    return rows.map((row) => {
      const component = persistablePricingComponentSchema.parse(
        row.priceComponent,
      );
      return {
        productOfferingPriceId: row.productOfferingPriceId,
        name: row.name,
        componentType: component["@type"],
        component,
        currency: row.currency,
        unitOfMeasure: row.unitOfMeasure,
        recurringChargePeriodLength: row.recurringChargePeriodLength,
        recurringChargePeriodType: row.recurringChargePeriodType,
        glCode: row.glCode,
        policy: row.policy,
        startDateTime: row.startDateTime,
        createdAt: row.createdAt,
        endDateTime: toDateOrNull(row.endDateTime),
      };
    });
  },

  // pm15-spec §3.2, reshaped by pm49 I1.2. `productOfferingId` is supplied by
  // the caller — the service already knows whether that's the original DRAFT
  // offering or a freshly branched clone. `component_type` is written from
  // `data.component["@type"]` — the already-parsed envelope's own
  // discriminant — never re-derived from a separately-carried field that
  // could disagree, so Inv. #30 holds by construction. No status backstop
  // here: "target is always DRAFT" is a caller guarantee, and the §3.5
  // trigger refuses a write against a non-DRAFT parent regardless.
  async insertPrice(
    tx: Database,
    data: { productOfferingId: string } & PriceWriteData,
  ): Promise<{ productOfferingPriceId: string }> {
    const [row] = await tx
      .insert(productOfferingPrice)
      .values({
        productOfferingId: data.productOfferingId,
        name: data.name,
        componentType: data.component["@type"],
        priceComponent: data.component,
        recurringChargePeriodLength: data.recurringChargePeriodLength,
        recurringChargePeriodType: data.recurringChargePeriodType,
        unitOfMeasure: data.unitOfMeasure,
        currency: data.currency,
        glCode: data.glCode,
        policy: null,
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

  // pm38-spec D3/I3, reshaped by pm49 I1.3/D4. Locks the parent offering,
  // refuses unless it is `DRAFT`, then gives the caller's `validate` callback
  // a chance to refuse the write (pm49's offering-level validator,
  // code-standards §2.14) BEFORE anything is mutated — a rejected validation
  // returns straight through with nothing written, so the caller's
  // transaction commits a no-op rather than needing a rollback. Only once
  // validation passes does the update happen and before/after get returned
  // for the audit event. Does NOT branch (D4 of pm38): changing a specific
  // existing price row on a released version is not a request to create a new
  // version. A duplicate `(offering, component_type, unit_of_measure,
  // start_date_time)` surfaces as a raw 23505 that the service translates to
  // `DUPLICATE_START`.
  async updatePrice(
    tx: Database,
    productOfferingPriceId: string,
    data: PriceWriteData,
    validate: (
      offeringId: string,
    ) => Promise<OfferingComponentValidationResult>,
  ): Promise<UpdatePriceRepoResult | OfferingComponentValidationFailure> {
    const locked = await lockParent(tx, productOfferingPriceId);
    if (locked === null) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "DRAFT") {
      return {
        ok: false,
        code: "OFFERING_NOT_DRAFT",
        lifecycleStatus: locked.lifecycleStatus,
      };
    }

    const [beforeRow] = await tx
      .select(PRICE_SNAPSHOT_COLUMNS)
      .from(productOfferingPrice)
      .where(
        eq(productOfferingPrice.productOfferingPriceId, productOfferingPriceId),
      );
    // The parent lock is held; the row that produced `locked` still exists.
    if (!beforeRow) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }

    const validation = await validate(locked.offeringId);
    if (!validation.ok) {
      return validation;
    }

    const [afterRow] = await tx
      .update(productOfferingPrice)
      .set({
        name: data.name,
        componentType: data.component["@type"],
        priceComponent: data.component,
        currency: data.currency,
        glCode: data.glCode,
        recurringChargePeriodLength: data.recurringChargePeriodLength,
        recurringChargePeriodType: data.recurringChargePeriodType,
        unitOfMeasure: data.unitOfMeasure,
        startDateTime: data.startDateTime,
      })
      .where(
        and(
          eq(
            productOfferingPrice.productOfferingPriceId,
            productOfferingPriceId,
          ),
          eq(productOfferingPrice.productOfferingId, locked.offeringId),
        ),
      )
      .returning(PRICE_SNAPSHOT_COLUMNS);
    if (!afterRow) {
      throw new Error(
        `updatePrice: price ${productOfferingPriceId} not found on offering ${locked.offeringId}`,
      );
    }

    return {
      ok: true,
      offeringId: locked.offeringId,
      before: toSnapshot(beforeRow),
      after: toSnapshot(afterRow),
    };
  },

  // pm38-spec D3/I3, reshaped by pm49 I1.3/D4. Locks the parent, refuses
  // unless `DRAFT`, runs the caller's `validate` callback before the delete —
  // this is what makes "deleting a base rate out from under a modifier" a
  // clean `MODIFIER_WITHOUT_BASE_RATE` refusal instead of an orphaned
  // modifier row. Does NOT branch (D4 of pm38).
  async deletePrice(
    tx: Database,
    productOfferingPriceId: string,
    validate: (
      offeringId: string,
    ) => Promise<OfferingComponentValidationResult>,
  ): Promise<DeletePriceRepoResult | OfferingComponentValidationFailure> {
    const locked = await lockParent(tx, productOfferingPriceId);
    if (locked === null) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }
    if (locked.lifecycleStatus !== "DRAFT") {
      return {
        ok: false,
        code: "OFFERING_NOT_DRAFT",
        lifecycleStatus: locked.lifecycleStatus,
      };
    }

    const validation = await validate(locked.offeringId);
    if (!validation.ok) {
      return validation;
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
