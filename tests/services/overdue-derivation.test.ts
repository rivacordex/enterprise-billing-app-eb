import { describe, expect, it, vi } from "vitest";

// Mock db/client so this module can be imported without DATABASE_URL.
// deriveOverdue is a pure function that never touches the DB.
vi.mock("@/db/client", () => ({ db: {} }));

import { deriveOverdue } from "@/services/accounts/get-billing-account-detail";

// ac05-spec §3.6 — overdue-derivation unit test.
// Tests the pure `deriveOverdue` function directly (no DB, no clock mocking
// via vi.setSystemTime — instead, `now` is passed as an explicit parameter).
describe("deriveOverdue", () => {
  const PAST_CHARGE = new Date("2026-01-01T00:00:00Z");
  const NOW = new Date("2026-07-28T00:00:00Z"); // well past 30 days

  it("returns false when openAR is zero", () => {
    expect(deriveOverdue(0n, PAST_CHARGE, 30, NOW)).toBe(false);
  });

  it("returns false when openAR is negative", () => {
    expect(deriveOverdue(-100n, PAST_CHARGE, 30, NOW)).toBe(false);
  });

  it("returns false when there is no open charge date", () => {
    expect(deriveOverdue(50000n, null, 30, NOW)).toBe(false);
  });

  it("returns true when openAR > 0 and now is past the due date", () => {
    // Charge on 2026-01-01, term 30 days → due 2026-01-31, now is 2026-07-28
    expect(deriveOverdue(50000n, PAST_CHARGE, 30, NOW)).toBe(true);
  });

  it("returns false when openAR > 0 but still within term", () => {
    const recentCharge = new Date("2026-07-20T00:00:00Z");
    const nowSoon = new Date("2026-07-25T00:00:00Z"); // only 5 days later
    expect(deriveOverdue(50000n, recentCharge, 30, nowSoon)).toBe(false);
  });

  it("returns false when now equals the exact due date (not strictly after)", () => {
    const chargeDate = new Date("2026-07-01T00:00:00Z");
    const dueDate = new Date("2026-07-31T00:00:00Z"); // 30 days later
    expect(deriveOverdue(50000n, chargeDate, 30, dueDate)).toBe(false);
  });

  it("returns true the moment now exceeds the due date", () => {
    const chargeDate = new Date("2026-07-01T00:00:00Z");
    const oneSecondAfterDue = new Date("2026-07-31T00:00:01Z");
    expect(deriveOverdue(50000n, chargeDate, 30, oneSecondAfterDue)).toBe(true);
  });

  it("handles a zero payment term (same-day due)", () => {
    const charge = new Date("2026-07-01T00:00:00Z");
    const oneSecondLater = new Date("2026-07-01T00:00:01Z");
    expect(deriveOverdue(1n, charge, 0, oneSecondLater)).toBe(true);
  });

  it("handles a large payment-due-days override correctly", () => {
    const charge = new Date("2026-01-01T00:00:00Z");
    // 365 days → due 2027-01-01, now is 2026-07-28 → not overdue
    expect(deriveOverdue(50000n, charge, 365, NOW)).toBe(false);
  });
});
