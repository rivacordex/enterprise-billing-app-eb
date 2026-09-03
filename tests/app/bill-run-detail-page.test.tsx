import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm04-spec §Implementation §9/§10 — route × level matrix for
// `/billing/bill-runs/[runId]`: guard runs first with billrun_view:READ; an
// invalid or unknown run resolves to `notFound()`; a granted principal
// renders the tabs; /no-access and /login redirects propagate; force-dynamic.

const configState = { placeholder: false };

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/get-run-detail", () => ({
  getRunDetail: vi.fn(),
}));
vi.mock("@/services/billing/read/get-stage-timeline", () => ({
  getStageTimeline: vi.fn(),
}));
vi.mock("@/services/billing/read/list-account-bills", () => ({
  listAccountBills: vi.fn(),
}));
vi.mock("@/services/billing/read/list-uncharged", () => ({
  listUncharged: vi.fn(),
}));
vi.mock("@/services/billing/read/list-errors", () => ({
  listErrors: vi.fn(),
}));
vi.mock("@/services/billing/read/list-run-audit", () => ({
  listRunAudit: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn(),
  getAppTimezone: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  get isBillrunPlaceholderMode() {
    return configState.placeholder;
  },
  billRunStallThresholdMinutes: 30,
}));
vi.mock("@/components/billing/run-detail-tabs", () => ({
  RunDetailTabs: () => <div data-testid="run-detail-tabs" />,
}));
// bm08 — the header's run-level RerunDialog is a client island whose action
// pulls the db/service graph; stub it so this page test stays framework-only.
vi.mock("@/components/billing/rerun-dialog", () => ({
  RerunDialog: () => <div data-testid="rerun-dialog" />,
}));
vi.mock("@/components/billing/placeholder-banner", () => ({
  PlaceholderBanner: () => <div data-testid="placeholder-banner" />,
}));
// bm12 — the StallBanner is a client island whose action pulls the db/service
// graph; stub it so this page test stays framework-only, same convention as
// RerunDialog/PlaceholderBanner above.
vi.mock("@/components/billing/stall-banner", () => ({
  StallBanner: () => <div data-testid="stall-banner" />,
}));
// bm12 — the CANCELLED re-trigger ("Run") affordance is a client island whose
// action pulls the db/service graph; stub it so this page test stays
// framework-only, same convention as RerunDialog/StallBanner above.
vi.mock("@/components/billing/trigger-run-dialog", () => ({
  TriggerRunDialog: () => <div data-testid="trigger-run-dialog" />,
}));

import BillRunDetailPage from "@/app/(app)/billing/bill-runs/[runId]/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { getRunDetail } from "@/services/billing/read/get-run-detail";
import { getStageTimeline } from "@/services/billing/read/get-stage-timeline";
import { listAccountBills } from "@/services/billing/read/list-account-bills";
import { listUncharged } from "@/services/billing/read/list-uncharged";
import { listErrors } from "@/services/billing/read/list-errors";
import { listRunAudit } from "@/services/billing/read/list-run-audit";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetRunDetail = vi.mocked(getRunDetail);
const mockGetStageTimeline = vi.mocked(getStageTimeline);
const mockListAccountBills = vi.mocked(listAccountBills);
const mockListUncharged = vi.mocked(listUncharged);
const mockListErrors = vi.mocked(listErrors);
const mockListRunAudit = vi.mocked(listRunAudit);
const mockGetAppLocale = vi.mocked(getAppLocale);
const mockGetAppTimezone = vi.mocked(getAppTimezone);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function props(runId = "BRN00000001", search: Record<string, string> = {}) {
  return {
    params: Promise.resolve({ runId }),
    searchParams: Promise.resolve(search),
  };
}

const DETAIL = {
  billRunId: "BRN00000001",
  cycleName: "Enterprise Monthly",
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  scheduledRunDate: "2026-08-01",
  status: "PROCESSING" as const,
  lastProgressAt: null as Date | null,
};

beforeEach(() => {
  vi.clearAllMocks();
  configState.placeholder = false;
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
  mockGetRunDetail.mockResolvedValue(DETAIL);
  mockGetStageTimeline.mockResolvedValue({
    rows: [],
    summary: { total: 0, processed: 0, processingFailed: 0, excluded: 0 },
  });
  mockListAccountBills.mockResolvedValue([]);
  mockListUncharged.mockResolvedValue([]);
  mockListErrors.mockResolvedValue([]);
  mockListRunAudit.mockResolvedValue([]);
  mockGetAppLocale.mockResolvedValue("en-MY");
  mockGetAppTimezone.mockReturnValue("UTC");
});

