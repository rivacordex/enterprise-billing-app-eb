import { beforeEach, describe, expect, it, vi } from "vitest";

// bm57-spec §Design D4: which version the Invoice template page opens on.
// An EDIT user with a working DRAFT opens on it (with its token and last
// saver); a READ user never sees the DRAFT on the edit tab, not even via
// `?version=`, though it is still listed in the history. `?version=` names a
// stored version for everyone and the DRAFT only for EDIT users. bm77: the
// type comes from the `[typeId]` URL (`findById`), never `findDefault`; an
// unknown type is `null` (the page's notFound), and a type with no settings
// yet is `current: null` (the empty state), never a throw.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findActive: vi.fn(),
    findDefault: vi.fn(),
    findById: vi.fn(),
    findDraft: vi.fn(),
    findDraftWithModifier: vi.fn(),
    listForKind: vi.fn(),
    listActiveSettingsByFamily: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {},
}));
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: {
    findDefault: vi.fn(),
    findById: vi.fn(),
    listAll: vi.fn(),
  },
}));
vi.mock("@/services/billing/invoice-template/load", () => ({
  loadGeneratedFiles: vi.fn(),
}));
// bm82 — the Bound BANs count is its own raw-SQL read; the derived status
// stays the real function.
vi.mock(
  "@/services/billing/invoice-template/template-types",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    countBoundBansByType: vi.fn(),
  }),
);

import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { countBoundBansByType } from "@/services/billing/invoice-template/template-types";
import {
  getInvoiceTemplatePageData,
  listTemplateTypes,
  type InvoiceTemplateEditorData,
  type InvoiceTemplatePageData,
} from "@/services/billing/read/invoice-template-settings";
import {
  SEEDED_GENERATED_ROW,
  SEEDED_LAYOUT_ROW,
} from "@/tests/helpers/seeded-invoice-template";

const repo = vi.mocked(billTemplateVersionRepository);
const familyRepo = vi.mocked(billTemplateFamilyRepository);

// The two DRAFTs findDraftWithModifier serves, by kind (set per case).
const drafts: { generated: unknown; layout: unknown } = {
  generated: null,
  layout: null,
};

const DRAFT_ROW = {
  ...SEEDED_GENERATED_ROW,
  billTemplateVersionId: "BTV00000004",
  versionNo: 2,
  status: "DRAFT",
  isDefault: false,
  blobRef: null,
  checksum: null,
  checksumAlgorithm: null,
  activatedDatetime: null,
  lastModifiedDatetime: new Date("2026-10-10T01:02:03Z"),
  token: "2026-10-10T01:02:03.123456Z",
};
const { token: _token, ...DRAFT_PLAIN } = DRAFT_ROW;

const STANDARD = "BTF00000001";
const STANDARD_FAMILY = {
  billTemplateFamilyId: STANDARD,
  code: "STANDARD",
  name: "Standard",
  layoutCode: "INVTPL-STD-A4",
  kind: "generated",
  isDefault: true,
  retiredDatetime: null as Date | null,
  createdBy: null,
  createdDatetime: new Date("2026-10-15T00:00:00Z"),
};

// The page data of a type that has settings (the editor half), or a failure.
function editorOf(
  data: InvoiceTemplatePageData | null,
): InvoiceTemplatePageData & InvoiceTemplateEditorData {
  if (data === null || data.current === null) {
    throw new Error("expected a type with settings");
  }
  return data as InvoiceTemplatePageData & InvoiceTemplateEditorData;
}

