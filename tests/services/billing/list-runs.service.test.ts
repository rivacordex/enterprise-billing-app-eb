import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm02-spec §4/§8. The read model: operability resolution (one operable run
// per cycle — oldest past-due `< APPROVED`; `*_FAILED` stays operable;
// upcoming disabled), `pastDue`, tab handling, tab-scoped status filtering,
// pagination + out-of-range page clamping, and count only when paginating.
// The repository is mocked (its SQL is exercised by the integration suite).

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { listRuns: vi.fn(), countRuns: vi.fn() },
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn(() => "UTC"),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { listRuns } from "@/services/billing/read/list-runs";

const mockListRuns = vi.mocked(billRunRepository.listRuns);
const mockCountRuns = vi.mocked(billRunRepository.countRuns);

interface RepoRowInput {
  billRunId: string;
  refBillCycleId: string;
  cycleName: string;
  scheduledRunDate: string;
  status: string;
}

function repoRow(input: RepoRowInput) {
  return {
    billRunId: input.billRunId,
    refBillCycleId: input.refBillCycleId,
    cycleName: input.cycleName,
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: input.scheduledRunDate,
    status: input.status,
    runType: "onCycle",
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(new Date("2026-08-19T09:00:00Z")); // today = 2026-08-19 UTC
  mockCountRuns.mockResolvedValue(0);
  mockListRuns.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("listRuns operability (bm02-spec §Operability)", () => {
  it("marks the oldest past-due, sub-APPROVED run per cycle operable; upcoming disabled", async () => {
    mockListRuns.mockResolvedValue([
      repoRow({
        billRunId: "BRN00000001",
        refBillCycleId: "A",
        cycleName: "Cycle A",
        scheduledRunDate: "2026-08-15",
        status: "SCHEDULED",
      }),
      repoRow({
        billRunId: "BRN00000002",
        refBillCycleId: "A",
        cycleName: "Cycle A",
        scheduledRunDate: "2026-09-15",
        status: "SCHEDULED",
      }),
    ]);

    const page = await listRuns({
      tab: "current",
      cycleId: null,
      status: null,
      page: 1,
    });

    const first = page.rows.find((r) => r.billRunId === "BRN00000001")!;
    const second = page.rows.find((r) => r.billRunId === "BRN00000002")!;
    expect(first.operable).toBe(true);
    expect(first.pastDue).toBe(true);
    expect(second.operable).toBe(false);
    expect(second.pastDue).toBe(false);
  });

  it("keeps a *_FAILED run operable (rerunnable) in Current", async () => {
    mockListRuns.mockResolvedValue([
      repoRow({
        billRunId: "BRN00000010",
        refBillCycleId: "B",
        cycleName: "Cycle B",
        scheduledRunDate: "2026-08-15",
        status: "PROCESSING_FAILED",
      }),
    ]);

    const page = await listRuns({
      tab: "current",
      cycleId: null,
      status: null,
      page: 1,
    });
    expect(page.rows[0]!.operable).toBe(true);
  });

  it("does not mark an APPROVED (or later) run operable", async () => {
    mockListRuns.mockResolvedValue([
      repoRow({
        billRunId: "BRN00000020",
        refBillCycleId: "C",
        cycleName: "Cycle C",
        scheduledRunDate: "2026-08-15",
        status: "APPROVED",
      }),
    ]);

    const page = await listRuns({
      tab: "current",
      cycleId: null,
      status: null,
      page: 1,
    });
    expect(page.rows[0]!.operable).toBe(false);
    expect(page.rows[0]!.pastDue).toBe(true);
  });

  it("never marks a Historical (terminal) run operable", async () => {
    mockCountRuns.mockResolvedValue(1);
    mockListRuns.mockResolvedValue([
      repoRow({
        billRunId: "BRN00000030",
        refBillCycleId: "D",
        cycleName: "Cycle D",
        scheduledRunDate: "2026-06-01",
        status: "COMPLETED",
      }),
    ]);

    const page = await listRuns({
      tab: "historical",
      cycleId: null,
      status: null,
      page: 1,
    });
    expect(page.tab).toBe("historical");
    expect(page.rows[0]!.operable).toBe(false);
  });
});

describe("listRuns tab-scoped status filter (bm02-spec §Design)", () => {
  it("ignores a status filter on the Current tab (operability stays over the full set)", async () => {
    mockListRuns.mockResolvedValue([]);

    await listRuns({
      tab: "current",
      cycleId: null,
      status: "SCHEDULED",
      page: 1,
    });

    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: null }),
    );
    expect(mockCountRuns).not.toHaveBeenCalled();
  });

  it("ignores a non-terminal status on the Historical tab (no dead-end)", async () => {
    mockCountRuns.mockResolvedValue(0);

    await listRuns({
      tab: "historical",
      cycleId: null,
      status: "SCHEDULED",
      page: 1,
    });

    expect(mockCountRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: null }),
    );
    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ status: null }),
    );
  });

  it("passes a terminal status through on the Historical tab", async () => {
    mockCountRuns.mockResolvedValue(0);

    await listRuns({
      tab: "historical",
      cycleId: "BCY00000001",
      status: "COMPLETED",
      page: 1,
    });

    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        cycleId: "BCY00000001",
        status: "COMPLETED",
      }),
    );
  });
});

