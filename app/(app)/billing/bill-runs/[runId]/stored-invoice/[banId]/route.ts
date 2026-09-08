// bm19-spec §Implementation §5 — the session-guarded download route for the
// STORED final invoice PDF (distinct from bm18's draft-invoice route, which
// renders on demand and stores nothing). Same auth shape/rationale as that
// route (billrun_view:READ, session + resolved permissions, no
// requirePermission()/redirect() since a route can't redirect a fetch/
// iframe request) and the same deliberate `app/(app)` (not `app/api`)
// carve-out from code-standards §3.5's "app/api/* = M2M only".

import { headers } from "next/headers";
import type { NextRequest } from "next/server";

import { auth } from "@/auth";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import {
  StoredInvoiceNotFoundError,
  getStoredInvoice,
} from "@/services/billing/read/get-stored-invoice";
import { meetsLevel } from "@/types/permissions";
import { billingAccountIdSchema } from "@/validation/billing/ban-id.schema";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

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
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  try {
    const stored = await getStoredInvoice(runResult.data, banResult.data);
    // `Buffer`'s TS type doesn't structurally satisfy `BodyInit` (generic
    // ArrayBufferLike mismatch) — a plain `Uint8Array` copy does.
    return new Response(new Uint8Array(stored.pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="${stored.invoiceNumber}.pdf"`,
        // Read by `StoredInvoiceModal` to show the artifact's own identity
        // (spec §Implementation §5 "shows the real INV… number +
        // blob_ref/checksum") without a second round-trip.
        "X-Invoice-Number": stored.invoiceNumber,
        "X-Blob-Ref": stored.blobRef,
        "X-Checksum": stored.checksum,
      },
    });
  } catch (error) {
    if (error instanceof StoredInvoiceNotFoundError) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(
      { error: "Could not retrieve the stored invoice." },
      { status: 500 },
    );
  }
}
