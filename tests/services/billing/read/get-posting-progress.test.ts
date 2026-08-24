import { beforeEach, describe, expect, it, vi } from "vitest";

// bm11-spec §Visual. `getPostingProgress` derives the view's display status
// (pending / invoiced / PERIOD_CLOSED / failed) from `bill_run_account.status`
// + `errorCode` — never a stored column.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { findDetailById: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listPostingProgressForRun: vi.fn() },
}));

import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { getPostingProgress } from "@/services/billing/read/get-posting-progress";

const mockFindDetailById = vi.mocked(billRunRepository.findDetailById);
const mockListPostingProgress = vi.mocked(
  billRunAccountRepository.listPostingProgressForRun,
);

beforeEach(() => {
  vi.clearAllMocks();
  mockFindDetailById.mockResolvedValue({
    billRunId: "BRN00000001",
    cycleName: "Monthly",
    periodStart: "2026-07-01",
    periodEnd: "2026-07-31",
    scheduledRunDate: "2026-08-01",
    status: "POSTING",
    lastProgressAt: null,
  });
});

describe("getPostingProgress (bm11-spec §Visual)", () => {
  it("returns null for an unknown run", async () => {
    mockFindDetailById.mockResolvedValue(null);

    const result = await getPostingProgress("BRN00000099");

    expect(result).toBeNull();
    expect(mockListPostingProgress).not.toHaveBeenCalled();
  });

  it("derives invoiced from status=INVOICED regardless of a stale errorCode", async () => {
    mockListPostingProgress.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        accountName: "Acme",
        status: "INVOICED",
        errorCode: null,
        errorDetail: null,
        invoiceId: "INV00000001",
      },
    ] as never);

    const result = await getPostingProgress("BRN00000001");

    expect(result?.rows).toEqual([
      expect.objectContaining({
        billingAccountId: "BAN00000001",
        status: "invoiced",
        invoiceId: "INV00000001",
      }),
    ]);
    expect(result?.postedCount).toBe(1);
    expect(result?.totalCount).toBe(1);
  });

  it("derives PERIOD_CLOSED from a parked PROCESSED account with that error code", async () => {
    mockListPostingProgress.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        accountName: "Acme",
        status: "PROCESSED",
        errorCode: "PERIOD_CLOSED",
        errorDetail: "Period 2026-08 is closed for MYR.",
        invoiceId: null,
      },
    ] as never);

    const result = await getPostingProgress("BRN00000001");

    expect(result?.rows[0]).toMatchObject({ status: "PERIOD_CLOSED" });
    expect(result?.postedCount).toBe(0);
  });

  it("derives failed from a parked PROCESSED account with any other error code", async () => {
    mockListPostingProgress.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        accountName: "Acme",
        status: "PROCESSED",
        errorCode: "POSTING_FAILED",
        errorDetail: "Something went wrong",
        invoiceId: null,
      },
    ] as never);

    const result = await getPostingProgress("BRN00000001");

    expect(result?.rows[0]).toMatchObject({ status: "failed" });
  });

  it("derives pending from a PROCESSED account with no error code yet", async () => {
    mockListPostingProgress.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        accountName: "Acme",
        status: "PROCESSED",
        errorCode: null,
        errorDetail: null,
        invoiceId: null,
      },
    ] as never);

    const result = await getPostingProgress("BRN00000001");

    expect(result?.rows[0]).toMatchObject({ status: "pending" });
  });
});
