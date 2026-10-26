import { beforeEach, describe, expect, it, vi } from "vitest";

// bm84-spec §6 — `listRerunTemplateChanges` on mocked repositories: only the
// rerun-eligible BANs (EXCLUDED, posted and unselected ones are ignored); a
// changed family gives one row with both names; an unchanged family or a NULL
// run-start stamp gives none; a retired source type is still named; sorted.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listForRerun: vi.fn(), listBanFamilies: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { listPostedAccountIds: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: { listAll: vi.fn() },
}));

import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { listRerunTemplateChanges } from "@/services/billing/read/list-rerun-template-changes";

const runAccounts = vi.mocked(billRunAccountRepository);
const bills = vi.mocked(customerBillRepository);
const families = vi.mocked(billTemplateFamilyRepository);

const STANDARD = "BTF00000001";
const WHOLESALE = "BTF00000002";
const RETAIL = "BTF00000003";

function account(id: string, stamp: string | null, status = "PROCESSED") {
  return {
    billingAccountId: id,
    status: status as never,
    attemptCount: 1,
    refBillTemplateFamilyId: stamp,
  };
}

function family(id: string, name: string, retired = false) {
  return {
    billTemplateFamilyId: id,
    name,
    retiredDatetime: retired ? new Date("2026-10-26T00:00:00Z") : null,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  bills.listPostedAccountIds.mockResolvedValue([]);
  families.listAll.mockResolvedValue([
    family(STANDARD, "Standard"),
    family(WHOLESALE, "Wholesale", true),
    family(RETAIL, "Retail"),
  ]);
  // The current family per BAN, as listBanFamilies resolves it (NULL → Standard).
  runAccounts.listBanFamilies.mockImplementation(async (_db, banIds) =>
    banIds.map((banId) => ({
      banId,
      familyId:
        banId === "BAN00000004"
          ? RETAIL
          : banId === "BAN00000005"
            ? WHOLESALE
            : STANDARD,
    })),
  );
});

describe("listRerunTemplateChanges (bm84)", () => {
  it("a changed family gives one row with both names (a retired source type is still named); unchanged and NULL stamps give none; sorted", async () => {
    runAccounts.listForRerun.mockResolvedValue([
      account("BAN00000004", WHOLESALE), // Wholesale → Retail
      account("BAN00000001", WHOLESALE), // Wholesale (retired) → Standard
      account("BAN00000002", STANDARD), // unchanged
      account("BAN00000003", null), // no run-start stamp
      account("BAN00000005", WHOLESALE), // unchanged
    ]);
    expect(await listRerunTemplateChanges("BRN00000001", [])).toEqual([
      {
        billingAccountId: "BAN00000001",
        fromTypeName: "Wholesale",
        toTypeName: "Standard",
      },
      {
        billingAccountId: "BAN00000004",
        fromTypeName: "Wholesale",
        toTypeName: "Retail",
      },
    ]);
  });

  it("only eligible BANs: EXCLUDED, posted and unselected BANs are ignored and never read", async () => {
    runAccounts.listForRerun.mockResolvedValue([
      account("BAN00000001", WHOLESALE),
      account("BAN00000006", WHOLESALE, "EXCLUDED"),
      account("BAN00000007", WHOLESALE),
      account("BAN00000008", WHOLESALE),
    ]);
    bills.listPostedAccountIds.mockResolvedValue(["BAN00000007"]);
    const changes = await listRerunTemplateChanges("BRN00000001", [
      "BAN00000001",
      "BAN00000006",
      "BAN00000007",
    ]);
    expect(changes.map((c) => c.billingAccountId)).toEqual(["BAN00000001"]);
    expect(runAccounts.listBanFamilies).toHaveBeenCalledWith(
      expect.anything(),
      ["BAN00000001"],
    );
  });

  it("no eligible BAN reads nothing further", async () => {
    runAccounts.listForRerun.mockResolvedValue([
      account("BAN00000006", WHOLESALE, "EXCLUDED"),
    ]);
    expect(await listRerunTemplateChanges("BRN00000001", [])).toEqual([]);
    expect(runAccounts.listBanFamilies).not.toHaveBeenCalled();
    expect(families.listAll).not.toHaveBeenCalled();
  });

  it("a NULL current family (no default) reads —", async () => {
    runAccounts.listForRerun.mockResolvedValue([
      account("BAN00000001", WHOLESALE),
    ]);
    runAccounts.listBanFamilies.mockResolvedValue([
      { banId: "BAN00000001", familyId: null },
    ]);
    expect(await listRerunTemplateChanges("BRN00000001", [])).toEqual([
      {
        billingAccountId: "BAN00000001",
        fromTypeName: "Wholesale",
        toTypeName: "—",
      },
    ]);
  });
});
