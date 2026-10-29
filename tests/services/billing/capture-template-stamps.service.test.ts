import { beforeEach, describe, expect, it, vi } from "vitest";

// bm65-spec §5 — `captureTemplateStamps`' orchestration over mocked reads: one
// family read for every BAN, the shared profile ONCE, one generated
// resolution per DISTINCT family, one write pruned to the run's partition, a
// NULL version for a family with nothing usable (D55), a NULL family and
// version for a BAN whose family cannot be resolved (review fix §24e), and no
// work for an empty BAN list. The SQL itself is proven by the
// run-template-capture integration suite.

vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: {
    listBanFamilies: vi.fn(),
    captureTemplateStamps: vi.fn(),
  },
}));
vi.mock("@/services/billing/invoice-template/resolve-template", () => ({
  resolveGeneratedForFamily: vi.fn(),
  resolveSharedCurrentVersions: vi.fn(),
}));

import type { Database } from "@/db/client";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { captureTemplateStamps } from "@/services/billing/capture-template-stamps";
import {
  resolveGeneratedForFamily,
  resolveSharedCurrentVersions,
} from "@/services/billing/invoice-template/resolve-template";

const tx = {} as Database;
const PARTITION = "2026-06-01";
const listBanFamilies = vi.mocked(billRunAccountRepository.listBanFamilies);
const writeStamps = vi.mocked(billRunAccountRepository.captureTemplateStamps);
const resolveGenerated = vi.mocked(resolveGeneratedForFamily);
const resolveShared = vi.mocked(resolveSharedCurrentVersions);

beforeEach(() => {
  vi.clearAllMocks();
  resolveShared.mockResolvedValue({
    profileVersion: 2,
  });
});

describe("captureTemplateStamps (bm65-spec §5)", () => {
  it("an empty BAN list does no work", async () => {
    expect(
      await captureTemplateStamps(tx, "BRN00000001", [], PARTITION),
    ).toEqual([]);
    expect(listBanFamilies).not.toHaveBeenCalled();
    expect(resolveShared).not.toHaveBeenCalled();
    expect(resolveGenerated).not.toHaveBeenCalled();
    expect(writeStamps).not.toHaveBeenCalled();
  });

  it("reads the profile once, resolves once per distinct family, and writes every BAN in one partition-pruned call", async () => {
    listBanFamilies.mockResolvedValue([
      { banId: "BAN00000001", familyId: "BTF00000001" },
      { banId: "BAN00000002", familyId: "BTF00000001" },
      { banId: "BAN00000003", familyId: "BTF00000099" },
      // Review fix §24e — an unresolvable family (corrupted catalog, or a
      // reference to a non-generated version).
      { banId: "BAN00000004", familyId: null },
    ]);
    resolveGenerated.mockImplementation(async (_db, familyId) =>
      familyId === "BTF00000001"
        ? ({ billTemplateVersionId: "BTV00000002" } as never)
        : null,
    );

    const stamps = await captureTemplateStamps(
      tx,
      "BRN00000001",
      ["BAN00000001", "BAN00000002", "BAN00000003", "BAN00000004"],
      PARTITION,
    );

    expect(resolveShared).toHaveBeenCalledTimes(1);
    expect(resolveGenerated).toHaveBeenCalledTimes(2);
    expect(stamps).toEqual([
      {
        banId: "BAN00000001",
        familyId: "BTF00000001",
        versionId: "BTV00000002",
      },
      {
        banId: "BAN00000002",
        familyId: "BTF00000001",
        versionId: "BTV00000002",
      },
      // D55 — a family with nothing usable is stamped NULL, never thrown.
      { banId: "BAN00000003", familyId: "BTF00000099", versionId: null },
      { banId: "BAN00000004", familyId: null, versionId: null },
    ]);
    expect(writeStamps).toHaveBeenCalledTimes(1);
    expect(writeStamps).toHaveBeenCalledWith(
      tx,
      "BRN00000001",
      PARTITION,
      stamps,
      { profileVersion: 2 },
    );
  });
});
