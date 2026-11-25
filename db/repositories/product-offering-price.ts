// The price repository (pm38 → pm49 → pm71).
//
// pm71 (Part 6 — Normalize, code-standards §1.49–§1.52, §1.58–§1.61, §1.63):
// storage is a header row in `product_offering_price` plus its subtype rows in
// `pop_usage_rate` / `pop_flat_fee` / `pop_capacity_commitment` /
// `pop_motivation_step` (0056). The `PricingComponent` envelope is no longer
// stored anywhere; it is a projection, and this file is the ONLY place one is
// assembled from rows (`toEnvelope`) or decomposed into rows (`fromEnvelope`)
// — Inv. #61. Both are module-level exports so the round-trip guardrail (42)
// can call them; outside this file only `tests/**` may reference them
// (guardrail 41's placement arm).
//
//   - Three writes, unchanged in name and count (Inv. #1): `insertPrice`
//     (header → children), `updatePrice` (delete children → update header →
//     insert children, the §1.50 order for both "type changed" and "type
//     unchanged"), `deletePrice` (header; children by ON DELETE CASCADE). Every
//     write must run on a transaction: the completeness triggers are
//     INITIALLY DEFERRED (Inv. #63).
//   - One relational read: `findByOfferingIdWithDerivedEnd` is a single
//     `db.query.productOfferingPrice.findMany({ with })` statement — headers,
//     the `type` reference row, the three 1:1 subtypes and the steps — with the
//     derived-end `lead()` window in `extras`, partitioned on the plain-column
//     lane (product_offering_id, component_type, unit_of_measure, price_type).
//     **D9 form shipped: the relational builder** (the `extras` window is
//     accepted by drizzle-orm 0.45.2); the hand-written join fallback was not
//     needed.
//   - Numeric columns inside the relational query are selected as `::text`
//     (nested `extras`), never as the raw column: Drizzle builds a nested
//     relation with `json_build_array`, which renders `numeric` as a JSON
//     number and loses digits past ~15 significant figures (pm69's caps allow
//     18 and 20). The text form is the exact padded value ("100.000000") that
//     `canonicalDecimalString` was written for (§1.52).
//
// History: pm38 gave this repository update/delete (D3, the locked-parent
// DRAFT read); pm49 re-keyed it to `component_type` + the `price_component`
// envelope parsed once at the read boundary; pm46a added the flat-fee
// priceType term to the lane. pm71 keeps all three decisions and moves the
// envelope's storage out of jsonb.
import { and, asc, eq, getTableColumns, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";

import type { Database } from "@/db/client";
import {
  popCapacityCommitment,
  popFlatFee,
  popMotivationStep,
  popUsageRate,
  priceComponentType,
  productOffering,
  productOfferingPrice,
} from "@/db/schema/product";
import { canonicalDecimalString } from "@/lib/decimal-string";
import type {
  ComponentType,
  EnvelopePriceType,
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
// pm71 D7: exactly these ten fields, no `priceType` — the services spread the
// snapshot into the audit payload, so a new key would change every event
// (§1.63); the value is already inside `component.priceType`.
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
// §2.12), not a caller's choice. pm71: still the one place an envelope is
// built from a FORM's input; `fromEnvelope` below consumes what it builds.
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

// -- pm71: rows ⇄ envelope ----------------------------------------------------

// D2. Row types stay in this file (§2.28), never in types/product.ts. The
// children's property names are exactly the relation names pm70 declared on
// `productOfferingPriceRelations` (§2.27, plus the sixth `type` relation, D3),
// so a `db.query.productOfferingPrice.findMany({ with })` result is a
// `PriceRowWithChildren` without a mapping step. Numeric columns are strings
// at their declared scale ("100.000000") — the input `canonicalDecimalString`
// was written for (§1.52).
type PriceHeaderRow = typeof productOfferingPrice.$inferSelect;
type PriceTypeRow = typeof priceComponentType.$inferSelect;
type PriceChildren = {
  type: PriceTypeRow;
  usageRate: typeof popUsageRate.$inferSelect | null;
  flatFee: typeof popFlatFee.$inferSelect | null;
  capacityCommitment: typeof popCapacityCommitment.$inferSelect | null;
  motivationSteps: Array<typeof popMotivationStep.$inferSelect>; // ORDER BY above_quantity
};
type PriceRowWithChildren = PriceHeaderRow & PriceChildren;

// The `with` clause every relational price read uses. Each numeric column is
// excluded from `columns` and re-selected under the SAME key as `::text` in
// `extras` (see the file header: a nested relation is serialized through
// json_build_array, which would turn `numeric` into a lossy JSON number). The
// result is still structurally the `$inferSelect` row D2 names.
const PRICE_CHILDREN_WITH = {
  type: true,
  usageRate: {
    columns: {
      productOfferingPriceId: true,
      componentType: true,
      rateCardLookup: true,
    },
    extras: {
      ratePerUnit: sql<string>`${popUsageRate.ratePerUnit}::text`.as(
        "rate_per_unit",
      ),
    },
  },
  flatFee: {
    columns: { productOfferingPriceId: true, componentType: true },
    extras: {
      amount: sql<string>`${popFlatFee.amount}::text`.as("amount"),
    },
  },
  capacityCommitment: {
    columns: { productOfferingPriceId: true, componentType: true },
    extras: {
      committedQuantity:
        sql<string>`${popCapacityCommitment.committedQuantity}::text`.as(
          "committed_quantity",
        ),
    },
  },
  motivationSteps: {
    columns: { productOfferingPriceId: true, componentType: true },
    extras: {
      aboveQuantity: sql<string>`${popMotivationStep.aboveQuantity}::text`.as(
        "above_quantity",
      ),
      ratePerUnit: sql<string>`${popMotivationStep.ratePerUnit}::text`.as(
        "rate_per_unit",
      ),
    },
    orderBy: asc(popMotivationStep.aboveQuantity),
  },
} as const;

function requireChild<T>(
  child: T | null,
  header: PriceHeaderRow,
  table: string,
): T {
  if (child === null) {
    throw new Error(
      `toEnvelope: header ${header.productOfferingPriceId} (${header.componentType}) has no ${table} row`,
    );
  }
  return child;
}

// D4. Pure: header + subtype rows → the envelope, in today's key order
// (`buildComponentEnvelope`'s), then parsed — a row set that does not parse
// THROWS, exactly as the jsonb read path threw on a corrupt column (§1.49).
// `appliesAt` / `basis` (and the capacity types' `plaSpecId`) come from the
// `price_component_type` reference row, not a TypeScript constant (§1.59,
// Inv. #64/#65); usage_rate's `plaSpecId` is derived from `rate_card_lookup`
// because its reference row carries NULL. `"@type"` comes from the header — a
// child of another type cannot be attached (composite FK, Inv. #62), so the
// only thing to notice is an absent child. `canonicalDecimalString` is the
// only function that touches a money string's text (§2.31); quantities are
// `Number(...)` after the strip, never `parseFloat`.
export function toEnvelope(
  header: PriceHeaderRow,
  children: PriceChildren,
): PersistablePricingComponent {
  const componentType = header.componentType as ComponentType;
  const common = {
    "@type": componentType,
    specVersion: 1,
  } as const;
  const { appliesAt, basis } = children.type;
  let obj: Record<string, unknown>;
  switch (componentType) {
    case "usage_rate": {
      const usageRate = requireChild(
        children.usageRate,
        header,
        "pop_usage_rate",
      );
      obj = {
        ...common,
        plaSpecId: usageRate.rateCardLookup !== null ? "PLA_USAGE_RATE" : null,
        priceType: header.priceType,
        appliesAt,
        basis,
        boundTo: { unitOfMeasure: header.unitOfMeasure },
        params: {
          ratePerUnit: canonicalDecimalString(usageRate.ratePerUnit),
          rateCardLookUp: usageRate.rateCardLookup,
        },
      };
      break;
    }
    case "flat_fee": {
      const flatFee = requireChild(children.flatFee, header, "pop_flat_fee");
      obj = {
        ...common,
        plaSpecId: null,
        priceType: header.priceType,
        appliesAt,
        basis,
        boundTo: null,
        params: { amount: canonicalDecimalString(flatFee.amount) },
      };
      break;
    }
    case "capacity_commitment": {
      const commitment = requireChild(
        children.capacityCommitment,
        header,
        "pop_capacity_commitment",
      );
      obj = {
        ...common,
        plaSpecId: children.type.plaSpecId,
        priceType: header.priceType,
        appliesAt,
        basis,
        boundTo: { unitOfMeasure: header.unitOfMeasure },
        params: {
          committedQuantity: Number(
            canonicalDecimalString(commitment.committedQuantity),
          ),
        },
      };
      break;
    }
    case "capacity_motivation": {
      if (children.motivationSteps.length < 1) {
        throw new Error(
          `toEnvelope: header ${header.productOfferingPriceId} (${header.componentType}) has no pop_motivation_step row`,
        );
      }
      obj = {
        ...common,
        plaSpecId: children.type.plaSpecId,
        priceType: header.priceType,
        appliesAt,
        basis,
        boundTo: { unitOfMeasure: header.unitOfMeasure },
        params: {
          steps: children.motivationSteps.map((s) => ({
            aboveQuantity: Number(canonicalDecimalString(s.aboveQuantity)),
            ratePerUnit: canonicalDecimalString(s.ratePerUnit),
          })),
        },
      };
      break;
    }
    default: {
      const exhaustive: never = componentType;
      throw new Error(
        `toEnvelope: header ${header.productOfferingPriceId} has unknown component_type ${JSON.stringify(exhaustive)}`,
      );
    }
  }
  return persistablePricingComponentSchema.parse(obj);
}

type ChildWrite =
  | {
      table: "pop_usage_rate";
      row: { ratePerUnit: string; rateCardLookup: string | null };
    }
  | { table: "pop_flat_fee"; row: { amount: string } }
  | { table: "pop_capacity_commitment"; row: { committedQuantity: string } }
  | {
      table: "pop_motivation_step";
      rows: Array<{ aboveQuantity: string; ratePerUnit: string }>;
    };

// D5. The write-side decomposition. Money is written as the string Zod
// validated (pm69's cap guarantees it fits `numeric(18,6)`); a quantity as
// `String(n)` (pm69 proved that form matches `^\d{1,14}(\.\d{1,6})?$`, so no
// exponent reaches the column). Nothing here normalizes: "5500.00" is written
// as "5500.00" and read back as "5500" (C18) — which is why guardrail 42
// compares to `canonical(x)`, not `x`. The child's `component_type` is never
// written: each `pop_*` table's column takes its DEFAULT, pinned by its CHECK
// (§6.36), and the composite FK does the matching.
export function fromEnvelope(component: PersistablePricingComponent): {
  priceType: EnvelopePriceType;
  child: ChildWrite;
} {
  switch (component["@type"]) {
    case "usage_rate":
      return {
        priceType: component.priceType,
        child: {
          table: "pop_usage_rate",
          row: {
            ratePerUnit: component.params.ratePerUnit,
            rateCardLookup: component.params.rateCardLookUp,
          },
        },
      };
    case "flat_fee":
      return {
        priceType: component.priceType,
        child: {
          table: "pop_flat_fee",
          row: { amount: component.params.amount },
        },
      };
    case "capacity_commitment":
      return {
        priceType: component.priceType,
        child: {
          table: "pop_capacity_commitment",
          row: {
            committedQuantity: String(component.params.committedQuantity),
          },
        },
      };
    case "capacity_motivation":
      return {
        priceType: component.priceType,
        child: {
          table: "pop_motivation_step",
          rows: component.params.steps.map((s) => ({
            aboveQuantity: String(s.aboveQuantity),
            ratePerUnit: s.ratePerUnit,
          })),
        },
      };
    default: {
      const exhaustive: never = component;
      throw new Error(
        `fromEnvelope: unhandled component ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// D7. The audit snapshot — today's ten fields in today's key order (the old
// column map's order with `component` last), `component` reassembled by
// `toEnvelope` from rows read or returned inside the same transaction (§1.63).
function toSnapshot(
  header: PriceHeaderRow,
  children: PriceChildren,
): PriceWriteSnapshot {
  return {
    productOfferingId: header.productOfferingId,
    name: header.name,
    componentType: header.componentType as ComponentType,
    currency: header.currency,
    glCode: header.glCode,
    recurringChargePeriodLength: header.recurringChargePeriodLength,
    recurringChargePeriodType: header.recurringChargePeriodType,
    unitOfMeasure: header.unitOfMeasure,
    startDateTime: header.startDateTime,
    component: toEnvelope(header, children),
  };
}

// The header's reference row, returned by the header INSERT/UPDATE itself as a
// scalar subquery (D6), so a write's `after` envelope needs no extra read. The
// keys are the `$inferSelect` names of `price_component_type`.
function typeRowReturning(componentType: ComponentType) {
  return sql<PriceTypeRow>`(
    SELECT json_build_object(
      'componentType', t.component_type,
      'appliesAt', t.applies_at,
      'basis', t.basis,
      'plaSpecId', t.pla_spec_id,
      'applyOrder', t.apply_order
    )
    FROM ${priceComponentType} t
    WHERE t.component_type = ${componentType}
  )`;
}

const HEADER_RETURNING = getTableColumns(productOfferingPrice);

function withTypeRow(
  row: PriceHeaderRow & { type: PriceTypeRow | null },
): PriceHeaderRow & { type: PriceTypeRow } {
  if (row.type === null) {
    throw new Error(
      `price ${row.productOfferingPriceId}: no price_component_type row for ${row.componentType}`,
    );
  }
  return { ...row, type: row.type };
}

// Writes the subtype row (or step rows) for one header, `RETURNING *`. Steps
// are one multi-row INSERT; their RETURNING order is not promised, so they are
// put back in ascending threshold order (each is a JS number's `String()`, so
// `Number` of the canonical text is exact).
async function insertChildren(
  tx: Database,
  productOfferingPriceId: string,
  child: ChildWrite,
): Promise<Omit<PriceChildren, "type">> {
  const none = {
    usageRate: null,
    flatFee: null,
    capacityCommitment: null,
    motivationSteps: [],
  };
  switch (child.table) {
    case "pop_usage_rate": {
      const [row] = await tx
        .insert(popUsageRate)
        .values({ productOfferingPriceId, ...child.row })
        .returning();
      return { ...none, usageRate: row ?? null };
    }
    case "pop_flat_fee": {
      const [row] = await tx
        .insert(popFlatFee)
        .values({ productOfferingPriceId, ...child.row })
        .returning();
      return { ...none, flatFee: row ?? null };
    }
    case "pop_capacity_commitment": {
      const [row] = await tx
        .insert(popCapacityCommitment)
        .values({ productOfferingPriceId, ...child.row })
        .returning();
      return { ...none, capacityCommitment: row ?? null };
    }
    case "pop_motivation_step": {
      const rows = await tx
        .insert(popMotivationStep)
        .values(child.rows.map((r) => ({ productOfferingPriceId, ...r })))
        .returning();
      const ascending = [...rows].sort(
        (a, b) =>
          Number(canonicalDecimalString(a.aboveQuantity)) -
          Number(canonicalDecimalString(b.aboveQuantity)),
      );
      return { ...none, motivationSteps: ascending };
    }
    default: {
      const exhaustive: never = child;
      throw new Error(
        `insertChildren: unhandled child ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// D6 step 3: removes the header's current subtype row(s) — the table is the
// header's CURRENT (pre-update) type.
async function deleteChildren(
  tx: Database,
  productOfferingPriceId: string,
  componentType: ComponentType,
): Promise<void> {
  switch (componentType) {
    case "usage_rate":
      await tx
        .delete(popUsageRate)
        .where(eq(popUsageRate.productOfferingPriceId, productOfferingPriceId));
      return;
    case "flat_fee":
      await tx
        .delete(popFlatFee)
        .where(eq(popFlatFee.productOfferingPriceId, productOfferingPriceId));
      return;
    case "capacity_commitment":
      await tx
        .delete(popCapacityCommitment)
        .where(
          eq(
            popCapacityCommitment.productOfferingPriceId,
            productOfferingPriceId,
          ),
        );
      return;
    case "capacity_motivation":
      await tx
        .delete(popMotivationStep)
        .where(
          eq(popMotivationStep.productOfferingPriceId, productOfferingPriceId),
        );
      return;
    default: {
      const exhaustive: never = componentType;
      throw new Error(
        `deleteChildren: unhandled component_type ${JSON.stringify(exhaustive)}`,
      );
    }
  }
}

// One price with all its rows, in one relational statement (§1.61) — the
// before-snapshot read of `updatePrice` / `deletePrice`.
async function findPriceWithChildren(
  tx: Database,
  productOfferingPriceId: string,
): Promise<PriceRowWithChildren | undefined> {
  return tx.query.productOfferingPrice.findFirst({
    where: eq(
      productOfferingPrice.productOfferingPriceId,
      productOfferingPriceId,
    ),
    with: PRICE_CHILDREN_WITH,
  });
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

// pm38-spec I3 (amended Inv. #1), reshaped by pm49 (D1/D2) and pm71 (D6). This
// repository exports exactly three writes — `insertPrice`, `updatePrice`,
// `deletePrice` — and no fourth is ever added; the latter two refuse any
// parent whose `lifecycle_status` is not `DRAFT`, read under `FOR UPDATE` in
// the same transaction, mirroring the §3.5 trigger that backstops a direct SQL
// write (prodmgmt-code-standards.md §1.2, Appendix A). Authoring four
// component types is four *payloads* through one insert, not four writes.
// Every write runs on a transaction `tx` — never a bare connection: the
// completeness triggers are INITIALLY DEFERRED, so on autocommit the header
// INSERT fails 23514 before its child is written (Inv. #63). The fix is always
// the transaction, never the trigger.
//
// Query count per write (§3.24): insert 2; update 1 lock + 1 read + 3 writes;
// delete 1 lock + 1 read + 1 write — fixed per write, never per row.
export const productOfferingPriceRepository = {
  // Backs the prices panel (pm03-spec §3.4, §3.6), reshaped by pm49 D2/D3 and
  // pm71 D9. pm49 read `component_type` + `price_component` instead of the four
  // dropped columns and parsed the envelope once at this read boundary; pm71
  // reads the header and every subtype row in ONE relational statement (lateral
  // joins for the 1:1 rows and the reference row, one `json_agg` lateral for
  // the steps — never a query per row, never a `Promise.all` over headers,
  // §1.61) and reassembles the envelope through `toEnvelope`, which still
  // parses it — a row set that does not parse is a corruption and throws,
  // rather than rendering a partial card. The derived end (`LEAD` window) is
  // partitioned by the plain-column price lane `(product_offering_id,
  // component_type, unit_of_measure, price_type)` — the same columns as the
  // unique lane index (pm46, extended by pm46a, re-keyed by pm70) minus the
  // start — so a newly added `capacity_motivation` never appears to supersede
  // the `usage_rate` beside it (pm49 D3), and a one-time `flat_fee` never ends
  // a recurring one (pm46a). The `where` applies before the window. Ordering
  // follows the partition, then `start_date_time`, then id.
  async findByOfferingIdWithDerivedEnd(
    db: Database,
    productOfferingId: string,
  ): Promise<Array<Omit<PriceCard, "effectivityStatus">>> {
    const rows = await db.query.productOfferingPrice.findMany({
      where: eq(productOfferingPrice.productOfferingId, productOfferingId),
      with: PRICE_CHILDREN_WITH,
      extras: {
        endDateTime: sql<
          Date | string | null
        >`lead(${productOfferingPrice.startDateTime}) over (
          partition by ${productOfferingPrice.productOfferingId}, ${productOfferingPrice.componentType}, ${productOfferingPrice.unitOfMeasure}, ${productOfferingPrice.priceType}
          order by ${productOfferingPrice.startDateTime}
        )`.as("end_date_time"),
      },
      orderBy: [
        asc(productOfferingPrice.componentType),
        asc(productOfferingPrice.unitOfMeasure),
        asc(productOfferingPrice.priceType),
        asc(productOfferingPrice.startDateTime),
        asc(productOfferingPrice.productOfferingPriceId),
      ],
    });

    return rows.map((row) => ({
      productOfferingPriceId: row.productOfferingPriceId,
      name: row.name,
      componentType: row.componentType as ComponentType,
      component: toEnvelope(row, row),
      currency: row.currency,
      unitOfMeasure: row.unitOfMeasure,
      recurringChargePeriodLength: row.recurringChargePeriodLength,
      recurringChargePeriodType: row.recurringChargePeriodType,
      glCode: row.glCode,
      policy: row.policy,
      startDateTime: row.startDateTime,
      createdAt: row.createdAt,
      endDateTime: toDateOrNull(row.endDateTime),
    }));
  },

  // pm15-spec §3.2, reshaped by pm49 I1.2 and pm71 D6. `productOfferingId` is
  // supplied by the caller — the service already knows whether that's the
  // original DRAFT offering or a freshly branched clone. `component_type` is
  // written from `data.component["@type"]` — the already-parsed envelope's own
  // discriminant — never re-derived from a separately-carried field that could
  // disagree, so Inv. #30 holds by construction; `price_type` likewise comes
  // from the envelope (`fromEnvelope`). Header, then children, on `tx`; the
  // deferred completeness trigger sees the header complete at COMMIT. The lane
  // unique index fires on the header INSERT under its unchanged name, so the
  // services' DUPLICATE_START mapping still holds (§1.51). No status backstop
  // here: "target is always DRAFT" is a caller guarantee, and the §3.5 trigger
  // refuses a write against a non-DRAFT parent regardless. Returns the envelope
  // reassembled from the RETURNING rows — the audit payload's `component`
  // (§1.63, D8).
  async insertPrice(
    tx: Database,
    data: { productOfferingId: string } & PriceWriteData,
  ): Promise<{
    productOfferingPriceId: string;
    component: PersistablePricingComponent;
  }> {
    const componentType = data.component["@type"];
    const { priceType, child } = fromEnvelope(data.component);
    const [header] = await tx
      .insert(productOfferingPrice)
      .values({
        productOfferingId: data.productOfferingId,
        name: data.name,
        componentType,
        priceType,
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
        ...HEADER_RETURNING,
        type: typeRowReturning(componentType),
      });
    if (!header) {
      throw new Error("insertPrice: insert returned no row");
    }
    const headerRow = withTypeRow(header);
    const children = await insertChildren(
      tx,
      headerRow.productOfferingPriceId,
      child,
    );
    return {
      productOfferingPriceId: headerRow.productOfferingPriceId,
      component: toEnvelope(headerRow, { type: headerRow.type, ...children }),
    };
  },

  // pm38-spec D3/I3, reshaped by pm49 I1.3/D4 and pm71 D6. Locks the parent
  // offering, refuses unless it is `DRAFT`, reads the before-snapshot (one
  // relational statement), then gives the caller's `validate` callback a
  // chance to refuse the write (pm49's offering-level validator,
  // code-standards §2.14) BEFORE anything is mutated — a rejected validation
  // returns straight through with nothing written, so the caller's
  // transaction commits a no-op rather than needing a rollback. Then, in this
  // order and no other (§1.50): delete the current children → update the
  // header → insert the new children. One sequence serves a type change and a
  // same-type edit alike (replace = DELETE then INSERT), so the two cases
  // cannot drift. The composite FK is NO ACTION, so a header `component_type`
  // UPDATE while a child references it fails (Inv. #70) — deleting first is
  // what makes it legal; the deferred trigger makes the intermediate state
  // legal until COMMIT (Inv. #63). Does NOT branch (D4 of pm38): changing a
  // specific existing price row on a released version is not a request to
  // create a new version. A duplicate lane start surfaces as a raw 23505 that
  // the service translates to `DUPLICATE_START`.
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

    // 1. Before snapshot. The parent lock is held; the row that produced
    // `locked` still exists.
    const beforeRow = await findPriceWithChildren(tx, productOfferingPriceId);
    if (!beforeRow) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }
    const before = toSnapshot(beforeRow, beforeRow);

    // 2. A refusal returns through with nothing written.
    const validation = await validate(locked.offeringId);
    if (!validation.ok) {
      return validation;
    }

    // 3. Delete the existing children (the header's CURRENT type).
    await deleteChildren(
      tx,
      productOfferingPriceId,
      beforeRow.componentType as ComponentType,
    );

    // 4. Update the header.
    const componentType = data.component["@type"];
    const { priceType, child } = fromEnvelope(data.component);
    const [afterHeader] = await tx
      .update(productOfferingPrice)
      .set({
        name: data.name,
        componentType,
        priceType,
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
      .returning({
        ...HEADER_RETURNING,
        type: typeRowReturning(componentType),
      });
    if (!afterHeader) {
      throw new Error(
        `updatePrice: price ${productOfferingPriceId} not found on offering ${locked.offeringId}`,
      );
    }
    const headerRow = withTypeRow(afterHeader);

    // 5. Insert the new children.
    const children = await insertChildren(tx, productOfferingPriceId, child);

    // 6. After snapshot from the RETURNING rows.
    return {
      ok: true,
      offeringId: locked.offeringId,
      before,
      after: toSnapshot(headerRow, { type: headerRow.type, ...children }),
    };
  },

  // pm38-spec D3/I3, reshaped by pm49 I1.3/D4 and pm71 D6. Locks the parent,
  // refuses unless `DRAFT`, reads the before-snapshot (a header row alone can no
  // longer produce one), runs the caller's `validate` callback before the
  // delete — this is what makes "deleting a base rate out from under a
  // modifier" a clean `MODIFIER_WITHOUT_BASE_RATE` refusal instead of an
  // orphaned modifier row. The children go by ON DELETE CASCADE (§6.36); the
  // completeness trigger's parent-gone branch passes. Does NOT branch (D4 of
  // pm38).
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

    const beforeRow = await findPriceWithChildren(tx, productOfferingPriceId);
    if (!beforeRow) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
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
      .returning({
        productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
        productOfferingId: productOfferingPrice.productOfferingId,
      });
    if (!deleted) {
      return { ok: false, code: "PRICE_NOT_FOUND" };
    }

    return {
      ok: true,
      offeringId: deleted.productOfferingId,
      before: toSnapshot(beforeRow, beforeRow),
    };
  },
};
