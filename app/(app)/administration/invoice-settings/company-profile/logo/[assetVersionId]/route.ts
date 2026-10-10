// bm56-spec §Design D3, code-standards Part 2 API rules 2–3 — the
// session-guarded GET of one stored company-profile logo. Same auth shape as
// the invoice-template files route: session + resolved permissions, 401 →
// 403 → 422 → 404, no requirePermission()/redirect() (a route cannot redirect).
//
// It serves EXACTLY the stored bytes and only after the digest matches the
// row's checksum (Inv #45); a mismatch is a 500 with no body. The stored MIME
// is the Content-Type (never sniffed) and the response carries a sandboxing
// CSP so an SVG logo opened directly cannot run script.

import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { logger } from "@/lib/logger";
import { getCompanyProfileLogo } from "@/services/billing/read/company-profile-settings";
import { InvoiceRenderError } from "@/types/billing";
import { meetsLevel } from "@/types/permissions";
import { billAssetVersionIdSchema } from "@/validation/billing/template-version-id.schema";

const paramsSchema = z.object({ assetVersionId: billAssetVersionIdSchema });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ assetVersionId: string }> },
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
  if (!meetsLevel(permissionMap[PERMISSIONS.INVOICE_SETTINGS], LEVELS.READ)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return Response.json({ error: "Invalid asset version" }, { status: 422 });
  }
  const { assetVersionId } = parsed.data;

  try {
    const logo = await getCompanyProfileLogo(assetVersionId);
    if (!logo) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // A plain `Uint8Array` copy satisfies `BodyInit` (Buffer's generic
    // ArrayBufferLike does not).
    return new Response(new Uint8Array(logo.bytes), {
      status: 200,
      headers: {
        "Content-Type": logo.mime,
        "Content-Disposition": "inline",
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy":
          "sandbox; default-src 'none'; style-src 'unsafe-inline'",
        "Cache-Control": "private, max-age=0, no-store",
      },
    });
  } catch (error) {
    // ASSET_CHECKSUM_MISMATCH (or a blob read failure): no bytes served.
    logger.error("company profile logo download failed", {
      assetVersionId,
      code: error instanceof InvoiceRenderError ? error.code : "INTERNAL",
      detail: error instanceof InvoiceRenderError ? error.detail : undefined,
    });
    return new Response(null, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
