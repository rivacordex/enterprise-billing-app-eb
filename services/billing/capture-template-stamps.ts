import type { Database } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import {
  resolveGeneratedForFamily,
  resolveSharedCurrentVersions,
} from "@/services/billing/invoice-template/resolve-template";
import type { CapturedTemplateStamp } from "@/types/billing";

// bm65-spec §5 (Inv #51, #52, #54, #58) — record on each given BAN's
// `bill_run_account` row the template family and versions it will be invoiced
// with. Runs inside the trigger / rerun transaction, BEFORE the engine is
// triggered, so the flow never starts on an uncaptured account and an engine
// failure rolls the stamps back with everything else.
//
// Set-based: one read of every BAN's family, the shared CSV/profile once, one
// generated-version resolution per DISTINCT family, one UPDATE (chunked, pruned
// to the run's partition) — no per-BAN statement. Capture never fails the
// trigger (General rule 3): a family with no usable version (none ACTIVE, or
// retired, D55/D44), and a BAN whose family cannot be resolved (a corrupted
// catalog, or a reference to a non-generated version), are stamped with a NULL
// version — and a NULL family in the second case. The blocking
// `template_versions_captured` approval check then stops the run (D58a), and
// render and posting act on the NULL (bm66, bm67). EXCLUDED rows are never
// stamped. Returns the stamps for the audit `afterData`.
export async function captureTemplateStamps(
  tx: Database,
  billRunId: string,
  banIds: string[],
  periodPartition: string,
): Promise<CapturedTemplateStamp[]> {
  if (banIds.length === 0) return [];

  const banFamilies = await billRunAccountRepository.listBanFamilies(
    tx,
    banIds,
  );
  const familyIds = [
    ...new Set(
      banFamilies
        .map((b) => b.familyId)
        .filter((id): id is string => id !== null),
    ),
  ];

  // Sequential on purpose: one transaction connection serves every query.
  const { csv, profileVersion } = await resolveSharedCurrentVersions(tx);
  const versionByFamily = new Map<string, string | null>();
  for (const familyId of familyIds) {
    const generated = await resolveGeneratedForFamily(tx, familyId);
    versionByFamily.set(familyId, generated?.billTemplateVersionId ?? null);
  }

  const stamps: CapturedTemplateStamp[] = banFamilies.map((b) => ({
    banId: b.banId,
    familyId: b.familyId,
    versionId:
      b.familyId === null ? null : (versionByFamily.get(b.familyId) ?? null),
  }));
  await billRunAccountRepository.captureTemplateStamps(
    tx,
    billRunId,
    periodPartition,
    stamps,
    { profileVersion, csvVersionId: csv.billTemplateVersionId },
  );
  return stamps;
}
