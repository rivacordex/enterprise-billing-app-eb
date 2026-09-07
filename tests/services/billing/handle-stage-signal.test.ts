import { beforeEach, describe, expect, it, vi } from "vitest";

// bm16-spec §Design "The M2M handler becomes record-only (D5)" /
// §Implementation §4. The stage-complete ingest transaction: run-PROCESSING
// guard → stale-attempt no-op (T14) → stage row insert first (idempotency)
// → record-and-advance (no app-side compute, no write side effect) → run
// recompute under the already-held row lock.

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

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
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
  mockUpdateStatus.mockResolvedValue(true);
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
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });

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
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });
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

describe("handleStageSignal — stale-attempt rejection (T14, superseded execution)", () => {
  it("rejects a late signal whose attempt no longer matches the account — no stage row, no advance", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    // The account was re-triggered onto attempt 2 (a cancel → re-trigger, or a
    // rerun); a straggler signal from the killed attempt-1 execution arrives.
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 2 });

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "aggregation",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    // Accepted as a no-op (200) — never processed against the current attempt.
    expect(result).toEqual({
      replayed: true,
      accountStatus: "PROCESSING",
      runStatus: "PROCESSING",
    });
    expect(mockInsertStageRow).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalled();
    expect(mockRecomputeStatus).not.toHaveBeenCalled();
  });

  it("processes a signal whose attempt matches the account's current attempt", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 2 });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "taxation",
      banId: "BAN00000001",
      attempt: 2,
      status: "DONE",
    });

    expect(result.replayed).toBe(false);
    expect(mockInsertStageRow).toHaveBeenCalled();
  });

  it("throws NOT_FOUND when the account is not scoped into the run, before any write", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue(null);

    await expect(
      handleStageSignal({
        runId: "BRN00000001",
        stage: "aggregation",
        banId: "BAN00000099",
        attempt: 1,
        status: "DONE",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(mockInsertStageRow).not.toHaveBeenCalled();
  });
});

describe("handleStageSignal — record-only (bm16-spec §Design D5)", () => {
  it("records every stage exactly as signalled, with no app-side override", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PENDING", attemptCount: 1 });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "validation",
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
        stage: "validation",
        attempt: 1,
        status: "DONE",
        errorClass: null,
        errorCode: null,
        errorDetail: null,
      }),
    );
    // A non-terminal account records the signal's diagnostics — a clean DONE
    // advance writes errorCode/errorDetail as null (only an already-terminal
    // account preserves prior diagnostics).
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

  it("records collection's caller-signalled outcome verbatim (no app override, unlike Phase 1)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "collection",
      banId: "BAN00000001",
      attempt: 1,
      status: "FAILED",
      errorClass: "HARD",
      errorCode: "CLAIM_MISMATCH",
      errorDetail: "currency mismatch",
    });

    expect(mockInsertStageRow).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        status: "FAILED",
        errorClass: "HARD",
        errorCode: "CLAIM_MISMATCH",
      }),
    );
    expect(result.accountStatus).toBe("PROCESSING_FAILED");
  });

  it("records verification's caller-signalled outcome verbatim (no app-computed SOFT backstop)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSED" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "verification",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
      errorClass: "SOFT",
      errorCode: "NON_POSITIVE_TOTAL",
      errorDetail: "Bill total 0.00 is not positive for account BAN00000001.",
    });

    // The SOFT finding lands on the stage row exactly as signalled — findings
    // are SOFT stage rows, never a new table.
    expect(mockInsertStageRow).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        stage: "verification",
        status: "DONE",
        errorClass: "SOFT",
        errorCode: "NON_POSITIVE_TOTAL",
      }),
    );
    // A SOFT finding never blocks — the account still completes, and the
    // finding stays on the stage row (a DONE outcome clears the account error).
    expect(result.accountStatus).toBe("PROCESSED");
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      { status: "PROCESSED", errorCode: null, errorDetail: null },
    );
  });

  it("a HARD failure moves the account to PROCESSING_FAILED; the run continues", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });
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

  it("an INFRA failure leaves the account non-terminal (retryable) and records its diagnostics on the account row", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });
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
      errorCode: "ENGINE_TIMEOUT",
      errorDetail: "task timed out",
    });

    expect(result.accountStatus).toBe("PROCESSING");
    // A non-terminal (retryable) failure still stamps the account's error
    // fields so a stuck-in-PROCESSING account is not diagnostically blank.
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      {
        status: "PROCESSING",
        errorCode: "ENGINE_TIMEOUT",
        errorDetail: "task timed out",
      },
    );
  });

  it("preserves an already-terminal account's diagnostics on a later stray signal", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({
      status: "PROCESSING_FAILED",
      attemptCount: 1,
    });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING_FAILED" },
    ]);

    await handleStageSignal({
      runId: "BRN00000001",
      stage: "taxation",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    // The account was terminal BEFORE this signal — updateStatus must not
    // write errorCode/errorDetail (which would wipe the stored failure reason).
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      { status: "PROCESSING_FAILED" },
    );
  });

  it("the terminal stage (verification) DONE moves the account to PROCESSED, and the run reaches PROCESSED once every account is terminal", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PROCESSING", attemptCount: 1 });
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

  it("does NOT mark a still-PENDING account PROCESSED from a lone terminal-stage signal", async () => {
    // The processor skips validation/aggregation and signals only
    // verification — the account advances to PROCESSING, never PROCESSED.
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockFindStatus.mockResolvedValue({ status: "PENDING", attemptCount: 1 });
    mockListStatuses.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await handleStageSignal({
      runId: "BRN00000001",
      stage: "verification",
      banId: "BAN00000001",
      attempt: 1,
      status: "DONE",
    });

    expect(result.accountStatus).toBe("PROCESSING");
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

  it("completes a PROCESSING account on the terminal stage DONE/SKIPPED", () => {
    expect(
      advanceAccountStatus("PROCESSING", "verification", {
        status: "DONE",
        errorClass: null,
      }),
    ).toBe("PROCESSED");
  });

  it("does NOT mark a PENDING account PROCESSED from a lone terminal-stage signal", () => {
    // The engine skips validation/aggregation and signals only verification —
    // the account advances to PROCESSING, never to PROCESSED.
    expect(
      advanceAccountStatus("PENDING", "verification", {
        status: "DONE",
        errorClass: null,
      }),
    ).toBe("PROCESSING");
  });
});
