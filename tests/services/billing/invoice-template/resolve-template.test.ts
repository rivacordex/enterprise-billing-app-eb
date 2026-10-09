import { beforeEach, describe, expect, it, vi } from "vitest";

// bm53-spec §Design D1, §Tests row 1 — template + profile resolution over
// mocked repositories (the DB-backed reads are covered by the bm50 catalog
// integration suite and tests/db/invoice-profile.integration.test.ts).

vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findById: vi.fn(),
    findActive: vi.fn(),
    findDefault: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: { findActiveVersion: vi.fn() },
}));

import type { Database } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import {
  resolveTemplate,
  resolveVersionsForPosting,
} from "@/services/billing/invoice-template/resolve-template";
import { InvoiceRenderError, type TemplateKind } from "@/types/billing";
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

const repo = vi.mocked(billTemplateVersionRepository);
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
  repo.findDefault.mockImplementation(async (_db, { kind }) => DEFAULTS[kind]);
  profileRepo.findActiveVersion.mockResolvedValue(null);
});

async function codeOf(p: Promise<unknown>): Promise<string | undefined> {
  try {
    await p;
  } catch (err) {
    return err instanceof InvoiceRenderError ? err.code : "untyped";
  }
  return undefined;
}

describe("resolveTemplate — draft", () => {
  it("resolves the defaults when no non-default version is ACTIVE", async () => {
    const r = await resolveTemplate(DB, { kind: "draft" });
    expect(r.generated.billTemplateVersionId).toBe("BTV00000002");
    expect(r.csv.billTemplateVersionId).toBe("BTV00000003");
    expect(r.layout.billTemplateVersionId).toBe("BTV00000001");
  });

  it("resolves the non-default ACTIVE versions when present", async () => {
    repo.findActive.mockImplementation(async (_db, { kind }) =>
      kind === "generated" ? ACTIVE_GENERATED : ACTIVE_CSV,
    );
    const r = await resolveTemplate(DB, { kind: "draft" });
    expect(r.generated.billTemplateVersionId).toBe("BTV00000010");
    expect(r.csv.billTemplateVersionId).toBe("BTV00000011");
  });

  it("resolves the ACTIVE profile version", async () => {
    profileRepo.findActiveVersion.mockResolvedValue(4);
    const r = await resolveTemplate(DB, { kind: "draft" });
    expect(r.profileVersion).toBe(4);
  });

  it("no ACTIVE profile → profileVersion null (G15 A)", async () => {
    const r = await resolveTemplate(DB, { kind: "draft" });
    expect(r.profileVersion).toBeNull();
  });

  it("a missing default (corrupted DB) → TEMPLATE_VERSION_NOT_FOUND, never a fallback", async () => {
    repo.findDefault.mockResolvedValue(null);
    expect(await codeOf(resolveTemplate(DB, { kind: "draft" }))).toBe(
      "TEMPLATE_VERSION_NOT_FOUND",
    );
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
    expect(await codeOf(resolveTemplate(DB, { kind: "draft" }))).toBe(
      "TEMPLATE_VERSION_NOT_FOUND",
    );
  });

  it("is re-queried on every call (never cached, workflow rules §3.9)", async () => {
    await resolveTemplate(DB, { kind: "draft" });
    await resolveTemplate(DB, { kind: "draft" });
    expect(repo.findDefault).toHaveBeenCalledTimes(4);
    expect(repo.findById).toHaveBeenCalledTimes(2);
  });
});

// bm54-spec §Design D1 — the posting stamp shares the draft's "current"
// precedence (one private helper), so a pro-forma and the bill posted next can
// never disagree. DB rows only: no layout lookup, no blob I/O.
describe("resolveVersionsForPosting", () => {
  it("fresh catalog → the default generated + CSV ids, format INVOICE, profile null (G15 A)", async () => {
    expect(await resolveVersionsForPosting(DB)).toEqual({
      refBillFormatId: "INVOICE",
      refBillTemplateVersionId: "BTV00000002",
      refInvoiceProfileVersion: null,
      refCsvTemplateVersionId: "BTV00000003",
    });
  });

  it("the non-default ACTIVE versions + the ACTIVE profile version win over the defaults", async () => {
    repo.findActive.mockImplementation(async (_db, { kind }) =>
      kind === "generated" ? ACTIVE_GENERATED : ACTIVE_CSV,
    );
    profileRepo.findActiveVersion.mockResolvedValue(2);

    expect(await resolveVersionsForPosting(DB)).toEqual({
      refBillFormatId: "INVOICE",
      refBillTemplateVersionId: "BTV00000010",
      refInvoiceProfileVersion: 2,
      refCsvTemplateVersionId: "BTV00000011",
    });
  });

  it("agrees with a draft resolve on the same catalog state", async () => {
    repo.findActive.mockImplementation(async (_db, { kind }) =>
      kind === "generated" ? ACTIVE_GENERATED : null,
    );
    profileRepo.findActiveVersion.mockResolvedValue(4);

    const draft = await resolveTemplate(DB, { kind: "draft" });
    const posting = await resolveVersionsForPosting(DB);
    expect(posting.refBillTemplateVersionId).toBe(
      draft.generated.billTemplateVersionId,
    );
    expect(posting.refCsvTemplateVersionId).toBe(
      draft.csv.billTemplateVersionId,
    );
    expect(posting.refInvoiceProfileVersion).toBe(draft.profileVersion);
  });

  it("reads the catalog rows only — no layout/by-id lookup", async () => {
    await resolveVersionsForPosting(DB);
    expect(repo.findById).not.toHaveBeenCalled();
  });

  it("a missing default (corrupted DB) → TEMPLATE_VERSION_NOT_FOUND (the posting transaction rolls back)", async () => {
    repo.findDefault.mockResolvedValue(null);
    await expect(resolveVersionsForPosting(DB)).rejects.toMatchObject({
      code: "TEMPLATE_VERSION_NOT_FOUND",
    });
  });
});
