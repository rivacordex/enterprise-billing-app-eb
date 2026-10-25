import { beforeEach, describe, expect, it, vi } from "vitest";

// bm53-spec §Design D1, §Tests row 1 — template + profile resolution over
// mocked repositories (the DB-backed reads are covered by the bm50 catalog
// integration suite and tests/db/invoice-profile.integration.test.ts).
// bm66-spec §6 — the `run` mode (the BAN's captured stamps, never live) and
// `preview-family` (the family's live versions) replace `draft`.

vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findById: vi.fn(),
    findActive: vi.fn(),
    findDefault: vi.fn(),
  },
}));
// Review fix (§24d) — the family resolver reads the family to refuse a
// retired one.
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: { findActiveVersion: vi.fn() },
}));

import type { Database } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { resolveTemplate } from "@/services/billing/invoice-template/resolve-template";
import { InvoiceRenderError, type TemplateKind } from "@/types/billing";
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

const repo = vi.mocked(billTemplateVersionRepository);
const familyRepo = vi.mocked(billTemplateFamilyRepository);
const profileRepo = vi.mocked(invoiceProfileRepository);
const DB = {} as Database;

function row(
  id: string,
  kind: TemplateKind,
  overrides: Partial<BillTemplateVersion> = {},
): BillTemplateVersion {
  return {
    ...SEEDED_GENERATED_ROW,
    billTemplateVersionId: id,
    kind,
    refLayoutVersionId: kind === "generated" ? "BTV00000001" : null,
    ...overrides,
  };
}

const LAYOUT = row("BTV00000001", "layout", { layoutCode: "INVTPL-STD-A4" });
const DEFAULT_GENERATED = row("BTV00000002", "generated");
const DEFAULT_CSV = row("BTV00000003", "csv");
const ACTIVE_GENERATED = row("BTV00000010", "generated", {
  isDefault: false,
  versionNo: 3,
});
const ACTIVE_CSV = row("BTV00000011", "csv", { isDefault: false });
const PINNED_GENERATED = row("BTV00000007", "generated", {
  isDefault: false,
  status: "RETIRED",
  versionNo: 2,
});

const ROWS = new Map(
  [
    LAYOUT,
    DEFAULT_GENERATED,
    DEFAULT_CSV,
    ACTIVE_GENERATED,
    ACTIVE_CSV,
    PINNED_GENERATED,
  ].map((r) => [r.billTemplateVersionId, r]),
);

const DEFAULTS: Record<TemplateKind, BillTemplateVersion> = {
  layout: LAYOUT,
  generated: DEFAULT_GENERATED,
  csv: DEFAULT_CSV,
};

beforeEach(() => {
  vi.clearAllMocks();
  repo.findById.mockImplementation(async (_db, id) => ROWS.get(id) ?? null);
  repo.findActive.mockResolvedValue(null);
  // The generated default exists only in the default family (Standard).
  repo.findDefault.mockImplementation(async (_db, { kind, familyId }) =>
    kind === "generated" && familyId !== undefined && familyId !== STANDARD
      ? null
      : DEFAULTS[kind],
  );
  familyRepo.findById.mockImplementation(async (_db, id) => ({
    billTemplateFamilyId: id,
    code: id,
    name: id,
    layoutCode: `INVTPL-${id}`,
    kind: "generated",
    isDefault: id === STANDARD,
    retiredDatetime: null,
    createdBy: null,
    createdDatetime: new Date("2026-10-15T00:00:00Z"),
  }));
  profileRepo.findActiveVersion.mockResolvedValue(null);
});

const STANDARD = "BTF00000001";
const BAN = "BAN00000001";

function runStamps(
  overrides: Partial<{
    refBillTemplateFamilyId: string | null;
    refBillTemplateVersionId: string | null;
    refInvoiceProfileVersion: number | null;
    refCsvTemplateVersionId: string | null;
  }> = {},
) {
  return {
    refBillTemplateFamilyId: STANDARD,
    refBillTemplateVersionId: "BTV00000007",
    refInvoiceProfileVersion: 2,
    refCsvTemplateVersionId: "BTV00000003",
    ...overrides,
  };
}

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof InvoiceRenderError ? err.code : "untyped";
  }
  return undefined;
}

