import { beforeEach, describe, expect, it, vi } from "vitest";

// bm11-spec §Design/§Implementation. Posting: per-account transaction,
// resumable (skip already-INVOICED), never double-posts (a postDocument
// failure rolls the per-account transaction back and parks the account via a
// SEPARATE write), SKIPPED/EXCLUDED accounts consume no invoice number, and
// the run completes (INVOICED → COMPLETED) once no account remains PROCESSED.
// `db.transaction` runs its callback with a stub tx (trigger-run/rerun-run
// service test precedent).

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: {
    findByIdForUpdate: vi.fn(),
    markPosting: vi.fn(),
    completePosting: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: {
    listStatusesForRun: vi.fn(),
    updateStatus: vi.fn(),
  },
}));
vi.mock("@/db/repositories/billing/customer-bill.repository", () => ({
  customerBillRepository: {
    lockBillForPosting: vi.fn(),
    computeChargeChecksum: vi.fn(),
    stampPosted: vi.fn(),
  },
}));
vi.mock("@/db/repositories/accounts/document.repository", () => ({
  documentRepository: { insert: vi.fn() },
}));
vi.mock("@/db/repositories/accounts/document-line.repository", () => ({
  documentLineRepository: { insert: vi.fn() },
}));
vi.mock("@/services/accounts/post-document", () => ({
  postDocument: vi.fn(),
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import { documentRepository } from "@/db/repositories/accounts/document.repository";
import { documentLineRepository } from "@/db/repositories/accounts/document-line.repository";
import { postDocument } from "@/services/accounts/post-document";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { db } from "@/db/client";
import { postRun } from "@/services/billing/post-run";

const mockFindByIdForUpdate = vi.mocked(billRunRepository.findByIdForUpdate);
const mockMarkPosting = vi.mocked(billRunRepository.markPosting);
const mockCompletePosting = vi.mocked(billRunRepository.completePosting);
const mockListStatusesForRun = vi.mocked(
  billRunAccountRepository.listStatusesForRun,
);
const mockUpdateStatus = vi.mocked(billRunAccountRepository.updateStatus);
const mockLockBill = vi.mocked(customerBillRepository.lockBillForPosting);
const mockComputeChecksum = vi.mocked(
  customerBillRepository.computeChargeChecksum,
);
const mockStampPosted = vi.mocked(customerBillRepository.stampPosted);
const mockDocInsert = vi.mocked(documentRepository.insert);
const mockLineInsert = vi.mocked(documentLineRepository.insert);
const mockPostDocument = vi.mocked(postDocument);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

function run(overrides: Record<string, unknown> = {}) {
  return {
    billRunId: "BRN00000001",
    refBillCycleId: "BCY00000001",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: "2026-08-01",
    glEventAt: "2026-08-01",
    status: "APPROVED",
    approvedBy: "approver-1",
    ...overrides,
  } as never;
}

// The single row `lockBillForPosting` returns: the trial bill + the account's
// attempt counter + the billing-account GL fields, in one joined read.
function bill(overrides: Record<string, unknown> = {}) {
  return {
    customerBillId: "CBL00000001",
    periodPartition: "2026-07-01",
    subtotal: "100.00",
    taxTotal: "8.00",
    totalAmount: "108.00",
    refInvDocumentId: null,
    attemptCount: 1,
    refFinancialAccountId: "FIN00000001",
    currency: "MYR",
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  // POSTING by default: the "ensure posting" transaction and the completion
  // transaction both call `findByIdForUpdate` in production, but this mock
  // (unlike a real DB) doesn't observe the intervening `markPosting` write —
  // starting already-POSTING keeps both reads consistent for tests that
  // aren't specifically exercising the APPROVED → POSTING flip.
  mockFindByIdForUpdate.mockResolvedValue(run({ status: "POSTING" }));
  mockListStatusesForRun.mockResolvedValue([
    { billingAccountId: "BAN00000001", status: "PROCESSED" },
  ] as never);
  mockLockBill.mockResolvedValue(bill());
  mockDocInsert.mockResolvedValue({ documentId: "INV00000001" } as never);
  mockPostDocument.mockResolvedValue({
    ok: true,
    value: {
      documentId: "INV00000001",
      state: "posted",
      postedAt: new Date("2026-08-01T00:00:00Z"),
      lastModified: new Date("2026-08-01T00:00:00Z"),
    },
  });
  mockComputeChecksum.mockResolvedValue("abc123");
  // `stampPosted` reports whether it actually wrote a row; the default success
  // path stamps exactly one (a `false` return signals a concurrent post and
  // makes `postAccount` throw — exercised by its own test below).
  mockStampPosted.mockResolvedValue(true);
  // The run-header writes now report whether a row was updated (their
  // `status`-guarded WHERE) — the default happy path always writes one.
  mockMarkPosting.mockResolvedValue(true);
  mockCompletePosting.mockResolvedValue(true);
  // `updateStatus` returns whether a row was written; the park path checks it
  // (a `false` return means the account was concurrently INVOICED). Default to
  // a successful write so the normal park path reports `parked`.
  mockUpdateStatus.mockResolvedValue(true);
});

describe("postRun (bm11-spec §Design/§Implementation)", () => {
  it("returns NOT_POSTABLE when the run is not APPROVED or POSTING", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "PROCESSED" }));

    const result = await postRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_POSTABLE" });
    expect(mockDocInsert).not.toHaveBeenCalled();
  });

  it("returns NOT_POSTABLE for an unknown run", async () => {
    mockFindByIdForUpdate.mockResolvedValue(null);

    const result = await postRun("BRN00000001", "user-1");

    expect(result).toEqual({ ok: false, code: "NOT_POSTABLE" });
  });

  it("flips APPROVED → POSTING once", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "APPROVED" }));
    mockListStatusesForRun.mockResolvedValue([] as never);

    await postRun("BRN00000001", "user-1");

    expect(mockMarkPosting).toHaveBeenCalledWith(txStub, "BRN00000001");
  });

  it("does not re-flip an already-POSTING run (resume)", async () => {
    mockFindByIdForUpdate.mockResolvedValue(run({ status: "POSTING" }));
    mockListStatusesForRun.mockResolvedValue([] as never);

    await postRun("BRN00000001", "user-1");

    expect(mockMarkPosting).not.toHaveBeenCalled();
  });

  it("builds one INV per PROCESSED account: charge line = subtotal, tax line = tax_total, posted through the document engine", async () => {
    await postRun("BRN00000001", "user-1");

    expect(mockDocInsert).toHaveBeenCalledWith(
      txStub,
      "INV",
      expect.objectContaining({
        state: "draft",
        refFinancialAccountId: "FIN00000001",
        refBillingAccountId: "BAN00000001",
        reasonCode: "STANDARD_INVOICE",
        currency: "MYR",
        totalAmount: "108.00",
        createdBy: "approver-1",
      }),
    );
    expect(mockLineInsert).toHaveBeenNthCalledWith(
      1,
      txStub,
      expect.objectContaining({
        refDocumentId: "INV00000001",
        lineNo: 1,
        lineKind: "charge",
        amount: "100.00",
      }),
    );
    expect(mockLineInsert).toHaveBeenNthCalledWith(
      2,
      txStub,
      expect.objectContaining({
        refDocumentId: "INV00000001",
        lineNo: 2,
        lineKind: "release",
        amount: "8.00",
      }),
    );
    expect(mockPostDocument).toHaveBeenCalledWith(
      txStub,
      "INV00000001",
      "user-1",
    );
    expect(mockStampPosted).toHaveBeenCalledWith(
      txStub,
      "CBL00000001",
      "2026-07-01",
      {
        refInvDocumentId: "INV00000001",
        postedAttempt: 1,
        chargeChecksum: "abc123",
      },
    );
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      { status: "INVOICED", errorCode: null, errorDetail: null },
    );
  });

  it("writes no tax line when tax_total is zero", async () => {
    mockLockBill.mockResolvedValue(
      bill({ taxTotal: "0.00", totalAmount: "100.00" }),
    );

    await postRun("BRN00000001", "user-1");

    expect(mockLineInsert).toHaveBeenCalledTimes(1);
  });

  it("[CRITICAL] resume — an account already carrying ref_inv_document_id is skipped (no second INV)", async () => {
    mockLockBill.mockResolvedValue(bill({ refInvDocumentId: "INV00000099" }));

    const result = await postRun("BRN00000001", "user-1");

    expect(mockDocInsert).not.toHaveBeenCalled();
    expect(mockStampPosted).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      ok: true,
      value: {
        results: [
          { billingAccountId: "BAN00000001", result: { status: "skipped" } },
        ],
      },
    });
  });

  it("[CRITICAL] no double-post — a postDocument failure never stamps the bill or marks INVOICED, and parks the account instead", async () => {
    mockPostDocument.mockResolvedValue({
      ok: false,
      code: "PERIOD_CLOSED",
      openPeriodHint: "Period 2026-08 is closed for MYR.",
    });

    const result = await postRun("BRN00000001", "user-1");

    expect(mockStampPosted).not.toHaveBeenCalled();
    expect(mockUpdateStatus).not.toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      expect.objectContaining({ status: "INVOICED" }),
    );
    // The park write is a SEPARATE, non-transactional write (`db`, not the
    // rolled-back `txStub`).
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      db,
      "BRN00000001",
      "BAN00000001",
      {
        status: "PROCESSED",
        errorCode: "PERIOD_CLOSED",
        errorDetail: "Period 2026-08 is closed for MYR.",
        expectedStatus: "PROCESSED",
      },
    );
    expect(result).toMatchObject({
      ok: true,
      value: {
        results: [
          {
            billingAccountId: "BAN00000001",
            result: {
              status: "parked",
              code: "PERIOD_CLOSED",
              detail: "Period 2026-08 is closed for MYR.",
            },
          },
        ],
        completed: false,
      },
    });
    // The run stays POSTING — completion is never called while an account is
    // still parked (PROCESSED).
    expect(mockCompletePosting).not.toHaveBeenCalled();
  });

  it("[CRITICAL] concurrent post — when the bill was posted concurrently, postAccount rolls its INV back and reports skipped (not a false 'parked'), never a duplicate INVOICED", async () => {
    // The concurrent poster set `ref_inv_document_id` (stampPosted → false, so
    // postAccount throws and its INV rolls back) AND committed the account as
    // INVOICED, so the status-guarded park write matches no row (→ false).
    mockStampPosted.mockResolvedValue(false);
    mockUpdateStatus.mockResolvedValue(false);

    const result = await postRun("BRN00000001", "user-1");

    // The rolled-back transaction never marks INVOICED itself...
    expect(mockUpdateStatus).not.toHaveBeenCalledWith(
      txStub,
      "BRN00000001",
      "BAN00000001",
      expect.objectContaining({ status: "INVOICED" }),
    );
    // ...and the guarded park write is attempted but matches no row.
    expect(mockUpdateStatus).toHaveBeenCalledWith(
      db,
      "BRN00000001",
      "BAN00000001",
      expect.objectContaining({
        status: "PROCESSED",
        errorCode: "POSTING_FAILED",
        expectedStatus: "PROCESSED",
      }),
    );
    // Park matched no row (account already INVOICED) → report skipped, not a
    // misleading 'parked' failure.
    expect(result).toMatchObject({
      value: {
        results: [
          { billingAccountId: "BAN00000001", result: { status: "skipped" } },
        ],
      },
    });
  });

  it("parks with a generic POSTING_FAILED code when an unexpected error is thrown", async () => {
    // The joined read returns no row (a "should never happen" invariant breach)
    // — postAccount throws a non-signal Error → generic park path.
    mockLockBill.mockResolvedValue(null);

    const result = await postRun("BRN00000001", "user-1");

    expect(mockUpdateStatus).toHaveBeenCalledWith(
      expect.anything(),
      "BRN00000001",
      "BAN00000001",
      expect.objectContaining({
        status: "PROCESSED",
        errorCode: "POSTING_FAILED",
      }),
    );
    expect(result).toMatchObject({
      value: {
        results: [
          { billingAccountId: "BAN00000001", result: { status: "parked" } },
        ],
      },
    });
  });

  it("a failed park write does not abort the posting loop — postRun still completes for the other accounts", async () => {
    // Two PROCESSED accounts; the first hits a posting failure AND its park
    // write throws (transient). postAccount must swallow the park error so the
    // loop continues and account #2 is still posted.
    mockListStatusesForRun.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "PROCESSED" },
      { billingAccountId: "BAN00000002", status: "PROCESSED" },
    ] as never);
    mockPostDocument
      .mockResolvedValueOnce({
        ok: false,
        code: "PERIOD_CLOSED",
        openPeriodHint: "Period 2026-08 is closed for MYR.",
      })
      .mockResolvedValue({
        ok: true,
        value: {
          documentId: "INV00000002",
          state: "posted",
          postedAt: new Date("2026-08-01T00:00:00Z"),
          lastModified: new Date("2026-08-01T00:00:00Z"),
        },
      });
    // The park write for account #1 throws; the INVOICED write for account #2
    // succeeds.
    mockUpdateStatus
      .mockRejectedValueOnce(new Error("transient park failure"))
      .mockResolvedValue(true);

    const result = await postRun("BRN00000001", "user-1");

    // Did not throw; account #2 still got its INV posted.
    expect(mockDocInsert).toHaveBeenCalledTimes(2);
    expect(result.ok).toBe(true);
  });

  it("SKIPPED and EXCLUDED accounts consume no invoice number — never iterated", async () => {
    mockListStatusesForRun.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "SKIPPED" },
      { billingAccountId: "BAN00000002", status: "EXCLUDED" },
    ] as never);

    await postRun("BRN00000001", "user-1");

    expect(mockDocInsert).not.toHaveBeenCalled();
  });

  it("already-INVOICED accounts are not re-iterated", async () => {
    mockListStatusesForRun.mockResolvedValue([
      { billingAccountId: "BAN00000001", status: "INVOICED" },
    ] as never);

    await postRun("BRN00000001", "user-1");

    expect(mockDocInsert).not.toHaveBeenCalled();
    expect(mockCompletePosting).toHaveBeenCalled();
  });

  it("completes the run (INVOICED → COMPLETED) and writes BILL_RUN_POSTED once no account remains PROCESSED", async () => {
    // The pre-loop read finds the account PROCESSED (eligible to post); the
    // post-loop completion check reads the fresh state after `postAccount`
    // marked it INVOICED.
    mockListStatusesForRun
      .mockResolvedValueOnce([
        { billingAccountId: "BAN00000001", status: "PROCESSED" },
      ] as never)
      .mockResolvedValueOnce([
        { billingAccountId: "BAN00000001", status: "INVOICED" },
      ] as never);

    const result = await postRun("BRN00000001", "user-1");

    expect(mockCompletePosting).toHaveBeenCalledWith(txStub, "BRN00000001");
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_POSTED",
        actorUserId: "user-1",
        targetEntity: "BILL_RUN",
        targetId: "BRN00000001",
      }),
    );
    expect(result).toMatchObject({ ok: true, value: { completed: true } });
  });

  it("does not complete the run while any account remains PROCESSED", async () => {
    mockPostDocument.mockResolvedValue({
      ok: false,
      code: "PERIOD_CLOSED",
      openPeriodHint: "closed",
    });

    await postRun("BRN00000001", "user-1");

    expect(mockCompletePosting).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});
