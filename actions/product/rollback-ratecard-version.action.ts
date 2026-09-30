"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  rollbackRatecardVersion,
  type RatecardRollbackDiffCounts,
} from "@/services/product/ratecard/rollback-version";
import type { RateCardVersionStatus } from "@/types/product";
import { ratecardVersionIdSchema } from "@/validation/product/ratecard.schema";

// pm64-spec I2 — `ratecard : EDIT` (the same level as upload and activate, RC7,
// §8) → isRedirectError catch → safeParse the version id against its RCV format
// schema → one service call → revalidatePath('/products/rate-card') → typed
// result (§3.7, §3.22). The module's ORDINARY action shape, identical to
// activate's (unlike upload's file-handling exception, §3.19) — the input here
// is a single string, not a file. Third and last of the three rate-card action
// files (§3.21).

export type RollbackRatecardVersionActionResult =
  | {
      ok: true;
      versionId: string;
      supersededVersionId: string | null;
      diff: RatecardRollbackDiffCounts;
    }
  | { ok: false; code: "VALIDATION_ERROR" }
  | { ok: false; code: "VERSION_NOT_FOUND" }
  | { ok: false; code: "NOT_SUPERSEDED"; status: RateCardVersionStatus }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function rollbackRatecardVersionAction(
  rawVersionId: unknown,
): Promise<RollbackRatecardVersionActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.RATECARD,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) {
      return { ok: false, code: "FORBIDDEN" };
    }
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = ratecardVersionIdSchema.safeParse(rawVersionId);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }

  let result;
  try {
    result = await rollbackRatecardVersion(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result;
  }

  // §3.22 — the card page and nothing else (pm65 builds the route; revalidating
  // it now is harmless, matching pm61/pm63's precedent).
  revalidatePath("/products/rate-card");

  return result;
}
