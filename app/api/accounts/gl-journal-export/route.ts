// ac14-spec §3.3 / code-standards §5.1 — the module's one Route Handler.
// POST because it audits (platform keeps GET side-effect-free, §5.9).
// Streams the balanced period journal as CSV and writes an audit event.

import { headers } from "next/headers";
import type { NextRequest } from "next/server";
import { z } from "zod";

import { auth } from "@/auth";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import {
  findActiveUserById,
  resolveEffectivePermissions,
} from "@/auth/resolver";
import {
  auditJournalExport,
  buildJournalCsv,
} from "@/services/accounts/journal-csv";
import { meetsLevel } from "@/types/permissions";

const exportBodySchema = z.object({
  period: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, {
    message: "period must be YYYY-MM",
  }),
  currency: z.string().length(3, { message: "currency must be 3 chars" }),
});

export async function POST(request: NextRequest): Promise<Response> {
  // 1. Session + active-user check
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  const user = await findActiveUserById(session.user.id);
  if (!user) {
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  // 2. Permission: accounts_config:EDIT (spec §2.3 / code-standards §5.1)
  const permissionMap = await resolveEffectivePermissions(user.id);
  if (!meetsLevel(permissionMap[PERMISSIONS.ACCOUNTS_CONFIG], LEVELS.EDIT)) {
    return Response.json({ error: "Forbidden" }, { status: 403 });
  }

  // 3. Parse body
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const parsed = exportBodySchema.safeParse(body);
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body", details: z.flattenError(parsed.error) },
      { status: 400 },
    );
  }

  const { period, currency } = parsed.data;

  // 4. Build CSV — balanced-guard refuses an unbalanced journal (spec §2.4)
  const result = await buildJournalCsv(period);
  if (!result.ok) {
    return Response.json(
      {
        error: "UNBALANCED_JOURNAL",
        totalDebit: result.totalDebit,
        totalCredit: result.totalCredit,
      },
      { status: 409 },
    );
  }

  // 5. Audit — written in the same request, which is why this is POST (§5.1)
  await auditJournalExport(
    period,
    currency,
    result.rowCount,
    result.totalDebit,
    result.totalCredit,
    user.id,
  );

  // 6. Stream CSV response
  const filename = `gl-journal-${period}-${currency}.csv`;
  return new Response(result.csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}"`,
    },
  });
}
