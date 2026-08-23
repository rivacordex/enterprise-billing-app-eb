import { beforeEach, describe, expect, it, vi } from "vitest";

// bm10-spec §Design/§Implementation §1. The approve transaction: guard
// PROCESSED → run the five pre-approval checks (four-eyes gets its own
// result code; the rest bucket under CHECKS_FAILED) → stamp
// approved_by/approved_at/the immutable total_amount → mark
// PROCESSING_FAILED/EXCLUDED accounts SKIPPED → APPROVED →
// insertAuditEvent(BILL_RUN_APPROVED). `db.transaction` runs its callback
// with a stub tx (trigger-run/rerun-run.service.test.ts precedent).

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    approve: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { markSkippedForRun: vi.fn() },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: { sumPostableTotalForRun: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/billing/pre-approval-checks", () => ({
  runPreApprovalChecks: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { runPreApprovalChecks } from "@/services/billing/pre-approval-checks";
import { approveRun } from "@/services/billing/approve-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockApprove = vi.mocked(billRunRepository.approve);
const mockMarkSkipped = vi.mocked(billRunAccountRepository.markSkippedForRun);
const mockSumPostableTotal = vi.mocked(
  customerBillRepository.sumPostableTotalForRun,
);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);
const mockRunChecks = vi.mocked(runPreApprovalChecks);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    status: "PROCESSED",
    triggeredBy: "user-trigger",
    ...overrides,
  } as never;
}

const ALL_PASS = [
  { check: "period_open", pass: true, remediation: null },
  { check: "gl_mappings", pass: true, remediation: null },
  { check: "positive_totals", pass: true, remediation: null },
  { check: "four_eyes", pass: true, remediation: null },
  { check: "accounts_terminal", pass: true, remediation: null },
];

beforeEach(() => {
  vi.clearAllMocks();
  mockFindByIdForUpdate.mockResolvedValue(run());
  mockRunChecks.mockResolvedValue(ALL_PASS as never);
  mockSumPostableTotal.mockResolvedValue("315.00");
  mockMarkSkipped.mockResolvedValue(1);
});

describe("approveRun (bm10-spec §Design/§1)", () => {
  it("stamps approved_by/total_amount, marks skipped accounts, and flips APPROVED", async () => {
    const result = await approveRun("BRN00000001", "user-approver");

    expect(result).toEqual({
      ok: true,
      value: {
        billRunId: "BRN00000001",
        totalAmount: "315.00",
        skippedCount: 1,
      },
    });
    expect(mockMarkSkipped).toHaveBeenCalledWith(txStub, "BRN00000001");
    expect(mockApprove).toHaveBeenCalledWith(txStub, "BRN00000001", {
      approvedBy: "user-approver",
      totalAmount: "315.00",
    });
  });

  it("[CRITICAL] writes BILL_RUN_APPROVED with the actor, totals, and skipped count", async () => {
    await approveRun("BRN00000001", "user-approver");

    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_APPROVED",
        actorUserId: "user-approver",
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
        beforeData: { status: "PROCESSED" },
        afterData: {
          status: "APPROVED",
          totalAmount: "315.00",
          skippedCount: 1,
        },
      }),
    );
  });

  it("rejects a non-PROCESSED run as NOT_APPROVABLE, with no writes", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "APPROVED" }));

    const result = await approveRun("BRN00000001", "user-approver");

    expect(result).toEqual({ ok: false, code: "NOT_APPROVABLE" });
    expect(mockRunChecks).not.toHaveBeenCalled();
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("rejects an unknown run as NOT_APPROVABLE", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await approveRun("BRN00000001", "user-approver");

    expect(result).toEqual({ ok: false, code: "NOT_APPROVABLE" });
  });

  it("[CRITICAL] rejects the trigger actor approving their own run as FOUR_EYES_VIOLATION, with no writes", async () => {
    mockRunChecks.mockResolvedValue([
      ...ALL_PASS.slice(0, 3),
      {
        check: "four_eyes",
        pass: false,
        remediation: "You triggered the final attempt on this run...",
      },
      ALL_PASS[4],
    ] as never);

    const result = await approveRun("BRN00000001", "user-trigger");

    expect(result).toEqual({ ok: false, code: "FOUR_EYES_VIOLATION" });
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockMarkSkipped).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("returns CHECKS_FAILED with only the failing checks when a non-four-eyes check fails", async () => {
    mockRunChecks.mockResolvedValue([
      { check: "period_open", pass: false, remediation: "Period closed." },
      ...ALL_PASS.slice(1),
    ] as never);

    const result = await approveRun("BRN00000001", "user-approver");

    expect(result).toEqual({
      ok: false,
      code: "CHECKS_FAILED",
      checks: [
        { check: "period_open", pass: false, remediation: "Period closed." },
      ],
    });
    expect(mockApprove).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("re-throws an unrelated error instead of swallowing it", async () => {
    mockFindByIdForUpdate.mockRejectedValue(new Error("connection reset"));

    await expect(approveRun("BRN00000001", "user-approver")).rejects.toThrow(
      "connection reset",
    );
  });
});