async function page(
  versionId: string | undefined,
  canEdit: boolean,
  typeId = STANDARD,
) {
  return editorOf(
    await getInvoiceTemplatePageData(typeId, versionId, { canEdit }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.findActive.mockResolvedValue(null);
  repo.findDefault.mockResolvedValue(SEEDED_GENERATED_ROW);
  repo.findById.mockImplementation(async (_db, id) =>
    id === DRAFT_ROW.billTemplateVersionId
      ? DRAFT_PLAIN
      : id === SEEDED_GENERATED_ROW.billTemplateVersionId
        ? SEEDED_GENERATED_ROW
        : null,
  );
  // bm81 review fix (#4) — the settings DRAFT (with its last writer) and the
  // layout DRAFT both come from findDraftWithModifier; no open layout DRAFT
  // unless a case adds one (bm80).
  drafts.generated = { ...DRAFT_ROW, lastModifiedByName: "Draft Saver" };
  drafts.layout = null;
  repo.findDraftWithModifier.mockImplementation(
    async (_db, { kind }) =>
      (kind === "layout" ? drafts.layout : drafts.generated) as never,
  );
  familyRepo.findById.mockImplementation(async (_db, id) =>
    id === STANDARD ? STANDARD_FAMILY : null,
  );
  repo.listForKind.mockImplementation(async (_db, { kind }) =>
    kind === "layout"
      ? [{ ...SEEDED_LAYOUT_ROW, usedByCount: 0 }]
      : [
          { ...DRAFT_PLAIN, usedByCount: 0 },
          { ...SEEDED_GENERATED_ROW, usedByCount: 5 },
        ],
  );
});

describe("getInvoiceTemplatePageData: the type from the URL (bm66, bm77)", () => {
  it("hands the preview the URL's type id and never reads the default family", async () => {
    const data = await page(undefined, false);
    expect(data.typeId).toBe(STANDARD);
    expect(familyRepo.findById).toHaveBeenCalledWith(
      expect.anything(),
      STANDARD,
    );
    expect(familyRepo.findDefault).not.toHaveBeenCalled();
  });

  it("carries the type header: name, status, default, layout code, next layout version", async () => {
    const data = await page(undefined, false);
    expect(data).toMatchObject({
      typeName: "Standard",
      typeStatus: "USABLE",
      isDefaultType: true,
      layoutCode: "INVTPL-STD-A4",
      nextLayoutVersionNo: 2,
    });
  });

  it("bm80 — carries the open layout DRAFT's version, token, last change and author (the overwrite warning's server data)", async () => {
    const modified = new Date("2026-10-25T03:04:05.000Z");
    drafts.layout = {
      ...SEEDED_LAYOUT_ROW,
      billTemplateVersionId: "BTV00000010",
      versionNo: 2,
      status: "DRAFT",
      lastModifiedDatetime: modified,
      token: "2026-10-25T03:04:05.123456Z",
      lastModifiedByName: "a deleted user",
    };
    const data = await page(undefined, true);
    expect(data?.openLayoutDraft).toEqual({
      versionId: "BTV00000010",
      versionNo: 2,
      token: "2026-10-25T03:04:05.123456Z",
      lastModifiedDatetime: modified,
      lastModifiedByName: "a deleted user",
    });
    expect(repo.findDraftWithModifier).toHaveBeenCalledWith(expect.anything(), {
      kind: "layout",
      familyId: STANDARD,
    });
  });

  it("an unknown type is null (the page calls notFound)", async () => {
    expect(
      await getInvoiceTemplatePageData("BTF00000099", undefined, {
        canEdit: false,
      }),
    ).toBeNull();
  });

  it("a type with no settings yet is current: null with an empty history (Not yet usable), not a throw", async () => {
    familyRepo.findById.mockResolvedValue({
      ...STANDARD_FAMILY,
      billTemplateFamilyId: "BTF00000002",
      code: "WHOLESALE",
      name: "Wholesale",
      layoutCode: "INVTPL-WHOLESALE",
      isDefault: false,
    });
    repo.findDefault.mockResolvedValue(null);
    drafts.generated = null;
    repo.listForKind.mockResolvedValue([]);
    const data = await getInvoiceTemplatePageData("BTF00000002", undefined, {
      canEdit: true,
    });
    expect(data).toMatchObject({
      typeId: "BTF00000002",
      typeStatus: "NOT_YET_USABLE",
      isDefaultType: false,
      layoutCode: "INVTPL-WHOLESALE",
      nextLayoutVersionNo: 1,
      current: null,
      history: [],
    });
  });

  it("ignores ?version= naming another family's version, so the Standard heading stays true", async () => {
    repo.findById.mockResolvedValue({
      ...SEEDED_GENERATED_ROW,
      billTemplateVersionId: "BTV00000009",
      refBillTemplateFamilyId: "BTF00000002",
    });
    const data = await page("BTV00000009", false);
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
  });

  it("a stored structure from before bm72 (no footnote) throws TEMPLATE_VERSION_NOT_FOUND / STRUCTURE_INVALID, never a TypeError in the form", async () => {
    repo.findDefault.mockResolvedValue({
      ...SEEDED_GENERATED_ROW,
      structure: {
        sections: { payment: true, notes: true },
        columns: {},
      } as never,
    });
    await expect(page(undefined, false)).rejects.toMatchObject({
      code: "TEMPLATE_VERSION_NOT_FOUND",
      detail: { reason: "STRUCTURE_INVALID", versionId: "BTV00000002" },
    });
  });
});

describe("getInvoiceTemplatePageData: the working draft", () => {
  it("opens an EDIT user on the DRAFT, with its token and last saver", async () => {
    const data = await page(undefined, true);
    expect(data.shown.billTemplateVersionId).toBe("BTV00000004");
    expect(data.defaultShown.billTemplateVersionId).toBe("BTV00000004");
    expect(data.current?.billTemplateVersionId).toBe("BTV00000002");
    expect(data.draft).toEqual({
      billTemplateVersionId: "BTV00000004",
      versionNo: 2,
      token: "2026-10-10T01:02:03.123456Z",
      savedAt: new Date("2026-10-10T01:02:03Z"),
      savedBy: "Draft Saver",
    });
  });

  it("lets an EDIT user open the current version with ?version= while keeping the draft token", async () => {
    const data = await page("BTV00000002", true);
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
    expect(data.draft?.token).toBe("2026-10-10T01:02:03.123456Z");
  });

  it("never loads or shows the DRAFT for a READ user", async () => {
    const data = await page(undefined, false);
    expect(repo.findDraftWithModifier).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ kind: "generated" }),
    );
    expect(data.draft).toBeNull();
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
    expect(data.defaultShown.billTemplateVersionId).toBe("BTV00000002");
  });

  it("ignores ?version=<draft> for a READ user", async () => {
    const data = await page("BTV00000004", false);
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
  });

  it("still lists the DRAFT in the history for a READ user", async () => {
    const data = await page(undefined, false);
    expect(data.history.map((h) => [h.versionNo, h.status])).toEqual([
      [2, "DRAFT"],
      [1, "ACTIVE"],
    ]);
    expect(data.history[0]?.activatedAt).toBeNull();
  });

  it("opens on the current version when an EDIT user has no draft", async () => {
    drafts.generated = null;
    const data = await page(undefined, true);
    expect(data.draft).toBeNull();
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
  });

  it("bm81 review fix (#4) — a draft with no recorded writer is saved by 'an unknown user'", async () => {
    drafts.generated = { ...DRAFT_ROW, lastModifiedByName: null };
    const data = await page(undefined, true);
    expect(data.draft?.savedBy).toBe("an unknown user");
  });
});

