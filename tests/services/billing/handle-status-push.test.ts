import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Design/§Implementation §8/§29 — the run-level execution-failure
// push: guarded the same way as the stage handler, flips PROCESSING_FAILED.
// bm20-spec §Implementation §4 extends the same handler to the distribution
// execution's terminal push (DISTRIBUTION_FAILED forces the terminal state;
// DISTRIBUTION_FINISHED triggers the app's own recompute).

const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markProcessingFailed: vi.fn(),
    markDistributionFailed: vi.fn(),
  },
}));
vi.mock("@/services/billing/distribute-run", () => ({
  recomputeDistributionStatus: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { recomputeDistributionStatus } from "@/services/billing/distribute-run";
import { handleStatusPush } from "@/services/billing/handle-status-push";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkProcessingFailed = vi.mocked(
  billRunRepository.markProcessingFailed,
);
const mockMarkDistributionFailed = vi.mocked(
  billRunRepository.markDistributionFailed,
);
const mockRecomputeDistributionStatus = vi.mocked(recomputeDistributionStatus);

beforeEach(() => {
  vi.clearAllMocks();
  mockRecomputeDistributionStatus.mockResolvedValue({ status: "COMPLETED" });
});

describe("handleStatusPush", () => {
  it("marks a PROCESSING run PROCESSING_FAILED", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "PROCESSING",
    } as never);

    const result = await handleStatusPush({
      runId: "BRN00000001",
      status: "PROCESSING_FAILED",
    });

    expect(result).toEqual({ ok: true });
    expect(mockMarkProcessingFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });

  it("rejects (409) a DISTRIBUTION_* status while PROCESSING", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "PROCESSING",
    } as never);

    await expect(
      handleStatusPush({
        runId: "BRN00000001",
        status: "DISTRIBUTION_FAILED",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
  });

  it("rejects (404) when the run does not exist", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    await expect(
      handleStatusPush({ runId: "BRN00000099", status: "PROCESSING_FAILED" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
  });

  it("rejects (409) when the run is neither PROCESSING nor DISTRIBUTING (e.g. after APPROVED)", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "APPROVED",
    } as never);

    await expect(
      handleStatusPush({ runId: "BRN00000001", status: "PROCESSING_FAILED" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
  });

  it("marks a DISTRIBUTING run DISTRIBUTION_FAILED on the flow's on_error push", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "DISTRIBUTING",
    } as never);

    const result = await handleStatusPush({
      runId: "BRN00000001",
      status: "DISTRIBUTION_FAILED",
    });

    expect(result).toEqual({ ok: true });
    expect(mockMarkDistributionFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
    expect(mockRecomputeDistributionStatus).not.toHaveBeenCalled();
  });

  it("recomputes distribution status on the flow's finally (DISTRIBUTION_FINISHED) push", async () => {
    const run = { billRunId: "BRN00000001", status: "DISTRIBUTING" };
    mockFindByIdForUpdate.mockResolvedValue(run as never);

    const result = await handleStatusPush({
      runId: "BRN00000001",
      status: "DISTRIBUTION_FINISHED",
    });

    expect(result).toEqual({ ok: true });
    expect(mockRecomputeDistributionStatus).toHaveBeenCalledWith(
      txStub,
      run,
    );
    expect(mockMarkDistributionFailed).not.toHaveBeenCalled();
  });

  it("rejects (409) PROCESSING_FAILED while DISTRIBUTING", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "DISTRIBUTING",
    } as never);

    await expect(
      handleStatusPush({ runId: "BRN00000001", status: "PROCESSING_FAILED" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });
});
