import { beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Design/§Implementation §8, architecture Inv. #5/#9/#12. The
// stage-complete ingest transaction: run-PROCESSING guard → stage row insert
// first (idempotency) → app-side effect (validation only) → account advance
// → run recompute under the already-held row lock.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)) },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    recomputeStatus: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: {
    findStatus: vi.fn(),
    updateStatus: vi.fn(),
    listStatusesForRun: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account-stage.repository", () => ({
  billRunAccountStageRepository: { insertStageRow: vi.fn() },
}));
vi.mock("@/services/billing/validate-account", () => ({
  validateAccount: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { validateAccount } from "@/services/billing/validate-account";
import {
  advanceAccountStatus,
  handleStageSignal,
} from "@/services/billing/handle-stage-signal";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockRecomputeStatus = vi.mocked(billRunRepository.recomputeStatus);
const mockFindStatus = vi.mocked(billRunAccountRepository.findStatus);
const mockUpdateStatus = vi.mocked(billRunAccountRepository.updateStatus);
const mockListStatuses = vi.mocked(billRunAccountRepository.listStatusesForRun);
const mockInsertStageRow = vi.mocked(
  billRunAccountStageRepository.insertStageRow,
);
const mockValidateAccount = vi.mocked(validateAccount);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    periodStart: "2026-07-01",
    status: "PROCESSING",
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockInsertStageRow.mockResolvedValue({} as never);
  mockUpdateStatus.mockResolvedValue(undefined);
  mockRecomputeStatus.mockResolvedValue(undefined);
});

describe("handleStageSignal — guards", () => {
  it("rejects (404) when the run does not exist", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    await expect(
      handleStageSignal({
        runId: "BRN00000099",
        stage: "collection",
        banId: "BAN00000001",
        attempt: 1,
        status: "DONE",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockInsertStageRow).not.toHaveBeenCalled();
  });

  it("rejects (409) when the run is not PROCESSING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "APPROVED" }));

    await expect(
      handleStageSignal({
        runId: "BRN00000001",
        stage: "collection",
        banId: "BAN00000001",
        attempt: 1,
        status: "DONE",
      }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    expect(mockInsertStageRow).not.toHaveBeenCalled();
  });
});

describe("handleStageSignal — idempotency (replay)", () => {
  it("returns replayed:true and performs no advance/recompute on a duplicate signal", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockInsertStageRow.mockRejectedValue({
      code: "23505",
      constraint_name:
        "bill_run_account_stage_run_ban_stage_attempt_period_unique",
    });
    mockFindStatus.mockResolvedValue({ status: "PROCESSING" });

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "collection",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    expect(result).toEqual({
      replayed: true,
      accountStatus: "PROCESSING",
      runStatus: "PROCESSING",
    });
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockRecomputeStatus).not.toHaveBeenCalled();
  });

  it("re-throws an unrelated insert failure instead of treating it as a replay", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockInsertStageRow.mockRejectedValue(new Error("connection reset"));

    await expect(
      handleStageSignal({
        runId: "BRN00000001",
        stage: "collection",
        banId: "BAN00000001",
        attempt: 1,
        status: "DONE",
      }),
    ).rejects.toThrow("connection reset");
  });
});

describe("handleStageSignal — record-and-advance stages", () => {
  it("advances a PENDING account to PROCESSING on the first (non-terminal) stage signal", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PENDING" });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "collection",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    expect(mockInsertStageRow).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        refBillRunId: "BRN00000001",
        refBillingAccountId: "BAN00000001",
        periodPartition: "2026-07-01",
        stage: "collection",
        attempt: 1,
        status: "DONE",
      }),
    );
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      { status: "PROCESSING", errorCode: null, errorDetail: null },
    );
    expect(result).toEqual({
      replayed: false,
      accountStatus: "PROCESSING",
      runStatus: "PROCESSING",
    });
  });

  it("a HARD failure moves the account to PROCESSING_FAILED; the run continues", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING" });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING_FAILED" },
      { billingAccountId: "BAN00000002", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "aggregation",
      banId: "BAN00000001",
      attempt: 1,
      status: "FAILED",
      errorClass: "HARD",
      errorCode: "SOME_HARD_ERROR",
      errorDetail: "boom",
    });

    expect(result.accountStatus).toBe("PROCESSING_FAILED");
    expect(mockRecomputeStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      expect.objectContaining({ newStatus: null }),
    );
  });

  it("an INFRA failure leaves the account non-terminal (retryable)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING" });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "aggregation",
      banId: "BAN00000001",
      attempt: 1,
      status: "FAILED",
      errorClass: "INFRA",
    });

    expect(result.accountStatus).toBe("PROCESSING");
  });

  it("the terminal stage (verification) DONE moves the account to PROCESSED, and the run reaches PROCESSED once every account is terminal", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING" });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSED" },
      { billingAccountId: "BAN00000002", status: "EXCLUDED" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "verification",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    expect(result.accountStatus).toBe("PROCESSED");
    expect(result.runStatus).toBe("PROCESSED");
    expect(mockRecomputeStatus).toHaveBeenCalledWith(txStub, "BRN00000001", {
      newStatus: "PROCESSED",
      banCount: 2,
      ratedCount: 1,
      failedCount: 0,
    });
  });
});

describe("handleStageSignal — the Validation stage's app-computed outcome", () => {
  it("uses validateAccount's outcome, not the caller-supplied status/error fields", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PENDING" });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);
    mockValidateAccount.mockResolvedValue({
      status: "FAILED",
      errorClass: "HARD",
      errorCode: "UNRESOLVABLE_PROFILE",
      errorDetail: "no currency",
    });

    const result = await handleStageSignal({
      // The caller signals DONE (e.g. a trigger-only body) — the app's own
      // readiness check overrides it.
      runId: "BRN00000001",
      stage: "validation",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    expect(mockValidateAccount).toHaveBeenCalledWith(txStub, "BAN00000001");
    expect(mockInsertStageRow).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        status: "FAILED",
        errorClass: "HARD",
        errorCode: "UNRESOLVABLE_PROFILE",
      }),
    );
    expect(result.accountStatus).toBe("PROCESSING_FAILED");
  });
});

describe("advanceAccountStatus (pure)", () => {
  it("leaves an already-terminal account unchanged", () => {
    expect(
      advanceAccountStatus("PROCESSING_FAILED", "collection", {
        status: "DONE",
        errorClass: null,
      }),
    ).toBe("PROCESSING_FAILED");
    expect(
      advanceAccountStatus("EXCLUDED", "collection", {
        status: "DONE",
        errorClass: null,
      }),
    ).toBe("EXCLUDED");
  });
});
