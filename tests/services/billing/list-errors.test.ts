import { beforeEach, describe, expect, it, vi } from "vitest";

// bm07-spec §Design/§Implementation §2. The Errors read: maps the joined
// PROCESSING_FAILED + latest-HARD-stage repository rows onto `ErrorRow`.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listErrorsForRun: vi.fn() },
}));

import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { listErrors } from "@/services/billing/read/list-errors";

const mockListErrors = vi.mocked(billRunAccountRepository.listErrorsForRun);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listErrors (bm07-spec §2)", () => {
  it("maps each HARD failure onto an ErrorRow with stage + code/detail", async () => {
    mockListErrors.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        accountName: "Acme Sdn Bhd",
        stage: "validation",
        errorClass: "HARD",
        errorCode: "UNRESOLVABLE_PROFILE",
        errorDetail: "no currency",
      },
    ]);

    const rows = await listErrors("BRN00000001");

    expect(rows).toEqual([
      {
        billingAccountId: "BAN00000001",
        accountName: "Acme Sdn Bhd",
        stage: "validation",
        errorClass: "HARD",
        errorCode: "UNRESOLVABLE_PROFILE",
        errorDetail: "no currency",
      },
    ]);
  });

  it("returns an empty array when no account failed (positive empty state upstream)", async () => {
    mockListErrors.mockResolvedValue([]);
    expect(await listErrors("BRN00000001")).toEqual([]);
  });
});
