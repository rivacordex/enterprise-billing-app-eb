import { beforeEach, describe, expect, it, vi } from "vitest";

// bm17-spec §Design "Reject model (b)" / §Implementation §2. The reject
// transaction: AUDIT FIRST (before any write), `udr-status.markRejected`
// flips the rejected accounts' claim to REJECTED, their unposted trial bills
// are deleted, and each account's latest (current-attempt) stage row is
// stamped with the REJECTED_PENDING_REPROCESS marker. `bill_run_account`'s
// status is never touched — the run stays PROCESSED throughout.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: {
    listForRerun: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account-stage.repository", () => ({
  billRunAccountStageRepository: {
    findLatestForAccount: vi.fn(),
    stampMarker: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {
    listPostedAccountIds: vi.fn(),
    sumTotalsForAccounts: vi.fn(),
    deleteUnpostedForAccounts: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/udr-status.repository", () => ({
  udrStatusRepository: { markRejected: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { billRunAccountStageRepository } from "@/db/repositories/billing/bill-run-account-stage.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { udrStatusRepository } from "@/db/repositories/billing/udr-status.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { rejectRun } from "@/services/billing/reject-run";
import type { RejectRunParams } from "@/services/billing/reject-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockListForRerun = vi.mocked(billRunAccountRepository.listForRerun);
const mockListPosted = vi.mocked(customerBillRepository.listPostedAccountIds);
const mockSumTotals = vi.mocked(customerBillRepository.sumTotalsForAccounts);
const mockDeleteUnposted = vi.mocked(
  customerBillRepository.deleteUnpostedForAccounts,
);
const mockMarkRejected = vi.mocked(udrStatusRepository.markRejected);
const mockFindLatestForAccount = vi.mocked(
  billRunAccountStageRepository.findLatestForAccount,
);
const mockStampMarker = vi.mocked(billRunAccountStageRepository.stampMarker);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    status: "PROCESSED",
    ...overrides,
  } as never;
}

// Two postable (PROCESSED) accounts, one already failed (never reject-
// eligible), one excluded (never reject-eligible).
const ACCOUNTS = [
  { billingAccountId: "BAN00000001", status: "PROCESSED", attemptCount: 1 },
  { billingAccountId: "BAN00000002", status: "PROCESSED", attemptCount: 2 },
  {
    billingAccountId: "BAN00000003",
    status: "PROCESSING_FAILED",
    attemptCount: 1,
  },
  { billingAccountId: "BAN00000004", status: "EXCLUDED", attemptCount: 1 },
] as never;

function params(overrides: Partial<RejectRunParams> = {}): RejectRunParams {
  return {
    billRunId: "BRN00000001",
    scope: "all",
    banIds: [],
    reason: "bad rate card",
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByIdForUpdate.mockResolvedValue(run());
  mockListForRerun.mockResolvedValue(ACCOUNTS);
  mockListPosted.mockResolvedValue([]);
  mockSumTotals.mockResolvedValue("215.00");
  mockFindLatestForAccount.mockResolvedValue({
    billRunAccountStageId: "BRS00000001",
    periodPartition: "2026-07-01",
  } as never);
});

describe("rejectRun (bm17-spec §Design/§2)", () => {
  it("[CRITICAL] writes the BILL_RUN_REJECTED audit row BEFORE any reject write", async () => {
    const result = await rejectRun(params(), "user-approver");

    expect(result.ok).toBe(true);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_REJECTED",
        actorUserId: "user-approver",
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
        beforeData: { priorTotals: "215.00" },
        afterData: {
          accounts: ["BAN00000001", "BAN00000002"],
          reason: "bad rate card",
        },
      }),
    );

    const auditOrder = mockInsertAuditEvent.mock.invocationCallOrder[0];
    const markRejectedOrder = mockMarkRejected.mock.invocationCallOrder[0];
    const deleteOrder = mockDeleteUnposted.mock.invocationCallOrder[0];
    expect(auditOrder).toBeLessThan(markRejectedOrder as number);
    expect(auditOrder).toBeLessThan(deleteOrder as number);
  });

  it("[CRITICAL] only PROCESSED (postable) accounts are reject-eligible — PROCESSING_FAILED/EXCLUDED are dropped", async () => {
    await rejectRun(params(), "user-approver");

    expect(mockMarkRejected).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001", "BAN00000002"],
    );
    expect(mockDeleteUnposted).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001", "BAN00000002"],
    );
  });

  it("[CRITICAL] never touches a finalized (posted) account — dropped from the eligible set", async () => {
    mockListPosted.mockResolvedValue(["BAN00000002"]);

    await rejectRun(params(), "user-approver");

    expect(mockMarkRejected).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001"],
    );
  });

  it("scopes to the explicit selection when scope is 'selected'", async () => {
    await rejectRun(
      params({ scope: "selected", banIds: ["BAN00000001"] }),
      "user-approver",
    );

    expect(mockMarkRejected).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      ["BAN00000001"],
    );
  });

  it("[CRITICAL] stamps the REJECTED_PENDING_REPROCESS marker on each account's latest CURRENT-ATTEMPT stage row", async () => {
    await rejectRun(params(), "user-approver");

    expect(mockFindLatestForAccount).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      1,
    );
    expect(mockFindLatestForAccount).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000002",
      2,
    );
    expect(mockStampMarker).toHaveBeenCalledWith(
      txStub,
      "BRS00000001",
      "2026-07-01",
      "bad rate card",
    );
  });

  it("[CRITICAL] fails the whole reject when an account has no stage row (defensive — should not happen for a PROCESSED account, but the no_rejected_pending approval gate reads only this marker, so a silent skip would leave a rejected account unblocked from approval)", async () => {
    mockFindLatestForAccount.mockResolvedValue(null);

    await expect(rejectRun(params(), "user-approver")).rejects.toThrow();

    expect(mockStampMarker).not.toHaveBeenCalled();
  });

  it("rejects a non-PROCESSED run as NOT_REJECTABLE, with no writes", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "APPROVED" }));

    const result = await rejectRun(params(), "user-approver");

    expect(result).toEqual({ ok: false, code: "NOT_REJECTABLE" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    expect(mockMarkRejected).not.toHaveBeenCalled();
  });

  it("rejects an unknown run as NOT_REJECTABLE", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await rejectRun(params(), "user-approver");

    expect(result).toEqual({ ok: false, code: "NOT_REJECTABLE" });
  });

  it("returns NO_ACCOUNTS_SELECTED when the selection resolves to nothing reject-eligible", async () => {
    const result = await rejectRun(
      params({ scope: "selected", banIds: ["BAN00000004"] }),
      "user-approver",
    );

    expect(result).toEqual({ ok: false, code: "NO_ACCOUNTS_SELECTED" });
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
    expect(mockMarkRejected).not.toHaveBeenCalled();
  });

  it("re-throws an unrelated error instead of swallowing it", async () => {
    mockFindByIdForUpdate.mockRejectedValue(new Error("connection reset"));

    await expect(rejectRun(params(), "user-approver")).rejects.toThrow(
      "connection reset",
    );
  });
});
