"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { saveProfileDraft } from "@/services/billing/invoice-profile/save-profile-draft";
import { saveProfileDraftInputSchema } from "@/validation/billing/invoice-profile.schema";

export type SaveProfileDraftActionResult =
  | { ok: true; versionNo: number; draftToken: string; changed: boolean }
  | { ok: false; code: "FORBIDDEN" | "DRAFT_CONFLICT" | "SERVER_ERROR" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      // Keyed by the profile field (`tin`, `swift`, …), so the form can set
      // each error on its field; a whole-object issue keeps its own path
      // (`fields` for an unknown key such as `logo_asset_version_id`).
      fieldErrors: Record<string, string[]>;
    };

const FIELDS_PREFIX = "fields.";

// bm59-spec §Design D1/D2, code-standards Part 2 Next.js rule 3: save the
// working company-profile draft. A MUTATION, so the guard is
// `invoice_settings : EDIT` and is the first statement (a READ user is refused
// server-side; the hidden Save button is show/hide only). Order: guard → Zod
// (the same draft schema the form uses) → service (one transaction, one audit
// row) → revalidate the Invoice Settings layout.
export async function saveProfileDraftAction(
  rawInput: unknown,
): Promise<SaveProfileDraftActionResult> {
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

  const parsed = saveProfileDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      const key = path.startsWith(FIELDS_PREFIX)
        ? path.slice(FIELDS_PREFIX.length)
        : path;
      (fieldErrors[key] ??= []).push(issue.message);
    }
    return { ok: false, code: "VALIDATION_ERROR", fieldErrors };
  }

  let result;
  try {
    result = await saveProfileDraft(parsed.data, actorId);
  } catch (error) {
    logger.error("company profile draft save failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result.code === "DRAFT_CONFLICT"
      ? { ok: false, code: "DRAFT_CONFLICT" }
      : { ok: false, code: "VALIDATION_ERROR", fieldErrors: {} };
  }

  if (result.changed) {
    revalidatePath("/administration/invoice-settings", "layout");
  }
  return result;
}
