// bm18-spec §Implementation §3 — a session-guarded PDF Route Handler, a
// deliberate, reviewed addition to code-standards §3.5's "app/api/* = M2M
// only": this is a human-facing, session-guarded binary route, so it lives
// under the authenticated (app) segment (not app/api/) to keep the M2M
// namespace M2M-only (architecture §2). Same auth shape as
// app/api/accounts/gl-journal-export/route.ts (session + resolved
// permissions, no requirePermission()/redirect() since a route can't
// redirect a fetch/iframe request). HTTPS-only per the platform's TLS
// termination (architecture §4); no code-level check here, same convention
// as every other route in this app.

import { headers } from "next/headers";
import type { NextRequest } from "next/server";

import { auth } from "@/auth";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import { isRateLimited } from "@/lib/rate-limit";
import {
  DraftInvoiceNotFoundError,
  renderDraftInvoice,
} from "@/services/billing/render-invoice";
import { meetsLevel } from "@/types/permissions";
import { billingAccountIdSchema } from "@/validation/billing/ban-id.schema";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// Phase-2 review fold T9 — "a per-session rate limit on the draft route",
// alongside the render-side concurrency guard in render-invoice.ts. Generous
// enough for a reviewer clicking Preview/Retry a few times, tight enough to
// stop a runaway client from flooding Chromium launches.
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
    return Response.json({ error: "Not found" }, { status: 404 });
  }

  if (
    isRateLimited(
      `draft-invoice:${user.id}`,
      RATE_LIMIT_MAX_REQUESTS,
      RATE_LIMIT_WINDOW_MS,
    )
  ) {
    return Response.json(
      { error: "Too many draft preview requests — please wait a moment." },
      { status: 429 },
    );
  }

  try {
    const pdf = await renderDraftInvoice({
      runId: runResult.data,
      banId: banResult.data,
    });
    // `Buffer`'s TS type doesn't structurally satisfy `BodyInit` (generic
    // ArrayBufferLike mismatch) — a plain `Uint8Array` copy does.
    return new Response(new Uint8Array(pdf), {
      status: 200,
      headers: {
        "Content-Type": "application/pdf",
        "Content-Disposition": `inline; filename="DRAFT-${banResult.data}.pdf"`,
      },
    });
  } catch (error) {
    if (error instanceof DraftInvoiceNotFoundError) {
      return Response.json({ error: "Not found" }, { status: 404 });
    }
    return Response.json(
      { error: "Could not render the draft invoice." },
      { status: 500 },
    );
  }
}
