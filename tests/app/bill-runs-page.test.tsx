import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "@testing-library/react";

// bm02-spec §5/§8 — route × level matrix for /billing/bill-runs, now that the
// page materializes due runs then renders the list. Asserts: the guard runs
// first with billrun_view:READ; materialization runs BEFORE the list read; a
// granted principal renders the list; /no-access and /login redirects
// propagate; force-dynamic; and StubDataBanner shows iff STUB_DATA_MODE.
// Server components can't be pixel-rendered under the App Router runtime in
// vitest, so we render the returned element tree with mocked leaves.

const configState = { stub: false };

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/materialize-runs", () => ({
  materializeDueRuns: vi.fn(),
}));
vi.mock("@/services/billing/read/list-runs", () => ({ listRuns: vi.fn() }));
vi.mock("@/services/accounts/bill-cycle", () => ({
  listActiveBillCycles: vi.fn(() => Promise.resolve([])),
}));
vi.mock("@/services/billing/business-today", () => ({
  getBusinessToday: vi.fn(() => "2026-08-19"),
}));
vi.mock("@/lib/logger", () => ({ reportError: vi.fn() }));
vi.mock("@/lib/config", () => ({
  get stubDataMode() {
    return configState.stub;
  },
}));
vi.mock("@/components/billing/bill-run-list", () => ({
  BillRunList: () => <div data-testid="bill-run-list" />,
}));
vi.mock("@/components/billing/stub-data-banner", () => ({
  StubDataBanner: () => <div data-testid="stub-banner" />,
}));

import BillRunsPage from "@/app/(app)/billing/bill-runs/page";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { reportError } from "@/lib/logger";
import { materializeDueRuns } from "@/services/billing/materialize-runs";
import { listRuns } from "@/services/billing/read/list-runs";

const mockRequirePermission = vi.mocked(requirePermission);
const mockMaterialize = vi.mocked(materializeDueRuns);
const mockListRuns = vi.mocked(listRuns);
const mockReportError = vi.mocked(reportError);

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

function props(search: Record<string, string> = {}) {
  return { searchParams: Promise.resolve(search) };
}

beforeEach(() => {
  vi.clearAllMocks();
  configState.stub = false;
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
  mockMaterialize.mockResolvedValue(undefined);
  mockListRuns.mockResolvedValue({
    tab: "current",
    rows: [],
    total: 0,
    page: 1,
    pageSize: 0,
  });
});

describe("BillRunsPage (bm02 — route × level matrix)", () => {
  it("guards billrun_view:READ before anything else", async () => {
    await BillRunsPage(props());
    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_VIEW,
      LEVELS.READ,
    );
  });

  it("materializes due runs BEFORE reading the list", async () => {
    await BillRunsPage(props());
    expect(mockMaterialize).toHaveBeenCalledTimes(1);
    expect(mockListRuns).toHaveBeenCalledTimes(1);
    expect(mockMaterialize.mock.invocationCallOrder[0]!).toBeLessThan(
      mockListRuns.mock.invocationCallOrder[0]!,
    );
  });

  it("a billrun_view:READ principal renders the run list", async () => {
    const { getByTestId } = render(await BillRunsPage(props()));
    expect(getByTestId("bill-run-list")).toBeTruthy();
  });

  it("still renders the list (degrades) when the lazy materialize write fails", async () => {
    mockMaterialize.mockRejectedValue(new Error("db down"));

    const { getByTestId } = render(await BillRunsPage(props()));

    // The read-only list still renders, and the write failure is logged.
    expect(getByTestId("bill-run-list")).toBeTruthy();
    expect(mockListRuns).toHaveBeenCalledTimes(1);
    expect(mockReportError).toHaveBeenCalledTimes(1);
  });

  it("propagates the /no-access redirect for a user without billrun_view:READ", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));
    await expect(BillRunsPage(props())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("propagates the /login redirect for an unauthenticated request", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/login"));
    await expect(BillRunsPage(props())).rejects.toThrow("NEXT_REDIRECT");
  });

  it("shows StubDataBanner when STUB_DATA_MODE is on", async () => {
    configState.stub = true;
    const { queryByTestId } = render(await BillRunsPage(props()));
    expect(queryByTestId("stub-banner")).not.toBeNull();
  });

  it("hides StubDataBanner when STUB_DATA_MODE is off", async () => {
    configState.stub = false;
    const { queryByTestId } = render(await BillRunsPage(props()));
    expect(queryByTestId("stub-banner")).toBeNull();
  });

  it("declares dynamic = 'force-dynamic' (authenticated, uncached — code-standards §3.6)", () => {
    const src = readFileSync(
      resolve(__dirname, "../../app/(app)/billing/bill-runs/page.tsx"),
      "utf-8",
    );
    expect(src).toMatch(/export const dynamic\s*=\s*["']force-dynamic["']/);
  });
});
