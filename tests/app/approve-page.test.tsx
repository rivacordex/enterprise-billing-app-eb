import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm10-spec §Implementation §3 — route × level matrix for
// `/billing/bill-runs/[runId]/approve`: guard runs first with
// billrun_approve:EDIT (a billrun_operate-only principal is redirected, not
// merely hidden); an invalid or unknown run resolves to `notFound()`;
// force-dynamic.

const configState = { stub: false };

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/get-approve-preview", () => ({
  getApprovePreview: vi.fn(),
}));
vi.mock("@/services/billing/read/get-posting-progress", () => ({
  getPostingProgress: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppLocale: vi.fn(),
  getAppTimezone: vi.fn(),
}));
vi.mock("@/lib/config", () => ({
  get stubDataMode() {
    return configState.stub;
  },
}));
vi.mock("@/components/billing/approve-and-post-panel", () => ({
  ApproveAndPostPanel: () => <div data-testid="approve-panel" />,
}));
vi.mock("@/components/billing/posting-progress-view", () => ({
  PostingProgressView: () => <div data-testid="posting-progress-view" />,
}));
vi.mock("@/components/billing/stub-data-banner", () => ({
  StubDataBanner: () => <div data-testid="stub-banner" />,
}));

import ApproveAndPostPage from "@/app/(app)/billing/bill-runs/[runId]/approve/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { getApprovePreview } from "@/services/billing/read/get-approve-preview";
import { getPostingProgress } from "@/services/billing/read/get-posting-progress";
import {
  getAppLocale,
  getAppTimezone,
} from "@/services/system-config/app-config-read.service";

const mockRequirePermission = vi.mocked(requirePermission);
const mockGetApprovePreview = vi.mocked(getApprovePreview);
const mockGetPostingProgress = vi.mocked(getPostingProgress);
const mockGetAppLocale = vi.mocked(getAppLocale);
const mockGetAppTimezone = vi.mocked(getAppTimezone);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function props(runId = "BRN00000001") {
  return { params: Promise.resolve({ runId }) };
}

const PREVIEW = {
  billRunId: "BRN00000001",
  cycleName: "Enterprise Monthly",
  status: "PROCESSED" as const,
  periodStart: "2026-07-01",
  periodEnd: "2026-07-31",
  triggeredByName: "alice",
  triggeredAt: new Date("2026-08-01T10:00:00Z"),
  postableCount: 2,
  skippedCount: 0,
  currency: "MYR",
  totalAmount: "315.00",
  checks: [
    { check: "period_open" as const, pass: true, remediation: null },
    { check: "gl_mappings" as const, pass: true, remediation: null },
    { check: "positive_totals" as const, pass: true, remediation: null },
    { check: "four_eyes" as const, pass: true, remediation: null },
    { check: "accounts_terminal" as const, pass: true, remediation: null },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  configState.stub = false;
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
  mockGetApprovePreview.mockResolvedValue(PREVIEW);
  mockGetPostingProgress.mockResolvedValue({
    billRunId: "BRN00000001",
    runStatus: "APPROVED",
    rows: [],
    postedCount: 0,
    totalCount: 0,
  });
  mockGetAppLocale.mockResolvedValue("en-MY");
  mockGetAppTimezone.mockReturnValue("UTC");
});

describe("ApproveAndPostPage (bm10-spec §Implementation §3)", () => {
  it("guards billrun_approve:EDIT before anything else", async () => {
    await ApproveAndPostPage(props());
    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_APPROVE,
      LEVELS.EDIT,
    );
  });

  it("renders the panel for a billrun_approve:EDIT principal on a known run", async () => {
    const { getByTestId } = render(await ApproveAndPostPage(props()));
    expect(getByTestId("approve-panel")).toBeTruthy();
  });

  it("resolves to notFound() for a malformed runId", async () => {
    await expect(
      ApproveAndPostPage(props("not-a-run-id")),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
    expect(mockGetApprovePreview).not.toHaveBeenCalled();
  });

  it("resolves to notFound() for an unknown (but well-formed) runId", async () => {
    mockGetApprovePreview.mockResolvedValue(null);

    await expect(
      ApproveAndPostPage(props("BRN99999999")),
    ).rejects.toMatchObject({ digest: "NEXT_HTTP_ERROR_FALLBACK;404" });
  });

  it("propagates the /no-access redirect for a billrun_operate-only principal", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));
    await expect(ApproveAndPostPage(props())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("propagates the /login redirect for an unauthenticated request", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));
    await expect(ApproveAndPostPage(props())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("shows StubDataBanner when STUB_DATA_MODE is on", async () => {
    configState.stub = true;
    const { queryByTestId } = render(await ApproveAndPostPage(props()));
    expect(queryByTestId("stub-banner")).not.toBeNull();
  });

  it("hides StubDataBanner when STUB_DATA_MODE is off", async () => {
    const { queryByTestId } = render(await ApproveAndPostPage(props()));
    expect(queryByTestId("stub-banner")).toBeNull();
  });

  it("renders PostingProgressView (not the approve panel) once the run is APPROVED", async () => {
    mockGetApprovePreview.mockResolvedValue({ ...PREVIEW, status: "APPROVED" });

    const { getByTestId, queryByTestId } = render(
      await ApproveAndPostPage(props()),
    );

    expect(getByTestId("posting-progress-view")).toBeTruthy();
    expect(queryByTestId("approve-panel")).toBeNull();
    expect(mockGetPostingProgress).toHaveBeenCalledWith("BRN00000001");
  });

  it("resolves to notFound() when posting progress can't be read for a non-PROCESSED run", async () => {
    mockGetApprovePreview.mockResolvedValue({ ...PREVIEW, status: "APPROVED" });
    mockGetPostingProgress.mockResolvedValue(null);

    await expect(ApproveAndPostPage(props())).rejects.toMatchObject({
      digest: "NEXT_HTTP_ERROR_FALLBACK;404",
    });
  });

  it("declares dynamic = 'force-dynamic' (authenticated, uncached)", () => {
    const src = readFileSync(
      resolve(
        __dirname,
        "../../app/(app)/billing/bill-runs/[runId]/approve/page.tsx",
      ),
      "utf-8",
    );
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });
});
