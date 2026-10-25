"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import type { TemplateTypeErrorCode } from "@/types/billing";
import { createTemplateTypeInputSchema } from "@/validation/billing/template-type.schema";

// bm77-spec §6 (Inv #65) — create an empty invoice template type. The guard is
// the first statement in `try` (a no-EDIT caller's redirect is FORBIDDEN, never
// a redirect from a server action); the service normalizes, validates, derives
// the code and layout code, and writes the row + `INVOICE_TEMPLATE_TYPE_CREATED`
// in one transaction. The dialog navigates to the new type's detail page.
export type CreateTemplateTypeActionResult =
  | { ok: true; typeId: string }
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "VALIDATION_ERROR"
        | "SERVER_ERROR"
        | TemplateTypeErrorCode;
      fieldErrors?: Record<string, string[]>;
    };

export async function createTemplateTypeAction(
  rawInput: unknown,
): Promise<CreateTemplateTypeActionResult> {
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

  const parsed = createTemplateTypeInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };

  try {
    const result = await createTemplateType(parsed.data, actorId);
    if (!result.ok) {
      return {
        ok: false,
        code: result.code,
        ...(result.fieldErrors ? { fieldErrors: result.fieldErrors } : {}),
      };
    }
    revalidatePath("/administration/invoice-settings", "layout");
    return { ok: true, typeId: result.typeId };
  } catch (error) {
    logger.error("createTemplateTypeAction failed", {
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }
}
