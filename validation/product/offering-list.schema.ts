import { z } from "zod";

import {
  listSearchBase,
  offeringIdParam,
} from "@/validation/product/list-search-params.base";

// One `sort` searchParam (pm02-spec Design #10): a sort key with an optional
// `-` prefix for descending. Default is `name` ascending — no separate `dir`
// param.
export const OFFERING_SORT_VALUES = [
  "name",
  "-name",
  "product_offering_id",
  "-product_offering_id",
  "lifecycle_status",
  "-lifecycle_status",
  "version",
  "-version",
  "last_modified",
  "-last_modified",
] as const;

// Lenient by design (audit-log-filters precedent, code-standards §3.3): a
// tampered or stale URL never 500s the page — every field falls back to its
// default on a parse failure.
export const offeringListSearchParamsSchema = z.object({
  ...listSearchBase,
  sort: z.enum(OFFERING_SORT_VALUES).catch("name"),
  offering: offeringIdParam,
});
export type OfferingListSearchParams = z.infer<
  typeof offeringListSearchParamsSchema
>;
