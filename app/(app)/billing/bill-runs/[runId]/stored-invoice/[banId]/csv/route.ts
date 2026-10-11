// bm62-spec §Design D4 — the session-guarded download of a POSTED bill's
// invoice CSV, generated on request from the bill's stamped, checksum-verified
// CSV map (nothing stored, nothing audited). Same auth shape and the same
// `app/(app)` (not `app/api`) carve-out as the sibling stored-invoice route
// (Next.js rule 7), so the route inventory keeps exactly three M2M handlers.

import { headers } from "next/headers";
import type { NextRequest } from "next/server";

import { auth } from "@/auth";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { logger } from "@/lib/logger";
import { isRateLimited } from "@/lib/rate-limit";
import { getPostedInvoiceCsv } from "@/services/billing/invoice-template/invoice-csv";
import { FinalInvoiceNotFoundError, InvoiceRenderError } from "@/types/billing";
import { meetsLevel } from "@/types/permissions";
import { billingAccountIdSchema } from "@/validation/billing/ban-id.schema";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// D4 — the stored-invoice route has no limiter, so this takes the draft-
// invoice route's: 10 requests per 60 s per user, under its own key.
const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ runId: string; banId: string }> },
): Promise<Response> {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await findActiveUserById(session.user.id);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const permissionMap = await resolveEffectivePermissions(user.id);
  if (!meetsLevel(permissionMap[PERMISSIONS.BILLRUN_VIEW], LEVELS.READ)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const { runId, banId } = await params;
  const runResult = billRunIdSchema.safeParse(runId);
  const banResult = billingAccountIdSchema.safeParse(banId);
  if (!runResult.success || !banResult.success) {
    return Response.json({ error: "Invalid ID" }, { status: 422 });
  }

  if (
    isRateLimited(
      `invoice-csv:${user.id}`,
      RATE_LIMIT_MAX_REQUESTS,
      RATE_LIMIT_WINDOW_MS,
    )
  ) {
    return Response.json(
      { error: "Too many CSV download requests — please wait a moment." },
      { status: 429 },
    );
  }

  try {
    const { invoiceNumber, csv } = await getPostedInvoiceCsv({
      runId: runResult.data,
      banId: banResult.data,
    });
    return new Response(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="${invoiceNumber}.csv"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof FinalInvoiceNotFoundError) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // D1 — an inconsistent bill (its PDF would have parked too): no file.
    if (
      error instanceof InvoiceRenderError &&
      error.code === "INVOICE_RECONCILIATION_FAILED"
    ) {
      return Response.json(
        {
          error: "The bill's line amounts do not reconcile.",
          code: error.code,
        },
        { status: 409 },
      );
    }
    // D4 — a checksum mismatch on the map (or any other failure) is logged
    // and answered with no body.
    logger.error("invoice CSV download failed", {
      runId: runResult.data,
      banId: banResult.data,
      code: error instanceof InvoiceRenderError ? error.code : undefined,
      error: error instanceof Error ? error.message : String(error),
    });
    return new Response(null, { status: 500 });
  }
}
