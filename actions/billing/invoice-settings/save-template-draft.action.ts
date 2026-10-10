"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { saveTemplateDraftInputSchema } from "@/validation/billing/invoice-template-structure.schema";

export type SaveTemplateDraftActionResult =
  | {
      ok: true;
      versionId: string;
      versionNo: number;
      draftToken: string;
    }
  | { ok: false; code: "FORBIDDEN" | "DRAFT_CONFLICT" | "SERVER_ERROR" }
  | {
      ok: false;
      code: "VALIDATION_ERROR" | "MANDATORY_SECTION_HIDDEN";
      fieldErrors: Record<string, string[]>;
    };

// bm57-spec §Design D2/D3, code-standards Part 2 Next.js rule 3: save the
// working draft. A MUTATION, so the guard is `invoice_settings : EDIT` and is
// the first statement (a READ user is refused server-side; the hidden Save
// button is show/hide only). Order: guard → Zod (a hidden mandatory section is
// `MANDATORY_SECTION_HIDDEN`, with the offending paths) → service (one
// transaction, one audit row) → revalidate the Invoice Settings layout.
export async function saveTemplateDraftAction(
  rawInput: unknown,
): Promise<SaveTemplateDraftActionResult> {
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

  const parsed = saveTemplateDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    const fieldErrors: Record<string, string[]> = {};
    let hidden = false;
    for (const issue of parsed.error.issues) {
      const path = issue.path.join(".");
      (fieldErrors[path] ??= []).push(issue.message);
      if (issue.message === "MANDATORY_SECTION_HIDDEN") hidden = true;
    }
    return {
      ok: false,
      code: hidden ? "MANDATORY_SECTION_HIDDEN" : "VALIDATION_ERROR",
      fieldErrors,
    };
  }

  let result;
  try {
    result = await saveTemplateDraft(parsed.data, actorId);
  } catch {
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    return result.code === "DRAFT_CONFLICT"
      ? { ok: false, code: "DRAFT_CONFLICT" }
      : { ok: false, code: result.code, fieldErrors: {} };
  }

  revalidatePath("/administration/invoice-settings", "layout");
  return result;
}
