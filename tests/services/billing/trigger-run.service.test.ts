import { beforeEach, describe, expect, it, vi } from "vitest";

// bm03-spec §Design/§7/§9. The trigger transaction: double-trigger guard,
// scoping snapshot write, in-txn engine call, PROCESSING + gl_event_at write,
// and the BILL_RUN_TRIGGERED audit row. `db.transaction` runs its callback
// with a stub tx (materialize-runs.service.test.ts precedent) — the DB-level
// rollback-on-engine-failure guarantee is proven by the integration suite;
// here we assert the service never calls the persisting writes past the
// thrown engine error.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markProcessing: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: {
    insertSnapshot: vi.fn(),
    maxAttemptForRun: vi.fn(),
    deleteForRun: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/billing/scope-accounts", () => ({
  scopeAccounts: vi.fn(),
}));
vi.mock("@/services/billing/engine-client", () => ({
  getEngineClient: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { scopeAccounts } from "@/services/billing/scope-accounts";
import { getEngineClient } from "@/services/billing/engine-client";
import { triggerRun } from "@/services/billing/trigger-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkProcessing = vi.mocked(billRunRepository.markProcessing);
const mockInsertSnapshot = vi.mocked(billRunAccountRepository.insertSnapshot);
const mockMaxAttemptForRun = vi.mocked(
  billRunAccountRepository.maxAttemptForRun,
);
const mockDeleteForRun = vi.mocked(billRunAccountRepository.deleteForRun);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockScopeAccounts = vi.mocked(scopeAccounts);
const mockGetEngineClient = vi.mocked(getEngineClient);

const TODAY = "2026-08-19";

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    refBillCycleId: "BCY00000001",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: "2026-08-01",
    status: "SCHEDULED",
    ...overrides,
  } as never;
}

const PENDING_ROW = {
  refBillRunId: "BRN00000001",
  refBillingAccountId: "BAN00000001",
  periodPartition: "2026-07-01",
  status: "PENDING",
  errorCode: null,
};
const EXCLUDED_ROW = {
  refBillRunId: "BRN00000001",
  refBillingAccountId: "BAN00000002",
  periodPartition: "2026-07-01",
  status: "EXCLUDED",
  errorCode: "PARTIAL_PERIOD",
};

const startExecution = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  mockGetEngineClient.mockReturnValue({
    startExecution,
    getExecutionStatus: vi.fn(),
    killExecution: vi.fn(),
  } as never);
  startExecution.mockResolvedValue({
    executionId: "stub-exec-BRN00000001",
    definitionId: "billing.bill_run",
    definitionRevision: 0,
  });
  mockScopeAccounts.mockResolvedValue({
    pending: [PENDING_ROW],
    excluded: [EXCLUDED_ROW],
  });
});