describe("resolveTemplate — run (the BAN's captured stamps)", () => {
  it("resolves exactly the stamped ids, even when a newer ACTIVE exists — never live", async () => {
    repo.findActive.mockImplementation(async (_db, { kind }) =>
      kind === "generated" ? ACTIVE_GENERATED : ACTIVE_CSV,
    );
    profileRepo.findActiveVersion.mockResolvedValue(9);

    const r = await resolveTemplate(DB, {
      kind: "run",
      stamps: runStamps(),
      banId: BAN,
    });
    expect(r.generated.billTemplateVersionId).toBe("BTV00000007");
    expect(r.csv.billTemplateVersionId).toBe("BTV00000003");
    expect(r.layout.billTemplateVersionId).toBe("BTV00000001");
    expect(r.profileVersion).toBe(2);
    // `run` is not a live mode: no "current" lookup of any kind.
    expect(repo.findActive).not.toHaveBeenCalled();
    expect(repo.findDefault).not.toHaveBeenCalled();
    expect(familyRepo.findById).not.toHaveBeenCalled();
    expect(profileRepo.findActiveVersion).not.toHaveBeenCalled();
  });

  it("a NULL profile stamp stays NULL (G15 A)", async () => {
    const r = await resolveTemplate(DB, {
      kind: "run",
      stamps: runStamps({ refInvoiceProfileVersion: null }),
      banId: BAN,
    });
    expect(r.profileVersion).toBeNull();
  });

  it("a NULL generated stamp → TEMPLATE_VERSION_NOT_FOUND (FAMILY_HAS_NO_ACTIVE_VERSION), never the default (D55, P3)", async () => {
    const err = await resolveTemplate(DB, {
      kind: "run",
      stamps: runStamps({
        refBillTemplateFamilyId: "BTF00000099",
        refBillTemplateVersionId: null,
      }),
      banId: BAN,
    }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(InvoiceRenderError);
    expect(err).toMatchObject({
      code: "TEMPLATE_VERSION_NOT_FOUND",
      detail: {
        reason: "FAMILY_HAS_NO_ACTIVE_VERSION",
        familyId: "BTF00000099",
        // code-standards Phase 3 TS rule 8 — the BAN rides in the detail.
        banId: BAN,
      },
    });
    expect(repo.findDefault).not.toHaveBeenCalled();
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("a stamped id that is missing, a DRAFT or the wrong kind → TEMPLATE_VERSION_NOT_FOUND", async () => {
    ROWS.set(
      "BTV00000021",
      row("BTV00000021", "generated", { status: "DRAFT" }),
    );
    for (const id of ["BTV00099999", "BTV00000021", "BTV00000003"]) {
      expect(
        await codeOf(
          resolveTemplate(DB, {
            kind: "run",
            stamps: runStamps({ refBillTemplateVersionId: id }),
            banId: BAN,
          }),
        ),
      ).toBe("TEMPLATE_VERSION_NOT_FOUND");
    }
  });
});

describe("resolveTemplate — preview-family (the family's live versions)", () => {
  it("resolves the family's default when it has no non-default ACTIVE", async () => {
    const r = await resolveTemplate(DB, {
      kind: "preview-family",
      familyId: STANDARD,
    });
    expect(r.generated.billTemplateVersionId).toBe("BTV00000002");
    expect(r.csv.billTemplateVersionId).toBe("BTV00000003");
    expect(r.layout.billTemplateVersionId).toBe("BTV00000001");
    expect(repo.findActive).toHaveBeenCalledWith(DB, {
      kind: "generated",
      familyId: STANDARD,
    });
  });

  it("resolves the family's non-default ACTIVE, the current CSV and the ACTIVE profile", async () => {
    repo.findActive.mockImplementation(async (_db, { kind, familyId }) =>
      kind === "csv"
        ? ACTIVE_CSV
        : kind === "generated" && familyId === STANDARD
          ? ACTIVE_GENERATED
          : null,
    );
    profileRepo.findActiveVersion.mockResolvedValue(4);
    const r = await resolveTemplate(DB, {
      kind: "preview-family",
      familyId: STANDARD,
    });
    expect(r.generated.billTemplateVersionId).toBe("BTV00000010");
    expect(r.csv.billTemplateVersionId).toBe("BTV00000011");
    expect(r.profileVersion).toBe(4);
  });

  it("no ACTIVE profile → profileVersion null (G15 A)", async () => {
    const r = await resolveTemplate(DB, {
      kind: "preview-family",
      familyId: STANDARD,
    });
    expect(r.profileVersion).toBeNull();
  });

  it("a family with no version → TEMPLATE_VERSION_NOT_FOUND with the D55 detail", async () => {
    await expect(
      resolveTemplate(DB, { kind: "preview-family", familyId: "BTF00000099" }),
    ).rejects.toMatchObject({
      code: "TEMPLATE_VERSION_NOT_FOUND",
      detail: {
        reason: "FAMILY_HAS_NO_ACTIVE_VERSION",
        familyId: "BTF00000099",
      },
    });
  });

  it("review fix (D44, §24d) — a retired family is not usable: TEMPLATE_VERSION_NOT_FOUND, never its ACTIVE version", async () => {
    familyRepo.findById.mockResolvedValue({
      billTemplateFamilyId: "BTF00000077",
      code: "RETIRED",
      name: "Retired",
      layoutCode: "INVTPL-RETIRED",
      kind: "generated",
      isDefault: false,
      retiredDatetime: new Date("2026-10-15T00:00:00Z"),
      createdBy: null,
      createdDatetime: new Date("2026-10-01T00:00:00Z"),
    });
    repo.findActive.mockResolvedValue(ACTIVE_GENERATED);
    await expect(
      resolveTemplate(DB, { kind: "preview-family", familyId: "BTF00000077" }),
    ).rejects.toMatchObject({
      code: "TEMPLATE_VERSION_NOT_FOUND",
      detail: { reason: "FAMILY_HAS_NO_ACTIVE_VERSION" },
    });
  });

  it("a missing CSV default (corrupted DB) → TEMPLATE_VERSION_NOT_FOUND, never a fallback", async () => {
    repo.findDefault.mockResolvedValue(null);
    expect(
      await codeOf(
        resolveTemplate(DB, { kind: "preview-family", familyId: STANDARD }),
      ),
    ).toBe("TEMPLATE_VERSION_NOT_FOUND");
  });
});

describe.each(["final", "preview-posted"] as const)(
  "resolveTemplate — %s",
  (kind) => {
    it("stamps present → the stamped ids + version, even when a newer ACTIVE exists", async () => {
      repo.findActive.mockImplementation(async (_db, { kind: k }) =>
        k === "generated" ? ACTIVE_GENERATED : ACTIVE_CSV,
      );
      profileRepo.findActiveVersion.mockResolvedValue(9);
      const r = await resolveTemplate(DB, {
        kind,
        bill: {
          refBillTemplateFamilyId: "BTF00000001",
          refBillTemplateVersionId: "BTV00000007",
          refInvoiceProfileVersion: 2,
          refCsvTemplateVersionId: "BTV00000003",
        },
      });
      expect(r.generated.billTemplateVersionId).toBe("BTV00000007");
      expect(r.csv.billTemplateVersionId).toBe("BTV00000003");
      expect(r.profileVersion).toBe(2);
      // Inv #42 — a posted bill never consults the current ACTIVE.
      expect(repo.findActive).not.toHaveBeenCalled();
      expect(profileRepo.findActiveVersion).not.toHaveBeenCalled();
    });

    it("NULL stamps (posted before bm54) → the default + a null profile, never the current ACTIVE", async () => {
      repo.findActive.mockImplementation(async (_db, { kind: k }) =>
        k === "generated" ? ACTIVE_GENERATED : ACTIVE_CSV,
      );
      profileRepo.findActiveVersion.mockResolvedValue(9);
      const r = await resolveTemplate(DB, {
        kind,
        bill: {
          refBillTemplateFamilyId: null,
          refBillTemplateVersionId: null,
          refInvoiceProfileVersion: null,
          refCsvTemplateVersionId: null,
        },
      });
      expect(r.generated.billTemplateVersionId).toBe("BTV00000002");
      expect(r.csv.billTemplateVersionId).toBe("BTV00000003");
      expect(r.profileVersion).toBeNull();
      expect(repo.findActive).not.toHaveBeenCalled();
      expect(profileRepo.findActiveVersion).not.toHaveBeenCalled();
    });

    it("a missing stamped id → TEMPLATE_VERSION_NOT_FOUND", async () => {
      expect(
        await codeOf(
          resolveTemplate(DB, {
            kind,
            bill: {
              refBillTemplateFamilyId: "BTF00000001",
              refBillTemplateVersionId: "BTV00099999",
              refInvoiceProfileVersion: 1,
              refCsvTemplateVersionId: null,
            },
          }),
        ),
      ).toBe("TEMPLATE_VERSION_NOT_FOUND");
    });

    it("a stamped DRAFT or wrong-kind id → TEMPLATE_VERSION_NOT_FOUND", async () => {
      ROWS.set(
        "BTV00000020",
        row("BTV00000020", "generated", { status: "DRAFT" }),
      );
      for (const id of ["BTV00000020", "BTV00000003"]) {
        expect(
          await codeOf(
            resolveTemplate(DB, {
              kind,
              bill: {
                refBillTemplateFamilyId: "BTF00000001",
                refBillTemplateVersionId: id,
                refInvoiceProfileVersion: null,
                refCsvTemplateVersionId: null,
              },
            }),
          ),
        ).toBe("TEMPLATE_VERSION_NOT_FOUND");
      }
    });
  },
);

describe("resolveTemplate — layout", () => {
  it("a generated version whose layout is missing → TEMPLATE_VERSION_NOT_FOUND", async () => {
    repo.findDefault.mockImplementation(async (_db, { kind }) =>
      kind === "generated"
        ? row("BTV00000002", "generated", { refLayoutVersionId: "BTV00088888" })
        : DEFAULTS[kind],
    );
    expect(
      await codeOf(
        resolveTemplate(DB, { kind: "preview-family", familyId: STANDARD }),
      ),
    ).toBe("TEMPLATE_VERSION_NOT_FOUND");
  });

  it("is re-queried on every call (never cached, workflow rules §3.9)", async () => {
    await resolveTemplate(DB, { kind: "preview-family", familyId: STANDARD });
    await resolveTemplate(DB, { kind: "preview-family", familyId: STANDARD });
    // Twice per call: the family's generated default and the CSV default.
    expect(repo.findDefault).toHaveBeenCalledTimes(4);
    expect(repo.findById).toHaveBeenCalledTimes(2);
  });
});

// bm67 — `resolveVersionsForPosting` is deleted: posting copies the BAN's run
// stamps onto the bill and resolves nothing (guardrail 57).
