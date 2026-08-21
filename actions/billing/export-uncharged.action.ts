"use server";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { buildCsv } from "@/lib/csv";
import { isRedirectError } from "@/lib/errors";
import { listUncharged } from "@/services/billing/read/list-uncharged";
import type { UnchargedRow } from "@/types/billing";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm07-spec §Implementation §3. CSV export of a run's Uncharged (EXCLUDED)
// accounts, as a Server Action returning CSV text (NOT a Route Handler — the
// bm02 export precedent, general code-standards §5). Re-checks
// `billrun_view:READ` (the UI disabling is not the gate). A read-only export is
// NOT audited. The client control builds a `Blob` and triggers the download.

export type ExportUnchargedResult =
  | { ok: true; filename: string; csv: string }
  | { ok: false; code: "FORBIDDEN" | "INVALID" };

const CSV_HEADER = [
  "Account ID",
  "Account Name",
  "Reason",
  "Uncharged Window Start",
  "Uncharged Window End",
  "Indicative Value",
] as const;

function toCsv(rows: UnchargedRow[]): string {
  return buildCsv(
    CSV_HEADER,
    rows.map((row) => [
      row.billingAccountId,
      row.accountName,
      row.reason,
      row.windowStart,
      row.windowEnd,
      // No rating source in v1 — the indicative value is blank, not zero.
      row.indicativeValue ?? "",
    ]),
  );
}

export async function exportUnchargedAction(input: {
  runId: string;
}): Promise<ExportUnchargedResult> {
  try {
    await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const idResult = billRunIdSchema.safeParse(input.runId);
  if (!idResult.success) {
    return { ok: false, code: "INVALID" };
  }

  const rows = await listUncharged(idResult.data);

  return {
    ok: true,
    filename: `uncharged-${idResult.data}.csv`,
    csv: toCsv(rows),
  };
}
