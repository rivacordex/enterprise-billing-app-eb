import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { TieredPricingCharacteristics } from "@/validation/product/pricing-characteristics.schema";

// Declaration order IS lifecycle order (DRAFT → TESTING → ACTIVE → OBSOLETE →
// RETIRED). UI sort weight derives from the array index and the database enum
// (pm35) declares the same order, so `ORDER BY lifecycle_status` in SQL and
// sorting in TypeScript agree. Nothing else may re-declare this order — a
// second status list is a drift bug (pm37-spec D1).
export const LIFECYCLE_STATUSES = [
  "DRAFT",
  "TESTING",
  "ACTIVE",
  "OBSOLETE",
  "RETIRED",
] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const PRICE_TYPES = ["recurring", "usage", "once"] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const PRICING_MODELS = ["flat", "tiered"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

// Closed, case-sensitive unit vocabulary for `usage` prices, matching pm35's
// `product_offering_price_unit_value_check` exactly. Declared here with the
// other domain unions (code-standards §2.1); first consumed by pm38's price
// schema. Widening requires a migration changing the CHECK AND a confirmed
// bm29 mapping — never a TypeScript-only edit (pm37-spec D5).
export const UNITS_OF_MEASURE = ["Mbps", "GB", "MB", "EA"] as const;
export type UnitOfMeasure = (typeof UNITS_OF_MEASURE)[number];

// Recurring charge-period vocabulary, matching pm35's
// `product_offering_price_period_value_check`: `months` only, length ∈
// (1, 3, 12). Same widening rule as UNITS_OF_MEASURE — migration + confirmed
// bm29 mapping, never a TypeScript-only edit (pm37-spec D5).
export const RECURRING_PERIOD_TYPES = ["months"] as const;
export type RecurringPeriodType = (typeof RECURRING_PERIOD_TYPES)[number];

export const RECURRING_PERIOD_LENGTHS = [1, 3, 12] as const;
export type RecurringPeriodLength = (typeof RECURRING_PERIOD_LENGTHS)[number];

export type {
  ProductOffering,
  ProductOfferingInsert,
  ProductSpecification,
  ProductSpecificationInsert,
  ProductOfferingPrice,
  ProductOfferingPriceInsert,
} from "@/db/schema";

export const EFFECTIVITY_STATUSES = [
  "current",
  "future",
  "superseded",
] as const;
export type EffectivityStatus = (typeof EFFECTIVITY_STATUSES)[number];

export type OfferingListRow = {
  productOfferingId: string;
  name: string;
  lifecycleStatus: LifecycleStatus;
  version: number;
  isSellable: boolean;
  lastModified: Date;
  familyOfferingId: string | null; // lineage column, surfaced for family grouping (pm18 §2.2)
  billingOnly: boolean; // needed to prefill the Edit dialog (pm20 §2.3)
};

// Backs the Manage Products page only (pm18 §2.2). Not consumed by View
// Product or getOfferingDetail.
export type OfferingFamilyRow = {
  familyId: string;
  primary: OfferingListRow;
  versions: OfferingListRow[]; // version desc, primary included
};

export type OfferingListPage = {
  rows: OfferingListRow[];
  total: number; // matching rows across all pages (for "Page X of Y")
  page: number;
  pageSize: number; // the resolved (configurable) size
};

export type SpecificationCard = {
  productSpecId: string;
  name: string;
  isMandatory: boolean;
  isDefault: boolean;
  defaultValue: string | null;
  characteristics: ProductSpecCharacteristics; // flat string record (pm02 §3.6)
};

export type PriceCard = {
  productOfferingPriceId: string;
  name: string;
  priceType: PriceType;
  pricingModel: PricingModel;
  amount: string | null; // numeric → string (general §2.15)
  currency: string;
  recurringChargePeriodLength: number | null;
  recurringChargePeriodType: string | null;
  unitOfMeasure: string | null;
  glCode: string | null;
  policy: string | null; // carried, semantics deferred (workflow §5.1)
  pricingCharacteristics: TieredPricingCharacteristics | null;
  startDateTime: Date;
  createdAt: Date;
  endDateTime: Date | null; // derived; null = open-ended (Inv. #3)
  effectivityStatus: EffectivityStatus; // Design #10
};

export type OfferingDetail = {
  productOfferingId: string;
  name: string;
  isBundle: boolean;
  isSellable: boolean;
  billingOnly: boolean;
  lifecycleStatus: LifecycleStatus;
  version: number;
  lastModified: Date;
  lastEditedByName: string | null; // resolved from core.APPUSER (Design #6)
  specifications: SpecificationCard[];
  prices: PriceCard[];
};
