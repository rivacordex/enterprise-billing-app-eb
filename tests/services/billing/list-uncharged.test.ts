import { beforeEach, describe, expect, it, vi } from "vitest";

// bm07-spec §Design/§Implementation §2. The Uncharged read: maps the joined
// EXCLUDED repository rows onto `UnchargedRow` — reason (`error_code`), the
// uncharged window (run period), and a `null` indicative value in v1.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listExcludedForRun: vi.fn() },
}));

import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { listUncharged } from "@/services/billing/read/list-uncharged";

const mockListExcluded = vi.mocked(billRunAccountRepository.listExcludedForRun);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listUncharged (bm07-spec §2)", () => {
  it("maps each EXCLUDED row onto an UnchargedRow with reason, window, and null indicative value", async () => {
    mockListExcluded.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        financialAccountId: "FIN00000001",
        accountName: "Acme Sdn Bhd",
        reason: "PARTIAL_PERIOD",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
      },
    ]);

    const rows = await listUncharged("BRN00000001");

    expect(rows).toEqual([
      {
        billingAccountId: "BAN00000001",
        financialAccountId: "FIN00000001",
        accountName: "Acme Sdn Bhd",
        reason: "PARTIAL_PERIOD",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
        indicativeValue: null,
      },
    ]);
  });

  it("falls back to PARTIAL_PERIOD when the stored reason is null", async () => {
    mockListExcluded.mockResolvedValue([
      {
        billingAccountId: "BAN00000002",
        financialAccountId: "FIN00000001",
        accountName: "Globex",
        reason: null,
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
      },
    ]);

    const [row] = await listUncharged("BRN00000001");
    expect(row?.reason).toBe("PARTIAL_PERIOD");
  });

  it("returns an empty array when nothing was excluded (positive empty state upstream)", async () => {
    mockListExcluded.mockResolvedValue([]);
    expect(await listUncharged("BRN00000001")).toEqual([]);
  });
});
