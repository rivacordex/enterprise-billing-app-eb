"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { activateProfile } from "@/services/billing/invoice-profile/activate-profile";
import type { ProfileActivationErrorCode } from "@/types/billing";
import { activateProfileInputSchema } from "@/validation/billing/activate-version.schema";

export type ActivateProfileActionResult =
  | { ok: true; configVersion: number; retiredVersion: number | null }
  | { ok: false; code: "FORBIDDEN" | "SERVER_ERROR" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  | { ok: false; code: ProfileActivationErrorCode };

// bm61-spec §Design D2, code-standards Part 2 Next.js rule 3: activate the
// working company-profile draft. A MUTATION, so the guard is
// `invoice_settings : EDIT` and is the first statement (a READ user is refused
// server-side; the hidden button is show/hide only). Order: guard → Zod (an
// empty note is `CHANGE_NOTE_REQUIRED`) → service (checks D2.3–D2.6, the G14
// option C four-eyes check, one transaction, one audit row) → revalidate the
// Invoice Settings layout.
export async function activateProfileAction(
  rawInput: unknown,
): Promise<ActivateProfileActionResult> {
  let actorId: string;
  try {
    ({ userId: actorId } = await requirePermission(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.EDIT,
    ));
  } catch (error) {
    if (isRedirectError(error)) return { ok: false, code: "FORBIDDEN" };
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = activateProfileInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    if (parsed.error.issues.some((i) => i.message === "CHANGE_NOTE_REQUIRED")) {
      return { ok: false, code: "CHANGE_NOTE_REQUIRED" };
    }
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      (fieldErrors[issue.path.join(".")] ??= []).push(issue.message);
    }
    return { ok: false, code: "VALIDATION_ERROR", fieldErrors };
  }

  let result;
  try {
    result = await activateProfile(parsed.data, actorId);
  } catch (error) {
    logger.error("company profile activation failed", {
      configVersion: parsed.data.configVersion,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) return result;

  revalidatePath("/administration/invoice-settings", "layout");
  return result;
}
