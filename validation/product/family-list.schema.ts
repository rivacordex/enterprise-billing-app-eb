import { z } from "zod";

import {
  listSearchBase,
  offeringIdParam,
} from "@/validation/product/list-search-params.base";

// Manage Products' list + selection state (pm39 I1). Lenient by design, like
// offering-list.schema.ts (code-standards §3.3): a tampered or stale URL renders
// defaults, never a 500. `family` and `version` are parsed here but first
// consumed in pm40 (the version bar and panels); they carry the offering-id
// format so a bad value degrades to null. The `q`/`status`/`page` triple and the
// id-param format are shared with offering-list via list-search-params.base.
export const familyListSearchParamsSchema = z.object({
  ...listSearchBase,
  family: offeringIdParam,
  version: offeringIdParam,
});
export type FamilyListSearchParams = z.infer<
  typeof familyListSearchParamsSchema
>;