describe("listTemplateTypes (bm77)", () => {
  it("joins every type with its active settings version, derives the status and (bm82) merges the Bound BANs count, default 0", async () => {
    vi.mocked(countBoundBansByType).mockResolvedValue(
      new Map([
        [STANDARD, 3],
        ["BTF00000003", 1],
      ]),
    );
    familyRepo.listAll.mockResolvedValue([
      STANDARD_FAMILY,
      {
        ...STANDARD_FAMILY,
        billTemplateFamilyId: "BTF00000002",
        name: "Wholesale",
        isDefault: false,
      },
      {
        ...STANDARD_FAMILY,
        billTemplateFamilyId: "BTF00000003",
        name: "Old",
        isDefault: false,
        retiredDatetime: new Date("2026-10-20T00:00:00Z"),
      },
    ]);
    repo.listActiveSettingsByFamily.mockResolvedValue(
      new Map([
        [
          STANDARD,
          {
            versionNo: 1,
            activatedDatetime: new Date("2026-10-08T00:00:00Z"),
          },
        ],
      ]),
    );
    expect(await listTemplateTypes()).toEqual([
      {
        billTemplateFamilyId: STANDARD,
        name: "Standard",
        isDefault: true,
        status: "USABLE",
        activeVersionNo: 1,
        activeSince: new Date("2026-10-08T00:00:00Z"),
        retiredAt: null,
        boundBanCount: 3,
      },
      {
        billTemplateFamilyId: "BTF00000002",
        name: "Wholesale",
        isDefault: false,
        status: "NOT_YET_USABLE",
        activeVersionNo: null,
        activeSince: null,
        retiredAt: null,
        boundBanCount: 0,
      },
      {
        billTemplateFamilyId: "BTF00000003",
        name: "Old",
        isDefault: false,
        status: "RETIRED",
        activeVersionNo: null,
        activeSince: null,
        retiredAt: new Date("2026-10-20T00:00:00Z"),
        boundBanCount: 1,
      },
    ]);
    expect(countBoundBansByType).toHaveBeenCalledTimes(1);
  });
});
