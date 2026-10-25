"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  activateTemplate,
  type ActivateTemplateErrorCode,
} from "@/services/billing/invoice-template/activate-template";
import type { LayoutProblem } from "@/types/billing";
import { activateTemplateInputSchema } from "@/validation/billing/activate-version.schema";

export type ActivateTemplateActionResult =
  | {
      ok: true;
      versionId: string;
      versionNo: number;
      retiredVersionId: string | null;
      // bm79 — the layout DRAFT promoted with the settings, or `null`.
      layout: {
        versionId: string;
        versionNo: number;
        retiredVersionId: string | null;
      } | null;
    }
  | { ok: false; code: "FORBIDDEN" | "SERVER_ERROR" }
  | {
      ok: false;
      code: "VALIDATION_ERROR";
      fieldErrors: Record<string, string[]>;
    }
  // bm79 adds TEMPLATE_TYPE_RETIRED (through ActivateTemplateErrorCode) and
  // LAYOUT_REJECTED, which carries the compliance re-run's problems.
  | {
      ok: false;
      code: Exclude<
        ActivateTemplateErrorCode,
        "VALIDATION_ERROR" | "LAYOUT_REJECTED"
      >;
    }
  | { ok: false; code: "LAYOUT_REJECTED"; problems: LayoutProblem[] };

// bm58-spec §Design D2 steps 1 and 9, code-standards Part 2 Next.js rule 3:
// activate the working draft. A MUTATION, so the guard is
// `invoice_settings : EDIT` and is the first statement (a READ user is refused
// server-side; the hidden button is show/hide only). Order: guard → Zod (an
// empty note is `CHANGE_NOTE_REQUIRED`) → service (blobs, then one transaction,
// one audit row) → revalidate the Invoice Settings layout. Four-eyes does not
// apply to template activation (code-standards §8).
export async function activateTemplateAction(
  rawInput: unknown,
): Promise<ActivateTemplateActionResult> {
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

  const parsed = activateTemplateInputSchema.safeParse(rawInput);
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
    result = await activateTemplate(parsed.data, actorId);
  } catch (error) {
    logger.error("invoice template activation failed", {
      draftId: parsed.data.draftId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (!result.ok) {
    if (result.code === "LAYOUT_REJECTED") return result;
    return result.code === "VALIDATION_ERROR"
      ? { ok: false, code: "VALIDATION_ERROR", fieldErrors: {} }
      : { ok: false, code: result.code };
  }

  revalidatePath("/administration/invoice-settings", "layout");
  return {
    ok: true,
    versionId: result.versionId,
    versionNo: result.versionNo,
    retiredVersionId: result.retiredVersionId,
    layout: result.layout,
  };
}
