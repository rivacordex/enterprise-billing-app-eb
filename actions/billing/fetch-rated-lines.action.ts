"use server";

import { z } from "zod";

import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { isRedirectError } from "@/lib/errors";
import { listRatedLines } from "@/services/billing/read/list-rated-lines";
import type { RatedLineRow } from "@/types/billing";
import { billingAccountIdSchema } from "@/validation/billing/ban-id.schema";
import { billRunIdSchema } from "@/validation/billing/run-id.schema";

// bm28-spec §Design/§Implementation §5 (+ code-review fix #2/#3/#5) — the
// `udr_rated` drill-down fetch, a read-only Server Action the `BillLineTable`'s
// USAGE-row `<details>` calls on expand only (the bm18 fetch-on-open pattern),
// never eager. Re-checks `billrun_view:READ` server-side (the disclosure being
// open is not the gate) — this is a session-guarded read; the M2M service token
// never reaches here. A read is NOT audited. Scoped to ONE line's grain
// (`productOfferingId`, `udrType`) so the disclosure shows only that line's
// records. `productOfferingId`/`udrType` are DB-sourced (from the rendered
// `BillLineRow`), Zod-bounded here as input hygiene (the query is parameterised).

const offeringIdSchema = z.string().min(1).max(64);
const udrTypeSchema = z.string().min(1).max(64);

export type FetchRatedLinesResult =
  | { ok: true; rows: RatedLineRow[] }
  | { ok: false; code: "FORBIDDEN" | "INVALID" };

export async function fetchRatedLinesAction(input: {
  runId: string;
  billingAccountId: string;
  productOfferingId: string;
  udrType: string;
}): Promise<FetchRatedLinesResult> {
  try {
    await requirePermission(PERMISSIONS.BILLRUN_VIEW, LEVELS.READ);
  } catch (e) {
    if (!isRedirectError(e)) throw e;
    return { ok: false, code: "FORBIDDEN" };
  }

  const idResult = billRunIdSchema.safeParse(input.runId);
  const banResult = billingAccountIdSchema.safeParse(input.billingAccountId);
  const offeringResult = offeringIdSchema.safeParse(input.productOfferingId);
  const udrTypeResult = udrTypeSchema.safeParse(input.udrType);
  if (
    !idResult.success ||
    !banResult.success ||
    !offeringResult.success ||
    !udrTypeResult.success
  ) {
    return { ok: false, code: "INVALID" };
  }

  const rows = await listRatedLines(
    idResult.data,
    banResult.data,
    offeringResult.data,
    udrTypeResult.data,
  );
  return { ok: true, rows };
}
