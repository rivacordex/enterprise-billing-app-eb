import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Visual/§Implementation §9 — the Workflow tab's derived read:
// per-account, per-stage cells (null = no signal yet) and the summary,
// always derived, never a stored cache.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listStatusesForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-account-stage.repository", () => ({
  billRunAccountStageRepository: { listLatestForRun: vi.fn() },
}));

import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { getStageTimeline } from "@/services/billing/read/get-stage-timeline";
import { STAGES } from "@/types/billing";

const mockListStatuses = vi.mocked(billRunAccountRepository.listStatusesForRun);
const mockListLatest = vi.mocked(
  billRunAccountStageRepository.listLatestForRun,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("getStageTimeline", () => {
  it("builds one row per account, one cell per Stage, filling signalled stages and leaving the rest null", async () => {
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
      { billingAccountId: "BAN00000002", status: "EXCLUDED" },
    ]);
    mockListLatest.mockResolvedValue([
      {
        billRunAccountStageId: "BRS00000001",
        refBillRunId: "BRN00000001",
        refBillingAccountId: "BAN00000001",
        periodPartition: "2026-07-01",
        stage: "collection",
        attempt: 1,
        status: "DONE",
        startedAt: null,
        endedAt: null,
        errorClass: null,
        errorCode: null,
        errorDetail: null,
      } as never,
    ]);

    const { rows, summary } = await getStageTimeline("BRN00000001");

    expect(rows).toHaveLength(2);
    expect(rows[0]?.cells).toHaveLength(STAGES.length);
    const collectionCell = rows[0]?.cells.find((c) => c.stage === "collection");
    expect(collectionCell).toEqual({
      stage: "collection",
      status: "DONE",
      errorClass: null,
    });
    const validationCell = rows[0]?.cells.find((c) => c.stage === "validation");
    expect(validationCell).toEqual({
      stage: "validation",
      status: null,
      errorClass: null,
    });

    expect(summary).toEqual({
      total: 2,
      processed: 0,
      processingFailed: 0,
      excluded: 1,
    });
  });

  it("returns an empty timeline for a run with no scoped accounts", async () => {
    mockListStatuses.mockResolvedValue([]);
    mockListLatest.mockResolvedValue([]);

    const { rows, summary } = await getStageTimeline("BRN00000001");

    expect(rows).toEqual([]);
    expect(summary).toEqual({
      total: 0,
      processed: 0,
      processingFailed: 0,
      excluded: 0,
    });
  });
});
