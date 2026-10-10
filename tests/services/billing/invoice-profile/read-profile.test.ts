import { beforeEach, describe, expect, it, vi } from "vitest";

// bm56-spec §Tests — the Company profile page view-model: no profile → the
// empty state; ACTIVE preferred; `?version` honoured; a DRAFT hidden from READ
// users and shown to EDIT users; an incomplete DRAFT still renders (unparsed
// view); `meta.*` split out and surfaced in the history. bm59 D3: EDIT users
// open the working DRAFT (with its token) ahead of the ACTIVE version.

vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: {
    listVersions: vi.fn(),
    readVersionRaw: vi.fn(),
    resolveUserNames: vi.fn(),
    findDraftVersion: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-asset", () => ({
  billAssetRepository: { findVersionById: vi.fn(), hasLogoVersion: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", () => ({ blobStore: {} }));

import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { getCompanyProfilePageModel } from "@/services/billing/invoice-profile/read-profile";

const repo = vi.mocked(invoiceProfileRepository);
const DB = {} as never;

type Summary = Awaited<ReturnType<typeof repo.listVersions>>[number];

function summary(
  overrides: Partial<Summary> & { configVersion: number },
): Summary {
  return {
    status: "ACTIVE",
    modifiedBy: "user-1",
    createdDatetime: new Date("2026-10-01T00:00:00Z"),
    lastModifiedDatetime: new Date("2026-10-02T00:00:00Z"),
    meta: {},
    usedByCount: 0,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  repo.resolveUserNames.mockResolvedValue(new Map([["user-1", "Alice"]]));
  repo.findDraftVersion.mockResolvedValue(null);
  vi.mocked(billAssetRepository.hasLogoVersion).mockResolvedValue(false);
  repo.readVersionRaw.mockImplementation(async (_db, version) => ({
    fields: {
      company_name: `Co v${version}`,
      logo_asset_version_id: "INVASV00000001",
    },
    meta: {},
  }));
});

describe("getCompanyProfilePageModel", () => {
  it("returns shown: null and an empty history when no profile exists", async () => {
    repo.listVersions.mockResolvedValue([]);
    const model = await getCompanyProfilePageModel(DB, { canEdit: true });
    expect(model).toEqual({
      shown: null,
      history: [],
      draft: null,
      hasLogoAsset: false,
      activeFields: null,
    });
    expect(repo.readVersionRaw).not.toHaveBeenCalled();
  });

  it("opens the working DRAFT for EDIT users ahead of the ACTIVE version, with its token (bm59 D3)", async () => {
    repo.listVersions.mockResolvedValue([
      summary({
        configVersion: 3,
        status: "DRAFT",
        lastModifiedDatetime: new Date("2026-10-09T00:00:00Z"),
      }),
      summary({ configVersion: 2, status: "ACTIVE" }),
      summary({ configVersion: 1, status: "RETIRED" }),
    ]);
    repo.findDraftVersion.mockResolvedValue({
      configVersion: 3,
      token: "2026-10-09T00:00:00.000000Z",
    });
    const { shown, draft } = await getCompanyProfilePageModel(DB, {
      canEdit: true,
    });
    expect(shown?.version).toBe(3);
    expect(shown?.status).toBe("DRAFT");
    expect(draft).toEqual({
      version: 3,
      token: "2026-10-09T00:00:00.000000Z",
      savedAt: new Date("2026-10-09T00:00:00Z"),
      savedBy: "Alice",
    });
  });

  it("opens the ACTIVE version for EDIT users when no draft exists", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 2, status: "ACTIVE" }),
      summary({ configVersion: 1, status: "RETIRED" }),
    ]);
    const { shown, draft } = await getCompanyProfilePageModel(DB, {
      canEdit: true,
    });
    expect(shown?.version).toBe(2);
    expect(shown?.logoAssetVersionId).toBe("INVASV00000001");
    expect(draft).toBeNull();
    // bm61 D5 — the ACTIVE field map the activate dialog diffs against.
    const model = await getCompanyProfilePageModel(DB, { canEdit: true });
    expect(model.activeFields).toEqual({
      company_name: "Co v2",
      logo_asset_version_id: "INVASV00000001",
    });
    expect(
      (await getCompanyProfilePageModel(DB, { canEdit: false })).activeFields,
    ).toBeNull();
    expect(repo.findDraftVersion).not.toHaveBeenCalled();
  });

  it("honours ?version for any visible status", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 2, status: "ACTIVE" }),
      summary({ configVersion: 1, status: "RETIRED" }),
    ]);
    const { shown } = await getCompanyProfilePageModel(DB, {
      version: 1,
      canEdit: false,
    });
    expect(shown?.version).toBe(1);
    expect(shown?.status).toBe("RETIRED");
  });

  it("ignores an unknown ?version and falls back to the ACTIVE one", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 2, status: "ACTIVE" }),
    ]);
    const { shown } = await getCompanyProfilePageModel(DB, {
      version: 99,
      canEdit: false,
    });
    expect(shown?.version).toBe(2);
  });

  it("hides a DRAFT from READ users: shown, ?version and history", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 2, status: "DRAFT" }),
      summary({ configVersion: 1, status: "ACTIVE" }),
    ]);
    const model = await getCompanyProfilePageModel(DB, {
      version: 2,
      canEdit: false,
    });
    expect(model.shown?.version).toBe(1);
    expect(model.history.map((h) => h.versionNo)).toEqual([1]);
    expect(model.draft).toBeNull();
    expect(repo.findDraftVersion).not.toHaveBeenCalled();
    expect(repo.readVersionRaw).toHaveBeenCalledTimes(1);
    expect(repo.readVersionRaw).toHaveBeenCalledWith(DB, 1);
  });

  it("EDIT user on the ACTIVE version: one raw read feeds both shown and activeFields", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 1, status: "ACTIVE" }),
    ]);
    const model = await getCompanyProfilePageModel(DB, { canEdit: true });
    expect(model.shown?.version).toBe(1);
    expect(model.activeFields).toEqual(model.shown?.fields);
    expect(repo.readVersionRaw).toHaveBeenCalledTimes(1);
  });

  it("hasLogoAsset follows a stored logo VERSION, not a bare asset row (bm60 D8)", async () => {
    repo.listVersions.mockResolvedValue([]);
    vi.mocked(billAssetRepository.hasLogoVersion).mockResolvedValue(true);
    expect(
      (await getCompanyProfilePageModel(DB, { canEdit: true })).hasLogoAsset,
    ).toBe(true);
  });

  it("shows the DRAFT to EDIT users when nothing is ACTIVE", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 1, status: "DRAFT" }),
    ]);
    const { shown } = await getCompanyProfilePageModel(DB, { canEdit: true });
    expect(shown?.version).toBe(1);
    expect(shown?.status).toBe("DRAFT");
  });

  it("shows the empty state to READ users when only a DRAFT exists", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 1, status: "DRAFT" }),
    ]);
    const model = await getCompanyProfilePageModel(DB, { canEdit: false });
    expect(model).toEqual({
      shown: null,
      history: [],
      draft: null,
      hasLogoAsset: true,
      activeFields: null,
    });
  });

  it("renders an incomplete DRAFT as the unparsed field map (no schema parse)", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 1, status: "DRAFT" }),
    ]);
    repo.readVersionRaw.mockResolvedValue({
      fields: { company_name: "Half Done", tin: "not-a-tin" },
      meta: {},
    });
    const { shown } = await getCompanyProfilePageModel(DB, { canEdit: true });
    expect(shown?.fields).toEqual({
      company_name: "Half Done",
      tin: "not-a-tin",
    });
    expect(shown?.logoAssetVersionId).toBeNull();
  });

  it("splits meta.* into meta/history and resolves the activator name", async () => {
    repo.listVersions.mockResolvedValue([
      summary({
        configVersion: 2,
        status: "ACTIVE",
        usedByCount: 4,
        meta: {
          "meta.change_note": "New bank",
          "meta.activated_by": "user-1",
          "meta.activated_at": "2026-10-05T01:02:03Z",
        },
      }),
      summary({
        configVersion: 1,
        status: "RETIRED",
        meta: { "meta.retired_at": "2026-10-05T01:02:03Z" },
      }),
    ]);
    repo.readVersionRaw.mockResolvedValue({
      fields: { company_name: "Co" },
      meta: {
        "meta.change_note": "New bank",
        "meta.activated_by": "user-1",
        "meta.activated_at": "2026-10-05T01:02:03Z",
      },
    });
    const model = await getCompanyProfilePageModel(DB, { canEdit: false });

    expect(model.shown?.fields).not.toHaveProperty("meta.change_note");
    expect(model.shown?.meta["meta.change_note"]).toBe("New bank");
    expect(model.shown?.activatedByName).toBe("Alice");
    expect(model.history[0]).toMatchObject({
      versionNo: 2,
      createdBy: "Alice",
      changeNote: "New bank",
      usedByCount: 4,
      activatedAt: new Date("2026-10-05T01:02:03Z"),
      retiredAt: null,
    });
    expect(model.history[1]?.retiredAt).toEqual(
      new Date("2026-10-05T01:02:03Z"),
    );
  });

  it("treats an unparseable meta date as unset", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 1, meta: { "meta.activated_at": "garbage" } }),
    ]);
    const { history } = await getCompanyProfilePageModel(DB, {
      canEdit: true,
    });
    expect(history[0]?.activatedAt).toBeNull();
  });
});
