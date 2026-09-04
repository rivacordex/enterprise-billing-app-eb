import { beforeEach, describe, expect, it, vi } from "vitest";

// bm08-spec §Design/§Implementation §1/§5, revised bm16-spec §Design "Fork B".
// The rerun transaction: AUDIT FIRST (before re-trigger), attempt_count SET
// to one uniform new attempt for the SELECTED accounts (back to PROCESSING),
// later stages invalidated via the attempt-keyed latch, then the engine
// re-triggered scoped to the rerun accounts. Trial-bill re-derivation is now
// the re-triggered processor's concern (bm16 Fork B) — this service no
// longer calls `aggregateBill`/`taxBill` inline. `db.transaction` runs its
// callback with a stub tx (trigger-run.service.test.ts precedent).

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markRerunProcessing: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: {
    listForRerun: vi.fn(),
    setAttemptForRerun: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {
    listPostedAccountIds: vi.fn(),
    sumTotalsForAccounts: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/billing/engine-registry", () => ({
  engineRegistry: { trigger: vi.fn() },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { engineRegistry } from "@/services/billing/engine-registry";
import { rerunRun } from "@/services/billing/rerun-run";
import type { RerunRunParams } from "@/services/billing/rerun-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkRerunProcessing = vi.mocked(
  billRunRepository.markRerunProcessing,
);
const mockListForRerun = vi.mocked(billRunAccountRepository.listForRerun);
const mockSetAttempt = vi.mocked(billRunAccountRepository.setAttemptForRerun);
const mockListPosted = vi.mocked(customerBillRepository.listPostedAccountIds);
const mockSumTotals = vi.mocked(customerBillRepository.sumTotalsForAccounts);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockTrigger = vi.mocked(engineRegistry.trigger);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    refBillCycleId: "BCY00000001",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: "2026-08-01",
    glEventAt: "2026-08-01",
    status: "PROCESSED",
    ...overrides,
  } as never;
}

// One failed + one processed + one excluded — the excluded is never rerunnable.
const ACCOUNTS = [
  {
    billingAccountId: "BAN00000001",
    status: "PROCESSING_FAILED",
    attemptCount: 1,
  },
  { billingAccountId: "BAN00000002", status: "PROCESSED", attemptCount: 1 },
  { billingAccountId: "BAN00000003", status: "EXCLUDED", attemptCount: 1 },
] as never;

function params(overrides: Partial<RerunRunParams> = {}): RerunRunParams {
  return {
    billRunId: "BRN00000001",
    accountIds: [],
    fromStage: "validation",
    reason: "profile fixed",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockTrigger.mockResolvedValue({
    executionId: "stub-exec-BRN00000001",
    definitionId: "billrun.bill_run_processing",
    definitionRevision: 0,
    engineRef: "billrun@stub/billrun",
  });
  mockFindByIdForUpdate.mockResolvedValue(run());
  mockListForRerun.mockResolvedValue(ACCOUNTS);
  mockListPosted.mockResolvedValue([]);
  mockSumTotals.mockResolvedValue("215.00");
});