describe("BillRunDetailPage (bm04-spec §9/§10)", () => {
  it("guards billrun_view:READ before anything else", async () => {
    await BillRunDetailPage(props());
    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_VIEW,
      LEVELS.READ,
    );
  });

  it("renders the tabs for a billrun_view:READ principal on a known run", async () => {
    const { getByTestId } = render(await BillRunDetailPage(props()));
    expect(getByTestId("run-detail-tabs")).toBeTruthy();
  });

  it("resolves to notFound() for a malformed runId", async () => {
    await expect(
      BillRunDetailPage(props("not-a-run-id")),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(mockGetRunDetail).not.toHaveBeenCalled();
  });

  it("resolves to notFound() for an unknown (but well-formed) runId", async () => {
    mockGetRunDetail.mockResolvedValue(null);

    await expect(BillRunDetailPage(props("BRN99999999"))).rejects.toMatchObject(
      { digest: "NEXT_HTTP_ERROR_FALLBACK;404" },
    );
  });

  it("propagates the /no-access redirect for a user without billrun_view:READ", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));
    await expect(BillRunDetailPage(props())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("propagates the /login redirect for an unauthenticated request", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));
    await expect(BillRunDetailPage(props())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("only reads the stage timeline for the workflow tab", async () => {
    await BillRunDetailPage(props("BRN00000001", { tab: "customers" }));
    expect(mockGetStageTimeline).not.toHaveBeenCalled();
  });

  it("only reads the account bills for the customers tab", async () => {
    await BillRunDetailPage(props());
    expect(mockListAccountBills).not.toHaveBeenCalled();

    await BillRunDetailPage(props("BRN00000001", { tab: "customers" }));
    expect(mockListAccountBills).toHaveBeenCalledWith("BRN00000001");
  });

  it("only reads uncharged accounts for the uncharged tab (bm07)", async () => {
    await BillRunDetailPage(props());
    expect(mockListUncharged).not.toHaveBeenCalled();

    await BillRunDetailPage(props("BRN00000001", { tab: "uncharged" }));
    expect(mockListUncharged).toHaveBeenCalledWith("BRN00000001");
  });

  it("only reads errors for the errors tab (bm07)", async () => {
    await BillRunDetailPage(props());
    expect(mockListErrors).not.toHaveBeenCalled();

    await BillRunDetailPage(props("BRN00000001", { tab: "errors" }));
    expect(mockListErrors).toHaveBeenCalledWith("BRN00000001");
  });

  it("only reads the run audit trail for the audit tab (bm07)", async () => {
    await BillRunDetailPage(props());
    expect(mockListRunAudit).not.toHaveBeenCalled();

    await BillRunDetailPage(props("BRN00000001", { tab: "audit" }));
    expect(mockListRunAudit).toHaveBeenCalledWith("BRN00000001");
  });

  it("shows PlaceholderBanner when BILLRUN_PLACEHOLDER_MODE is on", async () => {
    configState.placeholder = true;
    const { queryByTestId } = render(await BillRunDetailPage(props()));
    expect(queryByTestId("placeholder-banner")).not.toBeNull();
  });

  it("hides PlaceholderBanner when BILLRUN_PLACEHOLDER_MODE is off", async () => {
    const { queryByTestId } = render(await BillRunDetailPage(props()));
    expect(queryByTestId("placeholder-banner")).toBeNull();
  });

  it("shows the StallBanner for a billrun_operate:EDIT principal on a stalled PROCESSING run (bm12)", async () => {
    mockGetRunDetail.mockResolvedValue({
      ...DETAIL,
      status: "PROCESSING",
      lastProgressAt: new Date(Date.now() - 60 * 60_000), // 60 min ago > 30 min default
    });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_operate: "EDIT" } as never,
    });

    const { queryByTestId } = render(await BillRunDetailPage(props()));

    expect(queryByTestId("stall-banner")).not.toBeNull();
  });

  it("hides the StallBanner without billrun_operate:EDIT even on a stalled run (bm12)", async () => {
    mockGetRunDetail.mockResolvedValue({
      ...DETAIL,
      status: "PROCESSING",
      lastProgressAt: new Date(Date.now() - 60 * 60_000),
    });

    const { queryByTestId } = render(await BillRunDetailPage(props()));

    expect(queryByTestId("stall-banner")).toBeNull();
  });

  it("hides the StallBanner for a billrun_operate:EDIT principal on a run that isn't stalled (bm12)", async () => {
    mockGetRunDetail.mockResolvedValue({
      ...DETAIL,
      status: "PROCESSING",
      lastProgressAt: new Date(), // fresh heartbeat
    });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_operate: "EDIT" } as never,
    });

    const { queryByTestId } = render(await BillRunDetailPage(props()));

    expect(queryByTestId("stall-banner")).toBeNull();
  });

  it("shows the re-trigger (Run) control for a billrun_operate:EDIT principal on a CANCELLED run (bm12)", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "CANCELLED" });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_operate: "EDIT" } as never,
    });

    const { queryByTestId } = render(await BillRunDetailPage(props()));

    expect(queryByTestId("trigger-run-dialog")).not.toBeNull();
  });

  it("hides the re-trigger control without billrun_operate:EDIT even on a CANCELLED run (bm12)", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "CANCELLED" });

    const { queryByTestId } = render(await BillRunDetailPage(props()));

    expect(queryByTestId("trigger-run-dialog")).toBeNull();
  });

  it("hides the re-trigger control for a billrun_operate:EDIT principal when the run isn't CANCELLED (bm12)", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "PROCESSING" });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_operate: "EDIT" } as never,
    });

    const { queryByTestId } = render(await BillRunDetailPage(props()));

    expect(queryByTestId("trigger-run-dialog")).toBeNull();
  });

  it("shows the Approve & Post link for a billrun_approve:EDIT principal on a PROCESSED run", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "PROCESSED" });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_approve: "EDIT" } as never,
    });

    const { getByRole } = render(await BillRunDetailPage(props()));

    expect(
      getByRole("link", { name: /approve & post/i }).getAttribute("href"),
    ).toBe("/billing/bill-runs/BRN00000001/approve");
  });

  it("hides the Approve & Post link without billrun_approve:EDIT even on a PROCESSED run", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "PROCESSED" });

    const { queryByRole } = render(await BillRunDetailPage(props()));

    expect(queryByRole("link", { name: /approve & post/i })).toBeNull();
  });

  it("hides the Approve & Post link for a billrun_approve:EDIT principal when the run isn't PROCESSED", async () => {
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_approve: "EDIT" } as never,
    });

    const { queryByRole } = render(await BillRunDetailPage(props()));

    expect(queryByRole("link", { name: /approve & post/i })).toBeNull();
  });

  it("shows a Post link (billrun_approve:EDIT) once the run is APPROVED, sharing the /approve route", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "APPROVED" });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_approve: "EDIT" } as never,
    });

    const { getByRole, queryByRole } = render(await BillRunDetailPage(props()));

    expect(getByRole("link", { name: "Post" }).getAttribute("href")).toBe(
      "/billing/bill-runs/BRN00000001/approve",
    );
    expect(queryByRole("link", { name: /approve & post/i })).toBeNull();
  });

  it("shows a Resume posting link (billrun_approve:EDIT) while the run is POSTING", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "POSTING" });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_approve: "EDIT" } as never,
    });

    const { getByRole } = render(await BillRunDetailPage(props()));

    expect(
      getByRole("link", { name: "Resume posting" }).getAttribute("href"),
    ).toBe("/billing/bill-runs/BRN00000001/approve");
  });

  it("hides the Post link without billrun_approve:EDIT even once APPROVED", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "APPROVED" });

    const { queryByRole } = render(await BillRunDetailPage(props()));

    expect(queryByRole("link", { name: "Post" })).toBeNull();
  });

  it("hides the Post/Resume posting link once the run is INVOICED", async () => {
    mockGetRunDetail.mockResolvedValue({ ...DETAIL, status: "INVOICED" });
    mockRequirePermission.mockResolvedValue({
      userId: "user-1",
      userEmail: "user@example.com",
      permissionMap: { billrun_approve: "EDIT" } as never,
    });

    const { queryByRole } = render(await BillRunDetailPage(props()));

    expect(queryByRole("link", { name: "Post" })).toBeNull();
    expect(queryByRole("link", { name: "Resume posting" })).toBeNull();
  });

  it("declares dynamic = 'force-dynamic' (authenticated, uncached)", () => {
    const src = readFileSync(
      resolve(__dirname, "../../app/(app)/billing/bill-runs/[runId]/page.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });
});
