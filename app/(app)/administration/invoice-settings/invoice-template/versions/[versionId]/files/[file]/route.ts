// bm55-spec §Design D5, code-standards Part 2 API rules 2/4 + Next.js rule 7 —
// the session-guarded download of one stored generated-template file. It lives
// under the authenticated `(app)` segment (the bm18/bm19 `draft-invoice`/
// `stored-invoice` precedent), not `app/api/*`, so the "exactly three
// app/api/billrun handlers" inventory stays true. Same auth shape as
// `stored-invoice`: session + resolved permissions, no
// requirePermission()/redirect() since a route cannot redirect a download.
//
// It serves EXACTLY the stored, checksum-verified bytes and never regenerates
// a file. A digest mismatch is a 500 with no bytes (Inv #45).

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
import { GENERATED_VERSION_FILES } from "@/services/billing/invoice-template/load";
import { getGeneratedVersionFile } from "@/services/billing/read/invoice-template-settings";
import { InvoiceRenderError } from "@/types/billing";
import { meetsLevel } from "@/types/permissions";

const paramsSchema = z.object({
  versionId: z.string().regex(/^BTV\d{8}$/),
  file: z.enum(GENERATED_VERSION_FILES),
});

const CONTENT_TYPES = {
  "invoice.hbs": "text/plain; charset=utf-8",
  "footer.hbs": "text/plain; charset=utf-8",
  "structure.json": "application/json",
} as const satisfies Record<(typeof GENERATED_VERSION_FILES)[number], string>;

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ versionId: string; file: string }> },
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
    return Response.json({ error: "Invalid version or file" }, { status: 422 });
  }
  const { versionId, file } = parsed.data;

  try {
    const stored = await getGeneratedVersionFile(versionId, file);
    if (!stored) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // `Buffer`'s TS type doesn't structurally satisfy `BodyInit` (generic
    // ArrayBufferLike mismatch) — a plain `Uint8Array` copy does.
    return new Response(new Uint8Array(stored.bytes), {
      status: 200,
      headers: {
        "Content-Type": CONTENT_TYPES[file],
        "Content-Disposition": `attachment; filename="INVOICE-v${stored.versionNo}-${file}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // TEMPLATE_CHECKSUM_MISMATCH (or a blob read failure): no bytes served.
    logger.error("invoice template file download failed", {
      versionId,
      file,
      code: error instanceof InvoiceRenderError ? error.code : "INTERNAL",
      detail: error instanceof InvoiceRenderError ? error.detail : undefined,
    });
    return new Response(null, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
