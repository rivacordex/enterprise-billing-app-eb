import { beforeEach, describe, expect, it, vi } from "vitest";

// bm57-spec §Design D4: which version the Invoice template page opens on.
// An EDIT user with a working DRAFT opens on it (with its token and last
// saver); a READ user never sees the DRAFT on the edit tab, not even via
// `?version=`, though it is still listed in the history. `?version=` names a
// stored version for everyone and the DRAFT only for EDIT users.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-template-version", () => ({
  billTemplateVersionRepository: {
    findActive: vi.fn(),
    findDefault: vi.fn(),
    findById: vi.fn(),
    findDraft: vi.fn(),
    findLatestDraftSaver: vi.fn(),
    listForKind: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {},
}));
vi.mock("@/services/billing/invoice-template/load", () => ({
  loadGeneratedFiles: vi.fn(),
}));

import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { getInvoiceTemplatePageData } from "@/services/billing/read/invoice-template-settings";
import {
  SEEDED_GENERATED_ROW,
  SEEDED_LAYOUT_ROW,
} from "@/tests/helpers/seeded-invoice-template";

const repo = vi.mocked(billTemplateVersionRepository);

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
  repo.findDraft.mockResolvedValue(DRAFT_ROW);
  repo.findLatestDraftSaver.mockResolvedValue("Draft Saver");
  repo.listForKind.mockImplementation(async (_db, { kind }) =>
    kind === "layout"
      ? [{ ...SEEDED_LAYOUT_ROW, usedByCount: 0 }]
      : [
          { ...DRAFT_PLAIN, usedByCount: 0 },
          { ...SEEDED_GENERATED_ROW, usedByCount: 5 },
        ],
  );
});

describe("getInvoiceTemplatePageData: the working draft", () => {
  it("opens an EDIT user on the DRAFT, with its token and last saver", async () => {
    const data = await getInvoiceTemplatePageData(undefined, { canEdit: true });
    expect(data.shown.billTemplateVersionId).toBe("BTV00000004");
    expect(data.defaultShown.billTemplateVersionId).toBe("BTV00000004");
    expect(data.current.billTemplateVersionId).toBe("BTV00000002");
    expect(data.draft).toEqual({
      billTemplateVersionId: "BTV00000004",
      versionNo: 2,
      token: "2026-10-10T01:02:03.123456Z",
      savedAt: new Date("2026-10-10T01:02:03Z"),
      savedBy: "Draft Saver",
    });
  });

  it("lets an EDIT user open the current version with ?version= while keeping the draft token", async () => {
    const data = await getInvoiceTemplatePageData("BTV00000002", {
      canEdit: true,
    });
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
    expect(data.draft?.token).toBe("2026-10-10T01:02:03.123456Z");
  });

  it("never loads or shows the DRAFT for a READ user", async () => {
    const data = await getInvoiceTemplatePageData(undefined, {
      canEdit: false,
    });
    expect(repo.findDraft).not.toHaveBeenCalled();
    expect(data.draft).toBeNull();
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
    expect(data.defaultShown.billTemplateVersionId).toBe("BTV00000002");
  });

  it("ignores ?version=<draft> for a READ user", async () => {
    const data = await getInvoiceTemplatePageData("BTV00000004", {
      canEdit: false,
    });
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
  });

  it("still lists the DRAFT in the history for a READ user", async () => {
    const data = await getInvoiceTemplatePageData(undefined, {
      canEdit: false,
    });
    expect(data.history.map((h) => [h.versionNo, h.status])).toEqual([
      [2, "DRAFT"],
      [1, "ACTIVE"],
    ]);
    expect(data.history[0]?.activatedAt).toBeNull();
  });

  it("opens on the current version when an EDIT user has no draft", async () => {
    repo.findDraft.mockResolvedValue(null);
    const data = await getInvoiceTemplatePageData(undefined, { canEdit: true });
    expect(data.draft).toBeNull();
    expect(data.shown.billTemplateVersionId).toBe("BTV00000002");
    expect(repo.findLatestDraftSaver).not.toHaveBeenCalled();
  });
});
