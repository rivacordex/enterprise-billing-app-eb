"use server";

import { revalidatePath } from "next/cache";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { discardTemplateDraft } from "@/services/billing/invoice-template/discard-template-draft";
import type { DiscardTemplateDraftResult } from "@/types/billing";
import { discardTemplateDraftInputSchema } from "@/validation/billing/discard-template-draft.schema";

// bm79 — discard a type's DRAFTs (settings and, if any, layout → RETIRED). A
// MUTATION, so the guard is `invoice_settings : EDIT` and is the first
// statement (the hidden button is show/hide only). Order: guard → Zod →
// service (one transaction, one audit row) → revalidate the Invoice Settings
// layout, as `activate-template.action.ts`.
export async function discardTemplateDraftAction(
  rawInput: unknown,
): Promise<DiscardTemplateDraftResult> {
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

  const parsed = discardTemplateDraftInputSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };

  let result: DiscardTemplateDraftResult;
  try {
    result = await discardTemplateDraft(parsed.data, actorId);
  } catch (error) {
    logger.error("invoice template draft discard failed", {
      draftId: parsed.data.draftId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  if (result.ok) revalidatePath("/administration/invoice-settings", "layout");
  return result;
}
