// bm81 (Inv #68; code-standards › Invoice Template Types, Next.js rule 2 and
// API rules 1–2) — the session-guarded export of one version PAIR, addressed by
// its settings version, as `<layout_code>-v<N>-s<M>.zip`. The
// `files/[file]/route.ts` shape: under the authenticated `(app)` segment, not
// `app/api/*`; session + resolved permissions, no requirePermission()/
// redirect() since a route cannot redirect a download. READ exports every
// stored pair; a DRAFT (or discarded) pair needs EDIT and is a 404 otherwise.
//
// It serves EXACTLY the verified stored layout bytes plus `settings.json`. A
// digest mismatch is a 500 with no bytes and no audit row (Inv #45, #68).

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
import { exportTemplateVersion } from "@/services/billing/invoice-template/export-template-version";
import { InvoiceRenderError } from "@/types/billing";
import { hasLevel, meetsLevel } from "@/types/permissions";
import { billTemplateVersionIdSchema } from "@/validation/billing/template-version-id.schema";

const paramsSchema = z.object({ versionId: billTemplateVersionIdSchema });

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ versionId: string }> },
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
  // EDIT only widens what is visible (a DRAFT pair) — a show/hide gate, never
  // enforcement (guardrail 56).
  const canEdit = hasLevel(
    permissionMap,
    PERMISSIONS.INVOICE_SETTINGS,
    LEVELS.EDIT,
  );

  const parsed = paramsSchema.safeParse(await params);
  if (!parsed.success) {
    return Response.json({ error: "Invalid version" }, { status: 422 });
  }
  const { versionId } = parsed.data;

  try {
    const result = await exportTemplateVersion(
      versionId,
      { id: user.id, userName: user.userName },
      canEdit,
    );
    if (!result.ok) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    // A plain `Uint8Array` copy satisfies `BodyInit` (see files/[file]).
    return new Response(new Uint8Array(result.bytes), {
      status: 200,
      headers: {
        "Content-Type": "application/zip",
        "Content-Disposition": `attachment; filename="${result.fileName}"`,
        "X-Content-Type-Options": "nosniff",
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    // TEMPLATE_CHECKSUM_MISMATCH (or a blob read failure): no bytes served.
    const detail =
      error instanceof InvoiceRenderError
        ? (error.detail as { file?: unknown } | undefined)
        : undefined;
    logger.error("invoice template export failed", {
      versionId,
      code: error instanceof InvoiceRenderError ? error.code : "INTERNAL",
      file: detail?.file,
    });
    return new Response(null, {
      status: 500,
      headers: { "Cache-Control": "no-store" },
    });
  }
}
