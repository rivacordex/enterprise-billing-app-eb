import type { ProductSpecCharacteristics } from "@/validation/product/product-spec-characteristics.schema";
import type { TieredPricingCharacteristics } from "@/validation/product/pricing-characteristics.schema";

export const LIFECYCLE_STATUSES = ["DRAFT", "ACTIVE", "RETIRED"] as const;
export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];

export const PRICE_TYPES = ["recurring", "usage", "once"] as const;
export type PriceType = (typeof PRICE_TYPES)[number];

export const PRICING_MODELS = ["flat", "tiered"] as const;
export type PricingModel = (typeof PRICING_MODELS)[number];

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
