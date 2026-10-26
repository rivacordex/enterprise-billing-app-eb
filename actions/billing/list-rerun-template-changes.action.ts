"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import {
  listRerunTemplateChanges,
  type RerunTemplateChange,
} from "@/services/billing/read/list-rerun-template-changes";
import { listRerunTemplateChangesSchema } from "@/validation/billing/rerun-run.schema";

export type ListRerunTemplateChangesActionResult =
  | { ok: true; changes: RerunTemplateChange[] }
  | { ok: false; code: "FORBIDDEN" | "VALIDATION_ERROR" | "SERVER_ERROR" };

// bm84 (D4) — the rerun confirm's template-type warning, read when the confirm
// opens. Guarded like the rerun itself (`billrun_operate : EDIT`), since only
// that confirm uses it. A read: no audit, no revalidation; a failure is
// advisory only (the dialog shows nothing and never blocks the rerun).
export async function listRerunTemplateChangesAction(
  rawInput: unknown,
): Promise<ListRerunTemplateChangesActionResult> {
  try {
    await requirePermission(PERMISSIONS.BILLRUN_OPERATE, LEVELS.EDIT);
  } catch (e) {
    // Review fix — advisory: a non-redirect guard failure is a typed
    // SERVER_ERROR, never a rejected server action.
    if (isRedirectError(e)) return { ok: false, code: "FORBIDDEN" };
    logger.warn("rerun template-change guard failed", {
      error: e instanceof Error ? e.message : String(e),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }

  const parsed = listRerunTemplateChangesSchema.safeParse(rawInput);
  if (!parsed.success) return { ok: false, code: "VALIDATION_ERROR" };

  try {
    return {
      ok: true,
      changes: await listRerunTemplateChanges(
        parsed.data.billRunId,
        parsed.data.accountIds,
      ),
    };
  } catch (error) {
    logger.warn("rerun template-change read failed", {
      billRunId: parsed.data.billRunId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, code: "SERVER_ERROR" };
  }
}
