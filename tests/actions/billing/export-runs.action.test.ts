import { beforeEach, describe, expect, it, vi } from "vitest";

// bm02-spec §7/§8. The CSV export Server Action: re-checks `billrun_view:READ`,
// builds a header + one line per filtered row, and returns FORBIDDEN when the
// guard redirects. The read service is mocked (its SQL is covered elsewhere).

vi.mock("@/auth/guard", () => ({ requirePermission: vi.fn() }));
vi.mock("@/services/billing/read/list-runs", () => ({ listRuns: vi.fn() }));

import { exportRunsAction } from "@/actions/billing/export-runs.action";
import { requirePermission } from "@/auth/guard";
import { LEVELS, PERMISSIONS } from "@/auth/permission-constants";
import { listRuns } from "@/services/billing/read/list-runs";
import type { RunListRow } from "@/types/billing";

const mockRequirePermission = vi.mocked(requirePermission);
const mockListRuns = vi.mocked(listRuns);

function row(overrides: Partial<RunListRow> = {}): RunListRow {
  return {
    billRunId: "BRN00000001",
    cycleId: "BCY00000001",
    cycleName: "Enterprise Monthly",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: "2026-08-01",
    status: "COMPLETED",
    runType: "onCycle",
    operable: false,
    pastDue: true,
    ...overrides,
  };
}

function redirectError(target: string): Error & { digest: string } {
  const error = new Error("NEXT_REDIRECT") as Error & { digest: string };
  error.digest = `NEXT_REDIRECT;replace;${target};307;`;
  return error;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockRequirePermission.mockResolvedValue({
    userId: "user-1",
    userEmail: "user@example.com",
    permissionMap: {} as never,
  });
});

describe("exportRunsAction (bm02-spec §7)", () => {
  it("re-checks billrun_view:READ", async () => {
    mockListRuns.mockResolvedValue({
      tab: "historical",
      rows: [],
      total: 0,
      page: 1,
      pageSize: 0,
    });

    await exportRunsAction({ tab: "historical", cycle: null, status: null });

    expect(mockRequirePermission).toHaveBeenCalledWith(
      PERMISSIONS.BILLRUN_VIEW,
      LEVELS.READ,
    );
  });

  it("returns a CSV with a header and one line per filtered row", async () => {
    mockListRuns.mockResolvedValue({
      tab: "historical",
      rows: [row(), row({ billRunId: "BRN00000002", status: "CANCELLED" })],
      total: 2,
      page: 1,
      pageSize: 2,
    });

    const result = await exportRunsAction({
      tab: "historical",
      cycle: null,
      status: null,
    });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const lines = result.csv.trim().split("\r\n");
    expect(lines[0]).toBe(
      "Run ID,Cycle,Period Start,Period End,Scheduled Run Date,Status,Run Type",
    );
    expect(lines).toHaveLength(3); // header + 2 rows
    expect(lines[1]).toContain("BRN00000001");
    expect(lines[1]).toContain("Enterprise Monthly");
    expect(lines[1]).toContain("COMPLETED");
    expect(lines[2]).toContain("BRN00000002");
    expect(result.filename).toBe("bill-runs-historical.csv");
  });

  it("fetches the full filtered set without pagination", async () => {
    mockListRuns.mockResolvedValue({
      tab: "historical",
      rows: [],
      total: 0,
      page: 1,
      pageSize: 0,
    });

    await exportRunsAction({
      tab: "historical",
      cycle: "BCY00000001",
      status: "COMPLETED",
    });

    expect(mockListRuns).toHaveBeenCalledWith(
      expect.objectContaining({ cycleId: "BCY00000001", status: "COMPLETED" }),
      { paginate: false },
    );
  });

  it("quotes a field containing a comma (RFC-4180 escaping)", async () => {
    mockListRuns.mockResolvedValue({
      tab: "historical",
      rows: [row({ cycleName: "Enterprise, Monthly" })],
      total: 1,
      page: 1,
      pageSize: 1,
    });

    const result = await exportRunsAction({
      tab: "historical",
      cycle: null,
      status: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.csv).toContain('"Enterprise, Monthly"');
  });

  it("neutralizes CSV/formula injection in a field (leading = prefixed)", async () => {
    mockListRuns.mockResolvedValue({
      tab: "historical",
      rows: [row({ cycleName: "=HYPERLINK(evil)" })],
      total: 1,
      page: 1,
      pageSize: 1,
    });

    const result = await exportRunsAction({
      tab: "historical",
      cycle: null,
      status: null,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Formula-trigger prefixed with a single quote so a spreadsheet treats it
    // as text, not a formula.
    expect(result.csv).toContain("'=HYPERLINK(evil)");
    expect(result.csv).not.toMatch(/,=HYPERLINK/);
  });

  it("returns FORBIDDEN when the guard redirects (no grant)", async () => {
    mockRequirePermission.mockRejectedValue(redirectError("/no-access"));

    const result = await exportRunsAction({
      tab: "historical",
      cycle: null,
      status: null,
    });

    expect(result).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(mockListRuns).not.toHaveBeenCalled();
  });
});
