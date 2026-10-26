import { db } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { selectRerunEligible } from "@/services/billing/rerun-eligibility";

// bm84 (Inv #52, #66) — the rerun confirm's advisory warning. A rerun
// re-captures each rerun BAN's type (bm65), so a BAN rebound (cm23) or
// switched by a retire (bm83) since run start silently moves to another type;
// this lists those BANs before the rerun is confirmed. The run status is not
// checked here: the rerun's own NOT_RERUNNABLE stays the authority.

export interface RerunTemplateChange {
  billingAccountId: string;
  fromTypeName: string;
  toTypeName: string;
}

// A family with no row to name it (a NULL current family needs a missing
// default, impossible after `0046`).
const UNNAMED = "—";

// bm84 — the BANs in the rerun scope whose current type differs from their run-start stamp.
// Read-only; never cached. Reads the BAN type column only via listBanFamilies (CM guardrail 11).
export async function listRerunTemplateChanges(
  billRunId: string,
  accountIds: string[],
): Promise<RerunTemplateChange[]> {
  const [accounts, postedIds] = await Promise.all([
    billRunAccountRepository.listForRerun(db, billRunId),
    customerBillRepository.listPostedAccountIds(db, billRunId),
  ]);
  const eligible = selectRerunEligible(accounts, postedIds, accountIds);
  if (eligible.length === 0) return [];

  const current = new Map(
    (
      await billRunAccountRepository.listBanFamilies(
        db,
        eligible.map((a) => a.billingAccountId),
      )
    ).map((r) => [r.banId, r.familyId]),
  );
  // A NULL stamp (a pre-bm65 run, or no default family) is not a change.
  const changed = eligible.filter(
    (a) =>
      a.refBillTemplateFamilyId !== null &&
      a.refBillTemplateFamilyId !== (current.get(a.billingAccountId) ?? null),
  );
  if (changed.length === 0) return [];

  // A retired type keeps its row, so its name (D3).
  const names = new Map(
    (await billTemplateFamilyRepository.listAll(db)).map((t) => [
      t.billTemplateFamilyId,
      t.name,
    ]),
  );
  const nameOf = (id: string | null): string =>
    (id === null ? undefined : names.get(id)) ?? UNNAMED;

  return changed
    .map((a) => ({
      billingAccountId: a.billingAccountId,
      fromTypeName: nameOf(a.refBillTemplateFamilyId),
      toTypeName: nameOf(current.get(a.billingAccountId) ?? null),
    }))
    .sort((x, y) =>
      x.billingAccountId < y.billingAccountId
        ? -1
        : x.billingAccountId > y.billingAccountId
          ? 1
          : 0,
    );
}
