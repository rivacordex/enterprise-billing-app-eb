import { beforeEach, describe, expect, it, vi } from "vitest";

// bm12-spec §Design/§Implementation §3. "Check status" reconciles the run
// against the engine's ground truth: RUNNING → just bump the heartbeat;
// FAILED/KILLED → PROCESSING_FAILED; SUCCESS → re-derive from the account
// grain (PROCESSED if every account is now terminal, else a surfaced
// mismatch); every branch bumps the heartbeat and audits.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markProcessingFailed: vi.fn(),
    markDistributionFailed: vi.fn(),
    recomputeStatus: vi.fn(),
    bumpHeartbeat: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listStatusesForRun: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/billing/engine-registry", () => ({
  engineRegistry: { getExecutionStatus: vi.fn() },
}));
// bm20-spec §Phase-2 review fold T2 — the DISTRIBUTING branch delegates to
// the SAME recompute `handle-status-push.ts`'s `DISTRIBUTION_FINISHED` push
// uses.
vi.mock("@/services/billing/distribute-run", () => ({
  recomputeDistributionStatus: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { engineRegistry } from "@/services/billing/engine-registry";
import { recomputeDistributionStatus } from "@/services/billing/distribute-run";
import { reconcileRun } from "@/services/billing/reconcile-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkProcessingFailed = vi.mocked(
  billRunRepository.markProcessingFailed,
);
const mockMarkDistributionFailed = vi.mocked(
  billRunRepository.markDistributionFailed,
);
const mockRecomputeStatus = vi.mocked(billRunRepository.recomputeStatus);
const mockBumpHeartbeat = vi.mocked(billRunRepository.bumpHeartbeat);
const mockListStatusesForRun = vi.mocked(
  billRunAccountRepository.listStatusesForRun,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockGetExecutionStatus = vi.mocked(engineRegistry.getExecutionStatus);
const mockRecomputeDistributionStatus = vi.mocked(recomputeDistributionStatus);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    status: "PROCESSING",
    processingExecutionId: "stub-exec-BRN00000001",
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("reconcileRun (bm12-spec §Design/§3)", () => {
  it("returns NOT_FOUND for an unknown run", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await reconcileRun("BRN00000099", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(mockGetExecutionStatus).not.toHaveBeenCalled();
  });

  it("returns NO_EXECUTION when the run has no recorded execution ref", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ processingExecutionId: null }),
    );

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NO_EXECUTION" });
    expect(mockGetExecutionStatus).not.toHaveBeenCalled();
  });

  it("returns ENGINE_UNREACHABLE when the engine call throws", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockGetExecutionStatus.mockRejectedValue(new Error("engine down"));

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "ENGINE_UNREACHABLE" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("RUNNING: bumps the heartbeat only, run stays PROCESSING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockGetExecutionStatus.mockResolvedValue({ state: "RUNNING" });

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSING",
        engineState: "RUNNING",
        mismatch: false,
      },
    });
    expect(mockBumpHeartbeat).toHaveBeenCalledWith(txStub, "BRN00000001");
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
    expect(mockRecomputeStatus).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({ eventType: "BILL_RUN_RECONCILED" }),
    );
  });

  it("FAILED: pushes the run to PROCESSING_FAILED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockGetExecutionStatus.mockResolvedValue({ state: "FAILED" });

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSING_FAILED",
        engineState: "FAILED",
        mismatch: false,
      },
    });
    expect(mockMarkProcessingFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
    expect(mockBumpHeartbeat).not.toHaveBeenCalled();
  });

  it("KILLED: pushes the run to PROCESSING_FAILED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockGetExecutionStatus.mockResolvedValue({ state: "KILLED" });

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result.ok).toBe(true);
    expect(result.ok && result.value.runStatus).toBe("PROCESSING_FAILED");
    expect(mockMarkProcessingFailed).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
    );
  });

  it("SUCCESS with every account terminal: re-derives and flips to PROCESSED", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockGetExecutionStatus.mockResolvedValue({ state: "SUCCESS" });
    mockListStatusesForRun.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSED" },
      { billingAccountId: "BAN00000002", status: "PROCESSING_FAILED" },
    ]);

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSED",
        engineState: "SUCCESS",
        mismatch: false,
      },
    });
    expect(mockRecomputeStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      expect.objectContaining({ newStatus: "PROCESSED" }),
    );
    expect(mockBumpHeartbeat).not.toHaveBeenCalled();
  });

  it("SUCCESS with an account still in progress: surfaces a mismatch, no status write, and leaves the run flagged (no heartbeat bump)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockGetExecutionStatus.mockResolvedValue({ state: "SUCCESS" });
    mockListStatusesForRun.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSING" },
    ]);

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSING",
        engineState: "SUCCESS",
        mismatch: true,
      },
    });
    expect(mockRecomputeStatus).not.toHaveBeenCalled();
    // A genuine engine-vs-account mismatch must NOT reset the stall clock —
    // bumping it would hide the StallBanner (and its Cancel affordance) on the
    // operator's next refresh, on a run that is actually wedged.
    expect(mockBumpHeartbeat).not.toHaveBeenCalled();
  });

  it("a run not currently PROCESSING just bumps the heartbeat and audits", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "PROCESSING_FAILED" }),
    );
    mockGetExecutionStatus.mockResolvedValue({ state: "FAILED" });

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "PROCESSING_FAILED",
        engineState: "FAILED",
        mismatch: false,
      },
    });
    expect(mockMarkProcessingFailed).not.toHaveBeenCalled();
    expect(mockBumpHeartbeat).toHaveBeenCalledWith(txStub, "BRN00000001");
  });

  // bm-review fix (E3) — once a distribution execution exists, a run PAST
  // DISTRIBUTING (DISTRIBUTION_FAILED / COMPLETED) must reconcile against THAT
  // execution, never fall back to its long-finished processing one and audit
  // the wrong engine state.
  it("a DISTRIBUTION_FAILED run reconciles against the distribution execution, not the processing one", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({
        status: "DISTRIBUTION_FAILED",
        processingExecutionId: "proc-exec",
        distributionExecutionId: "dist-exec",
        distributionEngineRef: "billrun@stub/billrun",
      }),
    );
    mockGetExecutionStatus.mockResolvedValue({ state: "SUCCESS" });

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(mockGetExecutionStatus).toHaveBeenCalledWith(
      "billrun",
      "dist-exec",
      "billrun@stub/billrun",
    );
    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        runStatus: "DISTRIBUTION_FAILED",
        engineState: "SUCCESS",
        mismatch: false,
      },
    });
    expect(mockBumpHeartbeat).toHaveBeenCalledWith(txStub, "BRN00000001");
  });

  // bm20-spec §Phase-2 review fold T2 — the DISTRIBUTING branch, using the
  // distribution execution reference instead of the processing one.
  describe("DISTRIBUTING run", () => {
    function distributingRun(overrides: Record<string, unknown> = {}) {
      return run({
        status: "DISTRIBUTING",
        processingExecutionId: null,
        distributionExecutionId: "stub-exec-dist-BRN00000001",
        distributionEngineRef: "billrun@stub/billrun",
        distributionAttempt: 1,
        ...overrides,
      });
    }

    it("returns NO_EXECUTION when the run has no distribution execution ref", async () => {
      mockFindByIdForUpdate.mockResolvedValue(
        distributingRun({ distributionExecutionId: null }),
      );

      const result = await reconcileRun("BRN00000001", "user-1");

      expect(result).toEqual({ ok: false, code: "NO_EXECUTION" });
      expect(mockGetExecutionStatus).not.toHaveBeenCalled();
    });

    it("RUNNING: bumps the heartbeat only, run stays DISTRIBUTING", async () => {
      mockFindByIdForUpdate.mockResolvedValue(distributingRun());
      mockGetExecutionStatus.mockResolvedValue({ state: "RUNNING" });

      const result = await reconcileRun("BRN00000001", "user-1");

      expect(result).toEqual({
        ok: true,
        value: {
          billRunId: "BRN00000001",
          runStatus: "DISTRIBUTING",
          engineState: "RUNNING",
          mismatch: false,
        },
      });
      expect(mockBumpHeartbeat).toHaveBeenCalledWith(txStub, "BRN00000001");
      expect(mockRecomputeDistributionStatus).not.toHaveBeenCalled();
    });

    it("FAILED/KILLED: pushes the run to DISTRIBUTION_FAILED", async () => {
      mockFindByIdForUpdate.mockResolvedValue(distributingRun());
      mockGetExecutionStatus.mockResolvedValue({ state: "KILLED" });

      const result = await reconcileRun("BRN00000001", "user-1");

      expect(result.ok).toBe(true);
      expect(result.ok && result.value.runStatus).toBe("DISTRIBUTION_FAILED");
      expect(mockMarkDistributionFailed).toHaveBeenCalledWith(
        txStub,
        "BRN00000001",
      );
    });

    it("SUCCESS with every mandatory artifact delivered: re-derives and flips to COMPLETED", async () => {
      mockFindByIdForUpdate.mockResolvedValue(distributingRun());
      mockGetExecutionStatus.mockResolvedValue({ state: "SUCCESS" });
      mockRecomputeDistributionStatus.mockResolvedValue({
        status: "COMPLETED",
      });

      const result = await reconcileRun("BRN00000001", "user-1");

      expect(result).toEqual({
        ok: true,
        value: {
          billRunId: "BRN00000001",
          runStatus: "COMPLETED",
          engineState: "SUCCESS",
          mismatch: false,
        },
      });
      expect(mockRecomputeDistributionStatus).toHaveBeenCalledWith(
        txStub,
        expect.objectContaining({ billRunId: "BRN00000001" }),
      );
    });

    it("SUCCESS with an incomplete/ambiguous outcome set: surfaces a mismatch, leaves the run flagged", async () => {
      mockFindByIdForUpdate.mockResolvedValue(distributingRun());
      mockGetExecutionStatus.mockResolvedValue({ state: "SUCCESS" });
      mockRecomputeDistributionStatus.mockResolvedValue({ status: null });

      const result = await reconcileRun("BRN00000001", "user-1");

      expect(result).toEqual({
        ok: true,
        value: {
          billRunId: "BRN00000001",
          runStatus: "DISTRIBUTING",
          engineState: "SUCCESS",
          mismatch: true,
        },
      });
    });
  });
});
