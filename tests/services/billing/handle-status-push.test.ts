import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Design/§Implementation §8/§29 — the run-level execution-failure
// push: guarded the same way as the stage handler, flips PROCESSING_FAILED.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markProcessingFailed: vi.fn(),
  },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { handleStatusPush } from "@/services/billing/handle-status-push";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkProcessingFailed = vi.mocked(
  billRunRepository.markProcessingFailed,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("handleStatusPush", () => {
  it("marks a PROCESSING run PROCESSING_FAILED", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "PROCESSING",
    } as never);

    const result = await handleStatusPush({ runId: "BRN00000001" });

    expect(result).toEqual({ ok: true });
    expect(mockMarkProcessingFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });

  it("rejects (404) when the run does not exist", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    await expect(
      handleStatusPush({ runId: "BRN00000099" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
  });

  it("rejects (409) when the run is not PROCESSING (e.g. after APPROVED)", async () => {
    mockFindByIdForUpdate.mockResolvedValue({
      billRunId: "BRN00000001",
      status: "APPROVED",
    } as never);

    await expect(
      handleStatusPush({ runId: "BRN00000001" }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
  });
});
