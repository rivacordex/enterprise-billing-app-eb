import { beforeEach, describe, expect, it, vi } from "vitest";

// bm20-spec §Visual/D-T3. `getDistribution` returns `null` both when the run
// doesn't exist and when it hasn't reached INVOICED yet (or never will, e.g.
// CANCELLED) — a run earlier than INVOICED has no distribution to show, and
// the guard runs BEFORE the delivery-log read so an unrelated run's status
// history is never queried needlessly.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { findDetailById: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-distribution.repository", () => ({
  billRunDistributionRepository: { listForRun: vi.fn() },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunDistributionRepository } from "@/db/repositories/billing/bill-run-distribution.repository";
import { getDistribution } from "@/services/billing/read/get-distribution";

const mockFindDetailById = vi.mocked(billRunRepository.findDetailById);
const mockListForRun = vi.mocked(billRunDistributionRepository.listForRun);

function detail(status: string) {
  return {
    billRunId: "BRN00000001",
    cycleName: "Monthly",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: "2026-08-01",
    status,
    lastProgressAt: null,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockListForRun.mockResolvedValue([]);
});

describe("getDistribution (bm20-spec §Visual/D-T3)", () => {
  it("returns null for an unknown run", async () => {
    mockFindDetailById.mockResolvedValue(null);

    const result = await getDistribution("BRN00000099");

    expect(result).toBeNull();
    expect(mockListForRun).not.toHaveBeenCalled();
  });

  it.each([
    "SCHEDULED",
    "PROCESSING",
    "PROCESSED",
    "APPROVED",
    "POSTING",
    "PROCESSING_FAILED",
    "CANCELLED",
  ])(
    "returns null before the delivery log is read when the run is %s (earlier than INVOICED, or never reaches it)",
    async (status) => {
      mockFindDetailById.mockResolvedValue(detail(status));

      const result = await getDistribution("BRN00000001");

      expect(result).toBeNull();
      expect(mockListForRun).not.toHaveBeenCalled();
    },
  );

  it.each(["INVOICED", "DISTRIBUTING", "COMPLETED", "DISTRIBUTION_FAILED"])(
    "returns a view once the run is %s",
    async (status) => {
      mockFindDetailById.mockResolvedValue(detail(status));

      const result = await getDistribution("BRN00000001");

      expect(result).toMatchObject({
        billRunId: "BRN00000001",
        runStatus: status,
      });
      expect(mockListForRun).toHaveBeenCalledWith(
        expect.anything(),
        "BRN00000001",
      );
    },
  );
});
