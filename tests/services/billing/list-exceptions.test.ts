import { beforeEach, describe, expect, it, vi } from "vitest";

// bm32-spec §Design/§Implementation §2. The per-record exception surface read:
// resolves the run's WINDOW (the ≤2 UTC-month partitions it spans + the
// start/end dates) and returns the repository's BILL_NOTUSED + orphan rows
// verbatim. An unknown run yields an empty list rather than throwing.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { findById: vi.fn() },
}));
vi.mock("@/db/repositories/billing/rated-lines.repository", () => ({
  ratedLinesRepository: { listExceptionsForWindow: vi.fn() },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { listExceptions } from "@/services/billing/read/list-exceptions";

const mockFindById = vi.mocked(billRunRepository.findById);
const mockListExceptions = vi.mocked(
  ratedLinesRepository.listExceptionsForWindow,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listExceptions (bm32-spec §2)", () => {
  it("scopes the read to the run WINDOW — a calendar-month period spans one partition", async () => {
    mockFindById.mockResolvedValue({
      billRunId: "BRN00000001",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    } as never);
    mockListExceptions.mockResolvedValue([]);

    await listExceptions("BRN00000001");

    expect(mockListExceptions).toHaveBeenCalledWith(expect.anything(), {
      partitions: ["2026-07-01"],
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    });
  });

  it("[bm32 fix] a cycle_day != 1 window spans TWO partitions so second-month rows are not dropped", async () => {
    // The seeded 'Monthly – Day 15' cycle: 2026-07-15 → 2026-08-14 straddles the
    // July and August UTC-month buckets. Both must be scoped, else August's
    // in-window BILL_NOTUSED/orphan rows are silently missed (Inv #25).
    mockFindById.mockResolvedValue({
      billRunId: "BRN00000001",
      periodStart: "2026-07-15",
      periodEnd: "2026-08-14",
    } as never);
    mockListExceptions.mockResolvedValue([]);

    await listExceptions("BRN00000001");

    expect(mockListExceptions).toHaveBeenCalledWith(expect.anything(), {
      partitions: ["2026-07-01", "2026-08-01"],
      periodStart: "2026-07-15",
      periodEnd: "2026-08-14",
    });
  });

  it("returns the BILL_NOTUSED and orphan rows verbatim, resolvable and not", async () => {
    mockFindById.mockResolvedValue({
      billRunId: "BRN00000001",
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
    } as never);
    const rows = [
      {
        kind: "BILL_NOTUSED" as const,
        subscriberRef: "PRDINV00000001",
        accountName: "Acme Sdn Bhd",
        udrType: "RAN_USAGE",
        quantity: "10.000000",
        unit: "GB",
        ratedPrice: "5.00",
        currency: "MYR",
      },
      {
        kind: "ORPHAN" as const,
        subscriberRef: "PRDINV99999999",
        accountName: null,
        udrType: "RAN_USAGE",
        quantity: "1.000000",
        unit: "GB",
        ratedPrice: "1.00",
        currency: "MYR",
      },
    ];
    mockListExceptions.mockResolvedValue(rows);

    expect(await listExceptions("BRN00000001")).toEqual(rows);
  });

  it("returns an empty list for an unknown run (no throw)", async () => {
    mockFindById.mockResolvedValue(null);

    expect(await listExceptions("BRN99999999")).toEqual([]);
    expect(mockListExceptions).not.toHaveBeenCalled();
  });
});