describe("listRuns pagination + clamping (bm02-spec §5)", () => {
  it("paginates Historical (page 2 → offset one page, limit 50)", async () => {
    mockCountRuns.mockResolvedValue(120);
    mockListRuns.mockResolvedValue([]);

    const page = await listRuns({
      tab: "historical",
      cycleId: null,
      status: null,
      page: 2,
    });

    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 50, offset: 50 }),
    );
    expect(page.pageSize).toBe(50);
    expect(page.page).toBe(2);
    expect(page.total).toBe(120);
  });

  it("clamps an out-of-range Historical page to the last real page", async () => {
    mockCountRuns.mockResolvedValue(120); // 3 pages of 50
    mockListRuns.mockResolvedValue([]);

    const page = await listRuns({
      tab: "historical",
      cycleId: null,
      status: null,
      page: 999,
    });

    // Clamped to page 3 → offset 100, not an empty far-past slice.
    expect(page.page).toBe(3);
    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: 50, offset: 100 }),
    );
  });

  it("does not paginate or count Current & Upcoming (grouped view)", async () => {
    mockListRuns.mockResolvedValue([]);

    await listRuns({ tab: "current", cycleId: null, status: null, page: 1 });

    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: null, offset: 0 }),
    );
    expect(mockCountRuns).not.toHaveBeenCalled();
  });

  it("pulls the full filtered set with { paginate: false } and no count (CSV export)", async () => {
    mockListRuns.mockResolvedValue([]);

    await listRuns(
      { tab: "historical", cycleId: null, status: null, page: 3 },
      { paginate: false },
    );

    expect(mockListRuns).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ limit: null, offset: 0 }),
    );
    expect(mockCountRuns).not.toHaveBeenCalled();
  });

  it("uses a caller-supplied `today` for operability/pastDue", async () => {
    mockListRuns.mockResolvedValue([
      repoRow({
        billRunId: "BRN00000040",
        refBillCycleId: "E",
        cycleName: "Cycle E",
        scheduledRunDate: "2026-08-15",
        status: "SCHEDULED",
      }),
    ]);

    // today threaded as 2026-08-10 → the 2026-08-15 run is NOT yet past-due.
    const page = await listRuns(
      { tab: "current", cycleId: null, status: null, page: 1 },
      { today: "2026-08-10" },
    );
    expect(page.rows[0]!.pastDue).toBe(false);
    expect(page.rows[0]!.operable).toBe(false);
  });
});
