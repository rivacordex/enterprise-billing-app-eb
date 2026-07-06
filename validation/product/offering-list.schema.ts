import { z } from "zod";

import { LIFECYCLE_STATUSES } from "@/types/product";

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
  q: z.string().trim().max(100).catch(""),
  status: z.enum(LIFECYCLE_STATUSES).nullable().catch(null),
  sort: z.enum(OFFERING_SORT_VALUES).catch("name"),
  page: z.coerce.number().int().min(1).catch(1),
  offering: z
    .string()
    .regex(/^PRDOFR\d{6}$/)
    .nullable()
    .catch(null),
});
export type OfferingListSearchParams = z.infer<
  typeof offeringListSearchParamsSchema
>;
