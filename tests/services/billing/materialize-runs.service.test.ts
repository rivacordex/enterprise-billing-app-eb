import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm02-spec §4/§8. Materialize service behavior (the DB-constraint idempotency
// under true concurrency is proven separately in the integration suite). Here
// we assert: only active MONTHLY cycles with a due period produce an insert
// row; non-monthly cycles are skipped; a BILL_RUN_MATERIALIZED audit row is
// written ONLY for rows actually inserted; a no-op load writes zero audit
// rows. `db.transaction` runs its callback with a stub tx.

const txStub = {};
vi.mock("@/db/client", () => ({
  db: {
    transaction: vi.fn((cb: (tx: unknown) => unknown) => cb(txStub)),
  },
}));
vi.mock("@/db/repositories/accounts/bill-cycle.repository", () => ({
  billCycleRepository: { findAllActive: vi.fn() },
}));
vi.mock("@/db/repositories/billing/bill-run.repository", () => ({
  billRunRepository: { insertMissingRuns: vi.fn() },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppTimezone: vi.fn(() => "UTC"),
}));

import { billCycleRepository } from "@/db/repositories/accounts/bill-cycle.repository";
import { billRunRepository } from "@/db/repositories/billing/bill-run.repository";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { materializeDueRuns } from "@/services/billing/materialize-runs";

const mockFindAllActive = vi.mocked(billCycleRepository.findAllActive);
const mockInsertMissingRuns = vi.mocked(billRunRepository.insertMissingRuns);
const mockInsertAuditEvent = vi.mocked(insertAuditEvent);

function cycle(overrides: Record<string, unknown> = {}) {
  return {
    billCycleId: "BCY00000001",
    name: "Enterprise Monthly",
    description: null,
    frequency: "monthly",
    cycleDay: 15,
    paymentDueDays: 30,
    state: "active",
    lastModified: new Date("2026-01-01T00:00:00Z"),
    lastEditedBy: null,
    ...overrides,
  } as never;
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  // Business "today" = 2026-08-19 (UTC). cycle_day 15 → due (Aug 15 ≤ 19).
  vi.setSystemTime(new Date("2026-08-19T09:00:00Z"));
  mockInsertMissingRuns.mockResolvedValue([]);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("materializeDueRuns (bm02-spec §4)", () => {
  it("builds the due period for an active monthly cycle and audits each inserted run", async () => {
    mockFindAllActive.mockResolvedValue([cycle()]);
    mockInsertMissingRuns.mockResolvedValue([
      {
        billRunId: "BRN00000001",
        refBillCycleId: "BCY00000001",
        periodStart: "2026-07-15",
        periodEnd: "2026-08-14",
        scheduledRunDate: "2026-08-15",
      },
    ]);

    await materializeDueRuns();

    expect(mockInsertMissingRuns).toHaveBeenCalledWith(txStub, [
      {
        refBillCycleId: "BCY00000001",
        periodStart: "2026-07-15",
        periodEnd: "2026-08-14",
        scheduledRunDate: "2026-08-15",
      },
    ]);
    expect(mockInsertAuditEvent).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditEvent).toHaveBeenCalledWith(
      txStub,
      expect.objectContaining({
        eventType: "BILL_RUN_MATERIALIZED",
        actorUserId: null,
        targetEntity: "bill_run",
        targetId: "BRN00000001",
      }),
    );
  });

  it("writes ZERO audit rows on a no-op load (nothing inserted)", async () => {
    mockFindAllActive.mockResolvedValue([cycle()]);
    mockInsertMissingRuns.mockResolvedValue([]); // ON CONFLICT DO NOTHING

    await materializeDueRuns();

    expect(mockInsertMissingRuns).toHaveBeenCalledTimes(1);
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("skips non-monthly cycles (never inserts, never audits)", async () => {
    mockFindAllActive.mockResolvedValue([
      cycle({ frequency: "quarterly", cycleDay: 1 }),
    ]);

    await materializeDueRuns();

    expect(mockInsertMissingRuns).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });

  it("skips a monthly cycle whose run date has not yet arrived (none due yet)", async () => {
    // cycle_day 28 on 2026-08-19 → Aug 28 not reached → null → no insert.
    mockFindAllActive.mockResolvedValue([cycle({ cycleDay: 28 })]);

    await materializeDueRuns();

    expect(mockInsertMissingRuns).not.toHaveBeenCalled();
    expect(mockInsertAuditEvent).not.toHaveBeenCalled();
  });
});
