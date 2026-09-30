import { beforeEach, describe, expect, it, vi } from "vitest";

// Guard-level test (product-offering/orders-page precedent) — asserts
// requirePermission is invoked with ratecard:READ, that its redirect
// propagates, that the query budget holds (one versions read on first render;
// one paged rows read only on a valid selection), and that the page threads
// props into its children — not that it renders pixels.
vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/product/ratecard/list-versions", () => ({
  listRateCardVersions: vi.fn(),
}));
vi.mock("@/services/product/ratecard/get-version-rows", () => ({
  getRateCardVersionRows: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppName: vi.fn().mockResolvedValue("Acme Telco"),
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
}));
vi.mock("@/components/products/rate-card/rate-card-version-table", () => ({
  RateCardVersionTable: vi.fn(() => null),
}));
vi.mock("@/components/products/rate-card/rate-card-row-preview", () => ({
  RateCardRowPreview: vi.fn(() => null),
}));
// pm66 additions — the diff read + write-UI leaves are mocked so the page test
// stays a guard/props test (no DB, no client dialogs rendered).
vi.mock("@/services/product/ratecard/get-version-diff", () => ({
  getRateCardVersionDiff: vi.fn(),
}));
vi.mock("@/components/products/rate-card/rate-card-diff-panel", () => ({
  RateCardDiffPanel: vi.fn(() => null),
}));
vi.mock("@/components/products/rate-card/upload-version-dialog", () => ({
  UploadVersionDialog: vi.fn(() => null),
}));
vi.mock("@/components/products/rate-card/activate-version-dialog", () => ({
  ActivateVersionDialog: vi.fn(() => null),
}));
vi.mock("@/components/products/rate-card/rollback-version-dialog", () => ({
  RollbackVersionDialog: vi.fn(() => null),
}));

import RateCardPage from "@/app/(app)/products/rate-card/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { ActivateVersionDialog } from "@/components/products/rate-card/activate-version-dialog";
import { RateCardDiffPanel } from "@/components/products/rate-card/rate-card-diff-panel";
import { RateCardRowPreview } from "@/components/products/rate-card/rate-card-row-preview";
import { RateCardVersionTable } from "@/components/products/rate-card/rate-card-version-table";
import { RollbackVersionDialog } from "@/components/products/rate-card/rollback-version-dialog";
import { UploadVersionDialog } from "@/components/products/rate-card/upload-version-dialog";
import type { RatecardVersion } from "@/db/schema/product";
import { getRateCardVersionDiff } from "@/services/product/ratecard/get-version-diff";
import { getRateCardVersionRows } from "@/services/product/ratecard/get-version-rows";
import { listRateCardVersions } from "@/services/product/ratecard/list-versions";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListVersions = vi.mocked(listRateCardVersions);
const mockGetRows = vi.mocked(getRateCardVersionRows);
const mockDiff = vi.mocked(getRateCardVersionDiff);

const EMPTY_DIFF = {
  added: { count: 0, rows: [] },
  changed: { count: 0, rows: [] },
  removed: { count: 0, rows: [] },
};

function permissionMap(level: "READ" | "EDIT") {
  return {
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: {
      users: null,
      roles: null,
      system_config: null,
      audit_log: null,
      products: null,
      customers: null,
      ratecard: level,
    },
  };
}

interface ReactElementLike {
  type: unknown;
  props: { children?: unknown };
}
function isReactElementLike(node: unknown): node is ReactElementLike {
  return (
    node !== null &&
    typeof node === "object" &&
    "type" in node &&
    "props" in node
  );
}
function findElementByType(
  node: unknown,
  type: unknown,
): ReactElementLike | undefined {
  if (!isReactElementLike(node)) return undefined;
  if (node.type === type) return node;
  const children = node.props.children;
  for (const child of Array.isArray(children) ? children : [children]) {
    const found = findElementByType(child, type);
    if (found) return found;
  }
  return undefined;
}

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function makeVersion(
  overrides: Partial<RatecardVersion> = {},
): RatecardVersion {
  return {
    ratecardVersionId: "RCV00000001",
    cardName: "RAN_USAGE",
    versionNum: 1,
    status: "ACTIVE",
    snapshotDate: "2026-09-30",
    sourceFile: "ran-usage.csv",
    fileChecksum: "a91f3c02",
    rowCount: 5400,
    uploadedBy: "user-1",
    uploadedAt: new Date("2026-09-30T02:00:00.000Z"),
    activatedBy: "user-2",
    activatedAt: new Date("2026-09-30T03:00:00.000Z"),
    supersededByVersionId: null,
    rejectSummary: null,
    ...overrides,
  };
}

