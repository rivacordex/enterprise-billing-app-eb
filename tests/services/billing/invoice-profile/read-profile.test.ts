import { beforeEach, describe, expect, it, vi } from "vitest";

// bm56-spec §Tests — the Company profile page view-model: no profile → the
// empty state; ACTIVE preferred; `?version` honoured; a DRAFT hidden from READ
// users and shown to EDIT users; an incomplete DRAFT still renders (unparsed
// view); `meta.*` split out and surfaced in the history.

vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: {
    listVersions: vi.fn(),
    readVersionRaw: vi.fn(),
    resolveUserNames: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-asset", () => ({
  billAssetRepository: { findVersionById: vi.fn() },
}));
vi.mock("@/services/billing/blob-store", () => ({ blobStore: {} }));

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
    expect(model).toEqual({ shown: null, history: [] });
    expect(repo.readVersionRaw).not.toHaveBeenCalled();
  });

  it("prefers the ACTIVE version over a newer DRAFT", async () => {
    repo.listVersions.mockResolvedValue([
      summary({ configVersion: 3, status: "DRAFT" }),
      summary({ configVersion: 2, status: "ACTIVE" }),
      summary({ configVersion: 1, status: "RETIRED" }),
    ]);
    const { shown } = await getCompanyProfilePageModel(DB, { canEdit: true });
    expect(shown?.version).toBe(2);
    expect(shown?.status).toBe("ACTIVE");
    expect(shown?.logoAssetVersionId).toBe("INVASV00000001");
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
    expect(repo.readVersionRaw).toHaveBeenCalledTimes(1);
    expect(repo.readVersionRaw).toHaveBeenCalledWith(DB, 1);
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
    expect(model).toEqual({ shown: null, history: [] });
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
