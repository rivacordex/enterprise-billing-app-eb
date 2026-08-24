import { beforeEach, describe, expect, it, vi } from "vitest";

// bm12-spec §Design/§Implementation §3. The cancel transaction: guard
// PROCESSING → best-effort killExecution → reset accounts to PENDING → flip
// CANCELLED, clear the execution ref → BILL_RUN_CANCELLED audit. A failed
// kill still lets cancel proceed (logged); no invoice numbers are touched.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    cancel: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { resetForCancel: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/billing/engine-client", () => ({
  getEngineClient: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { getEngineClient } from "@/services/billing/engine-client";
import { logger } from "@/lib/logger";
import { cancelRun } from "@/services/billing/cancel-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockCancel = vi.mocked(billRunRepository.cancel);
const mockResetForCancel = vi.mocked(billRunAccountRepository.resetForCancel);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockGetEngineClient = vi.mocked(getEngineClient);
const mockLoggerWarn = vi.mocked(logger.warn);

const killExecution = vi.fn();

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
    getExecutionStatus: vi.fn(),
    killExecution,
  } as never);
  killExecution.mockResolvedValue(undefined);
  mockResetForCancel.mockResolvedValue(5);
  mockCancel.mockResolvedValue(true);
});

describe("cancelRun (bm12-spec §Design/§3)", () => {
  it("happy cancel: kills the execution, resets accounts, flips CANCELLED, audits", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());

    const result = await cancelRun("BRN00000001", "user-1");

    expect(result).toEqual({
      ok: true,
      value: { billRunId: "BRN00000001", accountsReset: 5 },
    });
    expect(killExecution).toHaveBeenCalledWith("stub-exec-BRN00000001");
    expect(mockResetForCancel).toHaveBeenCalledWith(txStub, "BRN00000001");
    expect(mockCancel).toHaveBeenCalledWith(txStub, "BRN00000001");
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_CANCELLED",
        actorUserId: "user-1",
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
        afterData: { status: "CANCELLED", accountsReset: 5 },
      }),
    );
  });

  it("rejects a run that does not exist (NOT_CANCELLABLE)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await cancelRun("BRN00000099", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_CANCELLABLE" });
    expect(killExecution).not.toHaveBeenCalled();
    expect(mockResetForCancel).not.toHaveBeenCalled();
  });

  it("rejects a run that is not PROCESSING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "PROCESSED" }));

    const result = await cancelRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_CANCELLABLE" });
    expect(mockResetForCancel).not.toHaveBeenCalled();
    expect(mockCancel).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("a failed killExecution still lets cancel proceed (logged)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    killExecution.mockRejectedValue(new Error("engine down"));

    const result = await cancelRun("BRN00000001", "user-1");

    expect(result.ok).toBe(true);
    expect(mockLoggerWarn).toHaveBeenCalledWith(
      expect.stringContaining("killExecution failed"),
      expect.objectContaining({ billRunId: "BRN00000001" }),
    );
    expect(mockResetForCancel).toHaveBeenCalled();
    expect(mockCancel).toHaveBeenCalled();
  });

  it("skips killExecution when the run has no recorded execution ref", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ workflowExecutionId: null }));

    const result = await cancelRun("BRN00000001", "user-1");

    expect(result.ok).toBe(true);
    expect(killExecution).not.toHaveBeenCalled();
  });
});
