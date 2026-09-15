import { beforeEach, describe, expect, it, vi } from "vitest";

// bm07-spec §Design/§Implementation §2, REDEFINED by bm32 §Implementation §1
// (Inv #22). The Uncharged read now maps the joined "no charge line / nets to
// zero" repository rows onto `UnchargedRow`: the reason is a billing-outcome
// label derived from the line count (`NO_CHARGE_LINES` / `NETS_TO_ZERO`), the
// uncharged window is the run period, and the indicative value is `null`.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/db/repositories/billing/bill-run-account.repository", () => ({
  billRunAccountRepository: { listUnchargedForRun: vi.fn() },
}));

import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { listUncharged } from "@/services/billing/read/list-uncharged";

const mockListUncharged = vi.mocked(
  billRunAccountRepository.listUnchargedForRun,
);

beforeEach(() => {
  vi.clearAllMocks();
});

describe("listUncharged (bm32-spec §1)", () => {
  it("labels an account with no charge line NO_CHARGE_LINES", async () => {
    mockListUncharged.mockResolvedValue([
      {
        billingAccountId: "BAN00000001",
        financialAccountId: "FIN00000001",
        accountName: "Acme Sdn Bhd",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
        lineCount: 0,
      },
    ]);

    const rows = await listUncharged("BRN00000001");

    expect(rows).toEqual([
      {
        billingAccountId: "BAN00000001",
        financialAccountId: "FIN00000001",
        accountName: "Acme Sdn Bhd",
        reason: "NO_CHARGE_LINES",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
        indicativeValue: null,
      },
    ]);
  });

  it("labels an account whose lines net to zero NETS_TO_ZERO", async () => {
    mockListUncharged.mockResolvedValue([
      {
        billingAccountId: "BAN00000002",
        financialAccountId: "FIN00000001",
        accountName: "Globex",
        windowStart: "2026-07-01",
        windowEnd: "2026-07-31",
        lineCount: 2,
      },
    ]);

    const [row] = await listUncharged("BRN00000001");
    expect(row?.reason).toBe("NETS_TO_ZERO");
  });

  it("returns an empty array when every scoped account was billed", async () => {
    mockListUncharged.mockResolvedValue([]);
    expect(await listUncharged("BRN00000001")).toEqual([]);
  });
});
