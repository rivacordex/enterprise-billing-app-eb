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
vi.mock("@/services/billing/engine-client", () => ({
  getEngineClient: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { getEngineClient } from "@/services/billing/engine-client";
import { reconcileRun } from "@/services/billing/reconcile-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkProcessingFailed = vi.mocked(
  billRunRepository.markProcessingFailed,
);
const mockRecomputeStatus = vi.mocked(billRunRepository.recomputeStatus);
const mockBumpHeartbeat = vi.mocked(billRunRepository.bumpHeartbeat);
const mockListStatusesForRun = vi.mocked(
  billRunAccountRepository.listStatusesForRun,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockGetEngineClient = vi.mocked(getEngineClient);

const getExecutionStatus = vi.fn();

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    status: "PROCESSING",
    workflowExecutionId: "stub-exec-BRN00000001",
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEngineClient.mockReturnValue({
    startExecution: vi.fn(),
    getExecutionStatus,
    killExecution: vi.fn(),
  } as never);
});

describe("reconcileRun (bm12-spec §Design/§3)", () => {
  it("returns NOT_FOUND for an unknown run", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await reconcileRun("BRN00000099", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(getExecutionStatus).not.toHaveBeenCalled();
  });

  it("returns NO_EXECUTION when the run has no recorded execution ref", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ workflowExecutionId: null }));

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NO_EXECUTION" });
    expect(getExecutionStatus).not.toHaveBeenCalled();
  });

  it("returns ENGINE_UNREACHABLE when the engine call throws", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    getExecutionStatus.mockRejectedValue(new Error("engine down"));

    const result = await reconcileRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "ENGINE_UNREACHABLE" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("RUNNING: bumps the heartbeat only, run stays PROCESSING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    getExecutionStatus.mockResolvedValue({ state: "RUNNING" });

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
    getExecutionStatus.mockResolvedValue({ state: "FAILED" });

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
    getExecutionStatus.mockResolvedValue({ state: "KILLED" });

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
    getExecutionStatus.mockResolvedValue({ state: "SUCCESS" });
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

  it("SUCCESS with an account still in progress: surfaces a mismatch, no status write", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    getExecutionStatus.mockResolvedValue({ state: "SUCCESS" });
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
    expect(mockBumpHeartbeat).toHaveBeenCalledWith(txStub, "BRN00000001");
  });

  it("a run not currently PROCESSING just bumps the heartbeat and audits", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "PROCESSING_FAILED" }),
    );
    getExecutionStatus.mockResolvedValue({ state: "FAILED" });

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
});
