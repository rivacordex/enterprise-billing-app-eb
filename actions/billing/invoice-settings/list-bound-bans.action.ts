"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { getBoundBansPage } from "@/services/billing/read/invoice-template-settings";
import type { BoundBanRow } from "@/types/billing";
import { listBoundBansSchema } from "@/validation/billing/retire-template-type.schema";

export type ListBoundBansActionResult =
  | { ok: true; rows: BoundBanRow[] }
  | { ok: false; code: "FORBIDDEN" | "VALIDATION_ERROR" | "SERVER_ERROR" };

// bm83 (D8) — the Retire dialog's "Show more": one page of the BANs bound to
// a type. Only that dialog uses it, so the guard is `invoice_settings : EDIT`.
// A read: no audit, no revalidation.
export async function listBoundBansAction(
  rawInput: unknown,
): Promise<ListBoundBansActionResult> {
  try {
    await requirePermission(PERMISSIONS.INVOICE_SETTINGS, LEVELS.EDIT);
  } catch (error) {
    if (isRedirectError(error)) return { ok: false, code: "FORBIDDEN" };
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = listBoundBansSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };

  try {
    return {
      ok: true,
      rows: await getBoundBansPage(parsed.data.typeId, parsed.data.page),
    };
  } catch (error) {
    logger.error("listing bound BANs failed", {
      typeId: parsed.data.typeId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }
}