describe("triggerRun (bm03-spec §Design/§7)", () => {
  it("happy trigger: snapshots accounts, flips PROCESSING, stores the execution ref, audits", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());

    const result = await triggerRun("BRN00000001", "user-1", TODAY);

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        banCount: 1,
        excludedCount: 1,
        executionId: "stub-exec-BRN00000001",
      },
    });
    expect(mockInsertSnapshot).toHaveBeenCalledWith(txStub, [
      PENDING_ROW,
      EXCLUDED_ROW,
    ]);
    expect(startExecution).toHaveBeenCalledWith({
      bill_run_id: "BRN00000001",
      period_start: "2026-07-01",
      period_end: "2026-07-31",
      ban_ids: ["BAN00000001"],
      attempt: 1,
      gl_event_at: "2026-08-01",
    });
    expect(mockMarkProcessing).toHaveBeenCalledWith(txStub, "BRN00000001", {
      glEventAt: "2026-08-01",
      triggeredBy: "user-1",
      workflowExecutionId: "stub-exec-BRN00000001",
      workflowDefinitionId: "billing.bill_run",
      workflowDefinitionRevision: 0,
    });
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_TRIGGERED",
        actorUserId: "user-1",
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
        afterData: {
          banCount: 1,
          excludedCount: 1,
          executionId: "stub-exec-BRN00000001",
        },
      }),
    );
  });

  it("rejects a run that does not exist (NOT_OPERABLE)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await triggerRun("BRN00000099", "user-1", TODAY);

    expect(result).toEqual({ ok: false, code: "NOT_OPERABLE" });
    expect(mockScopeAccounts).not.toHaveBeenCalled();
  });

  it("double-trigger: rejects a run that is already PROCESSING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "PROCESSING" }));

    const result = await triggerRun("BRN00000001", "user-1", TODAY);

    expect(result).toEqual({ ok: false, code: "NOT_OPERABLE" });
    expect(mockScopeAccounts).not.toHaveBeenCalled();
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
  });

  it("rejects an upcoming run (scheduled_run_date > today)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ scheduledRunDate: "2026-09-01" }),
    );

    const result = await triggerRun("BRN00000001", "user-1", TODAY);

    expect(result).toEqual({ ok: false, code: "NOT_OPERABLE" });
  });

  it("returns NO_ELIGIBLE_ACCOUNTS and writes no snapshot when nothing is PENDING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    mockScopeAccounts.mockResolvedValue({ pending: [], excluded: [] });

    const result = await triggerRun("BRN00000001", "user-1", TODAY);

    expect(result).toEqual({ ok: false, code: "NO_ELIGIBLE_ACCOUNTS" });
    expect(mockInsertSnapshot).not.toHaveBeenCalled();
    expect(startExecution).not.toHaveBeenCalled();
    expect(mockMarkProcessing).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns ENGINE_UNREACHABLE and never marks PROCESSING/audits when the engine throws", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run());
    startExecution.mockRejectedValue(new Error("engine down"));

    const result = await triggerRun("BRN00000001", "user-1", TODAY);

    expect(result).toEqual({ ok: false, code: "ENGINE_UNREACHABLE" });
    expect(mockInsertSnapshot).toHaveBeenCalled(); // written before the engine call inside the (rolled-back) txn
    expect(mockMarkProcessing).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("re-throws an unrelated error instead of swallowing it as ENGINE_UNREACHABLE", async () => {
    mockFindByIdForUpdate.mockRejectedValue(new Error("connection reset"));

    await expect(triggerRun("BRN00000001", "user-1", TODAY)).rejects.toThrow(
      "connection reset",
    );
  });

  // bm12-spec §Design/§Implementation §6. The trigger guard is extended to
  // allow re-triggering a CANCELLED run — the Layer-3 escape hatch.
  describe("re-trigger from CANCELLED (bm12-spec §6)", () => {
    it("re-snapshots fresh under a new attempt (maxAttempt + 1), clearing the prior snapshot first", async () => {
      mockFindByIdForUpdate.mockResolvedValue(run({ status: "CANCELLED" }));
      mockMaxAttemptForRun.mockResolvedValue(1);

      const result = await triggerRun("BRN00000001", "user-1", TODAY);

      expect(result).toEqual({
        ok: true,
        value: {
          billRunId: "BRN00000001",
          banCount: 1,
          excludedCount: 1,
          executionId: "stub-exec-BRN00000001",
        },
      });
      expect(mockMaxAttemptForRun).toHaveBeenCalledWith(txStub, "BRN00000001");
      expect(mockDeleteForRun).toHaveBeenCalledWith(txStub, "BRN00000001");
      expect(mockInsertSnapshot).toHaveBeenCalledWith(txStub, [
        { ...PENDING_ROW, attemptCount: 2 },
        { ...EXCLUDED_ROW, attemptCount: 2 },
      ]);
      expect(startExecution).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 2 }),
      );
      // Deleting happens before re-inserting, so no ordering collision.
      const deleteOrder = mockDeleteForRun.mock.invocationCallOrder[0] ?? -1;
      const insertOrder = mockInsertSnapshot.mock.invocationCallOrder[0] ?? -1;
      expect(deleteOrder).toBeLessThan(insertOrder);
    });

    it("computes attempt 1 when the run has never been snapshotted (maxAttempt 0)", async () => {
      mockFindByIdForUpdate.mockResolvedValue(run({ status: "CANCELLED" }));
      mockMaxAttemptForRun.mockResolvedValue(0);

      await triggerRun("BRN00000001", "user-1", TODAY);

      expect(startExecution).toHaveBeenCalledWith(
        expect.objectContaining({ attempt: 1 }),
      );
    });

    it("never queries/deletes the prior snapshot on the normal SCHEDULED path", async () => {
      mockFindByIdForUpdate.mockResolvedValue(run());

      await triggerRun("BRN00000001", "user-1", TODAY);

      expect(mockMaxAttemptForRun).not.toHaveBeenCalled();
      expect(mockDeleteForRun).not.toHaveBeenCalled();
    });
  });
});
