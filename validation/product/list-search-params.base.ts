import { z } from "zod";

import { LIFECYCLE_STATUSES } from "@/types/product";

// Shared lenient base for the two product list surfaces — View Product's
// offering list and Manage Products' families list. Both parse the same
// `q`/`status`/`page` triple with the same catch-defaults, so a tampered or
// stale URL renders defaults rather than 500ing (code-standards §3.3). Each
// surface spreads this and adds its own sort/selection params (pm39 review dedup).
export const listSearchBase = {
  q: z.string().trim().max(100).catch(""),
  status: z.enum(LIFECYCLE_STATUSES).nullable().catch(null),
  page: z.coerce.number().int().min(1).catch(1),
};

// A nullable offering-id searchParam (selection state), shared by offering-list's
// `offering` and family-list's `family`/`version` — same format, same fallback.
export const offeringIdParam = z
  .string()
  .regex(/^PRDOFR\d+$/)
  .nullable()
  .catch(null);
