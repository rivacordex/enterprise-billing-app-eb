"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { retireTemplateType } from "@/services/billing/invoice-template/template-types";
import type { RetireTemplateTypeResult } from "@/types/billing";
import { retireTemplateTypeSchema } from "@/validation/billing/retire-template-type.schema";

// bm83 (Inv #66, #67) — retire a type and move its BANs to one usable target.
// A MUTATION, so the guard is `invoice_settings : EDIT` and is the first
// statement (the hidden trigger is show/hide only). Order: guard → Zod →
// service (one transaction) → revalidate Invoice Settings and the customer
// pages, whose BAN type labels changed.
export async function retireTemplateTypeAction(
  rawInput: unknown,
): Promise<RetireTemplateTypeResult> {
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

  const parsed = retireTemplateTypeSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };

  let result: RetireTemplateTypeResult;
  try {
    result = await retireTemplateType(parsed.data, actorId);
  } catch (error) {
    logger.error("invoice template type retire failed", {
      typeId: parsed.data.typeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (result.ok) {
    revalidatePath("/administration/invoice-settings", "layout");
    revalidatePath("/customers", "layout");
  }
  return result;
}