beforeEach(() => {
  mockRequirePermission.mockReset();
  mockListVersions.mockReset();
  mockGetRows.mockReset();
  mockDiff.mockReset();
  vi.mocked(RateCardVersionTable).mockClear();
  vi.mocked(RateCardRowPreview).mockClear();
  vi.mocked(RateCardDiffPanel).mockClear();
  vi.mocked(UploadVersionDialog).mockClear();
  vi.mocked(ActivateVersionDialog).mockClear();
  vi.mocked(RollbackVersionDialog).mockClear();

  mockListVersions.mockResolvedValue([]);
  mockGetRows.mockResolvedValue({ rows: [], total: 0, page: 1, pageSize: 50 });
  mockDiff.mockResolvedValue(EMPTY_DIFF);
  mockRequirePermission.mockResolvedValue(permissionMap("EDIT"));
});

describe("RateCardPage", () => {
  it("calls requirePermission(PERMISSIONS.RATECARD, LEVELS.READ) as the first statement", async () => {
    await RateCardPage({ searchParams: Promise.resolve({}) });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.RATECARD,
      LEVELS.READ,
    );
    expect(mockListVersions).toHaveBeenCalled();
  });

  it("propagates the /no-access redirect for a denied user and never reads versions (test 3)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    await expect(
      RateCardPage({ searchParams: Promise.resolve({}) }),
    ).rejects.toThrow();
    expect(mockListVersions).not.toHaveBeenCalled();
    expect(mockGetRows).not.toHaveBeenCalled();
  });

  it("query budget — first render reads versions once and reads NO rows (test 6)", async () => {
    mockListVersions.mockResolvedValue([makeVersion()]);

    await RateCardPage({ searchParams: Promise.resolve({}) });

    expect(mockListVersions).toHaveBeenCalledTimes(1);
    expect(mockGetRows).not.toHaveBeenCalled();
  });

  it("query budget — selecting a valid version reads its rows exactly once (test 6)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001" }),
    ]);

    await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001", page: "2" }),
    });

    expect(mockListVersions).toHaveBeenCalledTimes(1);
    expect(mockGetRows).toHaveBeenCalledTimes(1);
    expect(mockGetRows).toHaveBeenCalledWith("RCV00000001", {
      page: 2,
      filter: "",
    });
  });

  it("a well-formed version that matches no row renders the empty-selection state — no preview, no rows read (test 4)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001" }),
    ]);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00009999" }),
    });

    expect(mockGetRows).not.toHaveBeenCalled();
    expect(findElementByType(result, RateCardRowPreview)).toBeUndefined();
    // Still renders the version table (the list is always shown).
    expect(findElementByType(result, RateCardVersionTable)).toBeDefined();
  });

  it("threads locale/timezone and the loaded versions into the version table", async () => {
    const versions = [makeVersion()];
    mockListVersions.mockResolvedValue(versions);

    const result = await RateCardPage({ searchParams: Promise.resolve({}) });

    const table = findElementByType(result, RateCardVersionTable);
    expect(table?.props).toMatchObject({
      versions,
      selectedVersionId: null,
      locale: "en-US",
      timezone: "UTC",
    });
  });

  it("renders the row preview with the fetched page and filter for a valid selection", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001" }),
    ]);
    const rowsPage = { rows: [], total: 0, page: 1, pageSize: 50 };
    mockGetRows.mockResolvedValue(rowsPage);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001", q: "MNO-1" }),
    });

    const preview = findElementByType(result, RateCardRowPreview);
    expect(preview?.props).toMatchObject({
      versionId: "RCV00000001",
      total: 0,
      page: 1,
      pageSize: 50,
      query: "MNO-1",
    });
  });

  it("an unknown tab is parsed to rows and still renders the row preview (test 5, page level)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001" }),
    ]);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001", tab: "bogus" }),
    });

    // A bogus tab does not 404 and does not suppress the rows view.
    expect(findElementByType(result, RateCardRowPreview)).toBeDefined();
  });

  // --- pm66 write-UI wiring --------------------------------------------------

  it("an EDIT user sees the Upload control (D11)", async () => {
    mockRequirePermission.mockResolvedValue(permissionMap("EDIT"));
    const result = await RateCardPage({ searchParams: Promise.resolve({}) });
    expect(findElementByType(result, UploadVersionDialog)).toBeDefined();
  });

  it("a READ-only user sees NO upload/activate/rollback control (test 11, absent not disabled)", async () => {
    mockRequirePermission.mockResolvedValue(permissionMap("READ"));
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001", status: "DRAFT" }),
    ]);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001" }),
    });

    expect(findElementByType(result, UploadVersionDialog)).toBeUndefined();
    expect(findElementByType(result, ActivateVersionDialog)).toBeUndefined();
    expect(findElementByType(result, RollbackVersionDialog)).toBeUndefined();
  });

  it("selecting a DRAFT computes the diff and renders ActivateVersionDialog with the superseded id + counts (D6)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000002", status: "ACTIVE" }),
      makeVersion({ ratecardVersionId: "RCV00000001", status: "DRAFT" }),
    ]);
    mockDiff.mockResolvedValue({
      added: { count: 3, rows: [] },
      changed: { count: 2, rows: [] },
      removed: { count: 1, rows: [] },
    });

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001" }),
    });

    expect(mockDiff).toHaveBeenCalledTimes(1);
    const dialog = findElementByType(result, ActivateVersionDialog);
    expect(dialog?.props).toMatchObject({
      versionId: "RCV00000001",
      supersededVersionId: "RCV00000002",
      counts: { added: 3, changed: 2, removed: 1 },
    });
    expect(findElementByType(result, RollbackVersionDialog)).toBeUndefined();
  });

  it("a SUPERSEDED version renders RollbackVersionDialog, not Activate (D7)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000002", status: "ACTIVE" }),
      makeVersion({ ratecardVersionId: "RCV00000001", status: "SUPERSEDED" }),
    ]);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001" }),
    });

    expect(
      findElementByType(result, RollbackVersionDialog)?.props,
    ).toMatchObject({
      versionId: "RCV00000001",
      demotedVersionId: "RCV00000002",
    });
    expect(findElementByType(result, ActivateVersionDialog)).toBeUndefined();
  });

  it("an ACTIVE version shows NO mutating control (test 12)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001", status: "ACTIVE" }),
    ]);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001" }),
    });

    expect(findElementByType(result, ActivateVersionDialog)).toBeUndefined();
    expect(findElementByType(result, RollbackVersionDialog)).toBeUndefined();
  });

  it("query budget — an ACTIVE version on the rows tab costs NO diff read", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001", status: "ACTIVE" }),
    ]);

    await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001" }),
    });

    expect(mockDiff).not.toHaveBeenCalled();
    expect(mockGetRows).toHaveBeenCalledTimes(1);
  });

  it("tab=diff renders the diff panel and reads the diff exactly once (test 6, diff clause)", async () => {
    mockListVersions.mockResolvedValue([
      makeVersion({ ratecardVersionId: "RCV00000001", status: "ACTIVE" }),
    ]);

    const result = await RateCardPage({
      searchParams: Promise.resolve({ version: "RCV00000001", tab: "diff" }),
    });

    expect(mockDiff).toHaveBeenCalledTimes(1);
    expect(mockGetRows).not.toHaveBeenCalled();
    expect(findElementByType(result, RateCardDiffPanel)).toBeDefined();
    expect(findElementByType(result, RateCardRowPreview)).toBeUndefined();
  });
});
