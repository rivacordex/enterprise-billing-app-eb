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
