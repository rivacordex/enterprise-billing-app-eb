import { beforeEach, describe, expect, it, vi } from "vitest";

// bm08-spec §Design/§Implementation §1/§5. The rerun transaction: AUDIT FIRST
// (before re-trigger), attempt_count SET to one uniform new attempt for the
// SELECTED accounts (back to PROCESSING), later stages invalidated via the
// attempt-keyed latch, trial
// bills re-derived under the ref_inv_document_id IS NULL guard, then the engine
// re-triggered scoped to the rerun accounts. `db.transaction` runs its callback
// with a stub tx (trigger-run.service.test.ts precedent).

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
    listUnpostedBillAccountIds: vi.fn(),
    sumTotalsForAccounts: vi.fn(),
  },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/billing/engine-client", () => ({
  getEngineClient: vi.fn(),
}));
vi.mock("@/services/billing/aggregate-bill", () => ({
  aggregateBill: vi.fn(),
}));
vi.mock("@/services/billing/taxation", () => ({ taxBill: vi.fn() }));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { getEngineClient } from "@/services/billing/engine-client";
import { aggregateBill } from "@/services/billing/aggregate-bill";
import { taxBill } from "@/services/billing/taxation";
import { rerunRun } from "@/services/billing/rerun-run";
import type { RerunRunParams } from "@/services/billing/rerun-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkRerunProcessing = vi.mocked(
  billRunRepository.markRerunProcessing,
);
const mockListForRerun = vi.mocked(billRunAccountRepository.listForRerun);
const mockSetAttempt = vi.mocked(billRunAccountRepository.setAttemptForRerun);
const mockListPosted = vi.mocked(customerBillRepository.listPostedAccountIds);
const mockListUnposted = vi.mocked(
  customerBillRepository.listUnpostedBillAccountIds,
);
const mockSumTotals = vi.mocked(customerBillRepository.sumTotalsForAccounts);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockGetEngineClient = vi.mocked(getEngineClient);
const mockAggregateBill = vi.mocked(aggregateBill);
const mockTaxBill = vi.mocked(taxBill);

const startExecution = vi.fn();

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
  mockFindByIdForUpdate.mockResolvedValue(run());
  mockListForRerun.mockResolvedValue(ACCOUNTS);
  mockListPosted.mockResolvedValue([]);
  // Both rerunnable accounts already have an unposted trial bill (they reached
  // Aggregation before) — so both are re-derivable inline by default.
  mockListUnposted.mockResolvedValue(["BAN00000001", "BAN00000002"]);
  mockSumTotals.mockResolvedValue("215.00");
  mockAggregateBill.mockResolvedValue(undefined);
  mockTaxBill.mockResolvedValue(undefined);
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
    const engineOrder = startExecution.mock.invocationCallOrder[0];
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
    expect(startExecution).toHaveBeenCalledWith(
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
    expect(mockAggregateBill).toHaveBeenCalledTimes(1);
    expect(mockAggregateBill).toHaveBeenCalledWith(
      txStub,
      run(),
      "BAN00000001",
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
        workflowExecutionId: "stub-exec-BRN00000001",
        workflowDefinitionId: "billing.bill_run",
        workflowDefinitionRevision: 0,
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
    expect(startExecution).toHaveBeenCalledWith(
      expect.objectContaining({ attempt: 4 }),
    );
    expect(result).toMatchObject({ ok: true, value: { attempt: 4 } });
  });

  it("re-derives Aggregation + Taxation for each rerun account from stage validation", async () => {
    await rerunRun(params({ fromStage: "validation" }), "user-1");

    expect(mockAggregateBill).toHaveBeenCalledTimes(2);
    expect(mockTaxBill).toHaveBeenCalledTimes(2);
    for (const banId of ["BAN00000001", "BAN00000002"]) {
      expect(mockAggregateBill).toHaveBeenCalledWith(txStub, run(), banId);
      expect(mockTaxBill).toHaveBeenCalledWith(txStub, run(), banId);
    }
  });

  it("re-taxes only (no re-aggregation) when rerun starts at taxation", async () => {
    await rerunRun(params({ fromStage: "taxation" }), "user-1");

    expect(mockAggregateBill).not.toHaveBeenCalled();
    expect(mockTaxBill).toHaveBeenCalledTimes(2);
  });

  it("re-derives nothing when rerun starts at verification (downstream of both)", async () => {
    await rerunRun(params({ fromStage: "verification" }), "user-1");

    expect(mockAggregateBill).not.toHaveBeenCalled();
    expect(mockTaxBill).not.toHaveBeenCalled();
  });

  it("does NOT bill a selected account that has no trial bill inline (left for the re-validated engine path)", async () => {
    // BAN00000001 (PROCESSING_FAILED, e.g. failed at Validation) has no bill;
    // only BAN00000002 has one. Rerun from validation must re-derive ONLY the
    // account that already has a bill — never create a bill inline for an
    // unvalidated account.
    mockListUnposted.mockResolvedValue(["BAN00000002"]);

    await rerunRun(params({ fromStage: "validation" }), "user-1");

    // Both are still attempt-bumped (the engine re-validates them)…
    expect(mockSetAttempt).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001", "BAN00000002"],
      2,
    );
    // …but only the account with an existing bill is re-derived inline.
    expect(mockAggregateBill).toHaveBeenCalledTimes(1);
    expect(mockAggregateBill).toHaveBeenCalledWith(
      txStub,
      run(),
      "BAN00000002",
    );
    expect(mockTaxBill).toHaveBeenCalledTimes(1);
    expect(mockTaxBill).toHaveBeenCalledWith(txStub, run(), "BAN00000002");
  });

  it("rerun from taxation with a bill-less account does not call taxBill for it (no CONFLICT rollback) and still succeeds", async () => {
    // Regression: previously taxBill was called for every selected account, so a
    // bill-less account made taxBill throw CONFLICT, rolling back the WHOLE
    // rerun (all-or-nothing) with a non-typed error.
    mockListUnposted.mockResolvedValue(["BAN00000002"]);

    const result = await rerunRun(params({ fromStage: "taxation" }), "user-1");

    expect(result.ok).toBe(true);
    expect(mockAggregateBill).not.toHaveBeenCalled();
    expect(mockTaxBill).toHaveBeenCalledTimes(1);
    expect(mockTaxBill).toHaveBeenCalledWith(txStub, run(), "BAN00000002");
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
    expect(startExecution).not.toHaveBeenCalled();
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
    expect(startExecution).not.toHaveBeenCalled();
  });

  it("returns ENGINE_UNREACHABLE and never loops the run back when the engine throws", async () => {
    startExecution.mockRejectedValue(new Error("engine down"));

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
