import type { Database } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { resolveCurrentVersionsForFamily } from "@/services/billing/invoice-template/resolve-template";
import type { CapturedTemplateStamp } from "@/types/billing";

// bm65-spec §5 (Inv #51, #52, #54, #58) — record on each given BAN's
// `bill_run_account` row the template family and versions it will be invoiced
// with. Runs inside the trigger / rerun transaction, BEFORE the engine is
// triggered, so the flow never starts on an uncaptured account and an engine
// failure rolls the stamps back with everything else.
//
// Set-based: one read of every BAN's family, one resolution per DISTINCT
// family, one UPDATE (chunked) — no per-BAN statement. A family with no ACTIVE
// or default generated version is stamped with a NULL version (D55): no throw,
// no EXCLUDED; render and posting act on the NULL (bm66, bm67). EXCLUDED rows
// are never stamped. Returns the stamps for the audit `afterData`.
export async function captureTemplateStamps(
  tx: Database,
  billRunId: string,
  banIds: string[],
): Promise<CapturedTemplateStamp[]> {
  if (banIds.length === 0) return [];

  const banFamilies = await billRunAccountRepository.listBanFamilies(
    tx,
    banIds,
  );
  const familyIds = [...new Set(banFamilies.map((b) => b.familyId))];

  // Sequential on purpose: one transaction connection serves every query.
  const versionByFamily = new Map<string, string | null>();
  let shared: { profileVersion: number | null; csvVersionId: string } | null =
    null;
  for (const familyId of familyIds) {
    const current = await resolveCurrentVersionsForFamily(tx, familyId);
    versionByFamily.set(
      familyId,
      current.generated?.billTemplateVersionId ?? null,
    );
    // CSV and profile are global: taken from the first resolution.
    shared ??= {
      profileVersion: current.profileVersion,
      csvVersionId: current.csv.billTemplateVersionId,
    };
  }
  if (!shared) return [];

  const stamps: CapturedTemplateStamp[] = banFamilies.map((b) => ({
    banId: b.banId,
    familyId: b.familyId,
    versionId: versionByFamily.get(b.familyId) ?? null,
  }));
  await billRunAccountRepository.captureTemplateStamps(
    tx,
    billRunId,
    stamps,
    shared,
  );
  return stamps;
}
