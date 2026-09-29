"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import {
  activateRatecardVersion,
  type RatecardActivationDiffCounts,
} from "@/services/product/ratecard/activate-version";
import type { RateCardVersionStatus } from "@/types/product";
import { ratecardVersionIdSchema } from "@/validation/product/ratecard.schema";

// pm63-spec I2 — `ratecard : EDIT` (the same level as upload, RC7, §8) →
// isRedirectError catch → safeParse the version id against its RCV format
// schema → one service call → revalidatePath('/products/rate-card') → typed
// result (§3.7, §3.22). Deliberately the module's ORDINARY action shape
// (unlike upload's file-handling exception, §3.19) — the input here is a
// single string, not a file.

export type ActivateRatecardVersionActionResult =
  | {
      ok: true;
      versionId: string;
      supersededVersionId: string | null;
      diff: RatecardActivationDiffCounts;
    }
  | { ok: false; code: "VALIDATION_ERROR" }
  | { ok: false; code: "VERSION_NOT_FOUND" }
  | { ok: false; code: "NOT_DRAFT"; status: RateCardVersionStatus }
  | { ok: false; code: "FORBIDDEN" }
  | { ok: false; code: "SERVER_ERROR" };

export async function activateRatecardVersionAction(
  rawVersionId: unknown,
): Promise<ActivateRatecardVersionActionResult> {
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
    result = await activateRatecardVersion(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result;
  }

  // D9 (pm61 precedent) — the route doesn't exist yet (pm65), but
  // revalidating it now is harmless and means pm65 adds a page rather than a
  // missing call. §3.22 — this and nothing else.
  revalidatePath("/products/rate-card");

  return result;
}
