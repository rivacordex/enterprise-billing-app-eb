"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";
import {
  PreviewBillNotFoundError,
  previewInvoiceTemplate,
} from "@/services/billing/invoice-template/preview";
import {
  DraftInvoiceNotFoundError,
  FinalInvoiceNotFoundError,
  InvoiceRenderError,
} from "@/types/billing";
import { hasLevel } from "@/types/permissions";
import { previewInvoiceTemplateInputSchema } from "@/validation/billing/invoice-template-structure.schema";

export type PreviewInvoiceTemplateActionResult =
  | {
      ok: true;
      html: string;
      templateLabel: string;
      pinnedVersionNo: number | null;
    }
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "VALIDATION_ERROR"
        | "NOT_FOUND"
        | "RATE_LIMITED"
        | "PREVIEW_FAILED";
      detail?: string;
    };

// bm55-spec §Design D3 — 30 previews / 60 s per user, on the draft-invoice
// route's limiter helper. Generous for a debounced (400 ms) form, tight enough
// to stop a runaway client compiling templates in a loop.
const RATE_LIMIT_MAX_REQUESTS = 30;
const RATE_LIMIT_WINDOW_MS = 60_000;

// bm55-spec §Design D3, code-standards Part 2 Next.js rule 5 — the live
// preview. A READ (`invoice_settings : READ`): it saves nothing, so it writes
// no audit row (General rule 9) and revalidates nothing. Order: guard → Zod →
// `billrun_view` for a bill source (before any read, so customer data never
// reaches a holder of `invoice_settings` alone) → rate limit → service.
export async function previewInvoiceTemplateAction(
  rawInput: unknown,
): Promise<PreviewInvoiceTemplateActionResult> {
  let principal: Awaited<ReturnType<typeof requirePermission>>;
  try {
    principal = await requirePermission(
      PERMISSIONS.INVOICE_SETTINGS,
      LEVELS.READ,
    );
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const parsed = previewInvoiceTemplateInputSchema.safeParse(rawInput);
  if (!parsed.success) {
    return { ok: false, code: "VALIDATION_ERROR" };
  }
  const input = parsed.data;

  if (
    input.source !== "sample" &&
    !hasLevel(principal.permissionMap, PERMISSIONS.BILLRUN_VIEW, LEVELS.READ)
  ) {
    return { ok: false, code: "FORBIDDEN" };
  }

  if (
    isRateLimited(
      `invoice-template-preview:${principal.userId}`,
      RATE_LIMIT_MAX_REQUESTS,
      RATE_LIMIT_WINDOW_MS,
    )
  ) {
    return { ok: false, code: "RATE_LIMITED" };
  }

  try {
    const result = await previewInvoiceTemplate(input);
    return { ok: true, ...result };
  } catch (error) {
    if (
      error instanceof PreviewBillNotFoundError ||
      error instanceof DraftInvoiceNotFoundError ||
      error instanceof FinalInvoiceNotFoundError
    ) {
      return { ok: false, code: "NOT_FOUND" };
    }
    if (error instanceof InvoiceRenderError) {
      logger.warn("invoice template preview failed", {
        code: error.code,
        detail: error.detail,
      });
      return { ok: false, code: "PREVIEW_FAILED", detail: error.code };
    }
    throw error;
  }
}