describe("rerunRun (bm08-spec §Design/§1)", () => {
  it("[CRITICAL] writes the BILL_RUN_RERUN audit row (prior totals + reason) BEFORE re-triggering the engine", async () => {
    const result = await rerunRun(params(), "user-1");

    expect(result.ok).toBe(true);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_RERUN",
        actorUserId: "user-1",
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
        beforeData: { priorTotals: "215.00" },
        afterData: {
          accounts: ["BAN00000001", "BAN00000002"],
          fromStage: "validation",
          attempt: 2,
          reason: "profile fixed",
        },
      }),
    );

    const auditOrder = mockInsertAuditEvent.mock.invocationCallOrder[0];
    const engineOrder = mockTrigger.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(engineOrder as number);
  });

  it("[CRITICAL] scopes the attempt bump to the selected accounts only — others and EXCLUDED are untouched", async () => {
    await rerunRun(params({ accountIds: ["BAN00000001"] }), "user-1");

    // Only the explicitly-selected account is bumped/re-processed, to attempt 2.
    expect(mockSetAttempt).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001"],
      2,
    );
    // The engine re-trigger is scoped to exactly that account, new attempt.
    expect(mockTrigger).toHaveBeenCalledWith(
      "billrun",
      expect.objectContaining({ ban_ids: ["BAN00000001"], attempt: 2 }),
    );
  });

  it("[CRITICAL] never touches a finalized (posted) account — dropped from the eligible set", async () => {
    // BAN00000002 carries a posted bill (ref_inv_document_id set).
    mockListPosted.mockResolvedValue(["BAN00000002"]);

    await rerunRun(params(), "user-1");

    // Only the non-excluded, non-posted account survives.
    expect(mockSetAttempt).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001"],
      2,
    );
  });

  it("bumps attempt_count and loops the run PROCESSED → PROCESSING (never processed_at)", async () => {
    const result = await rerunRun(params(), "user-1");

    expect(mockSetAttempt).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001", "BAN00000002"],
      2,
    );
    expect(mockMarkRerunProcessing).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      {
        banCount: 3,
        ratedCount: 0,
        failedCount: 0,
        processingExecutionId: "stub-exec-BRN00000001",
        processingFlowId: "billrun.bill_run_processing",
        processingFlowRevision: 0,
        processingEngineRef: "billrun@stub/billrun",
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: { accountCount: 2, attempt: 2, fromStage: "validation" },
    });
  });

  it("reports one uniform attempt (max + 1) and sets every selected account to it, even when their attempts diverge", async () => {
    // A prior partial rerun left the two accounts on DIFFERENT attempts (1 and
    // 3). The reported/engine/audited attempt is max + 1 = 4, and both accounts
    // are SET to 4 (not per-row incremented to 2 and 4) so the DB matches.
    mockListForRerun.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        status: "PROCESSING_FAILED",
        attemptCount: 1,
      },
      {
        billingAccountId: "BAN00000002",
        status: "PROCESSING_FAILED",
        attemptCount: 3,
      },
    ] as never);

    const result = await rerunRun(params(), "user-1");

    expect(mockSetAttempt).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001", "BAN00000002"],
      4,
    );
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        afterData: expect.objectContaining({ attempt: 4 }),
      }),
    );
    expect(mockTrigger).toHaveBeenCalledWith(
      "billrun",
      expect.objectContaining({ attempt: 4 }),
    );
    expect(result).toMatchObject({ ok: true, value: { attempt: 4 } });
  });

  it("is rerunnable on a PROCESSING_FAILED run (recover a failed run)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(
      run({ status: "PROCESSING_FAILED" }),
    );

    const result = await rerunRun(params(), "user-1");

    expect(result.ok).toBe(true);
  });

  it("rejects an APPROVED (finalized) run as NOT_RERUNNABLE", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "APPROVED" }));

    const result = await rerunRun(params(), "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_RERUNNABLE" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    expect(mockSetAttempt).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("rejects an unknown run as NOT_RERUNNABLE", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await rerunRun(params(), "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_RERUNNABLE" });
  });

  it("returns NO_ACCOUNTS_SELECTED when the selection resolves to nothing rerunnable", async () => {
    // Requesting only the EXCLUDED account — no eligible rows remain.
    const result = await rerunRun(
      params({ accountIds: ["BAN00000003"] }),
      "user-1",
    );

    expect(result).toEqual({ ok: false, code: "NO_ACCOUNTS_SELECTED" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    expect(mockSetAttempt).not.toHaveBeenCalled();
    expect(mockTrigger).not.toHaveBeenCalled();
  });

  it("returns ENGINE_UNREACHABLE and never loops the run back when the engine throws", async () => {
    mockTrigger.mockRejectedValue(new Error("engine down"));

    const result = await rerunRun(params(), "user-1");

    expect(result).toEqual({ ok: false, code: "ENGINE_UNREACHABLE" });
    // The audit + attempt bump ran inside the (rolled-back) txn; the run is
    // never marked PROCESSING because the engine failed first.
    expect(mockInsertAuditEvent).toHaveBeenCalled();
    expect(mockSetAttempt).toHaveBeenCalled();
    expect(mockMarkRerunProcessing).not.toHaveBeenCalled();
  });

  it("re-throws an unrelated error instead of swallowing it as ENGINE_UNREACHABLE", async () => {
    mockFindByIdForUpdate.mockRejectedValue(new Error("connection reset"));

    await expect(rerunRun(params(), "user-1")).rejects.toThrow(
      "connection reset",
    );
  });
});
