import { describe, expect, it } from "vitest";

import {
  currentDuePeriod,
  firstOfMonth,
} from "@/services/billing/derive-periods";

// bm02-spec §4/§8. Pure window-derivation unit tests: the monthly in-arrears
// window for cycle_day 1 / 15 / 28, the none-due-yet null, and month/year
// boundaries. `scheduled_run_date = period_end + 1`; a period is due when
// `scheduled_run_date <= today`; only THIS month's cycle-day is considered
// (no backfill), so `today` before the cycle day yields null.

describe("currentDuePeriod (bm02-spec §4)", () => {
  it("cycle_day 1 on the run date materializes the just-closed month", () => {
    // Overview: the 1–31 July run appears on 1 August as SCHEDULED.
    expect(currentDuePeriod(1, "2026-08-01")).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      scheduledRunDate: "2026-08-01",
    });
  });

  it("cycle_day 1 mid-month still resolves to the same just-closed period", () => {
    // The next period (Aug 1–31, scheduled Sep 1) is not yet due.
    expect(currentDuePeriod(1, "2026-08-15")).toEqual({
      periodStart: "2026-07-01",
      periodEnd: "2026-07-31",
      scheduledRunDate: "2026-08-01",
    });
  });

  it("cycle_day 15 in-arrears window (today after the run date)", () => {
    expect(currentDuePeriod(15, "2026-08-19")).toEqual({
      periodStart: "2026-07-15",
      periodEnd: "2026-08-14",
      scheduledRunDate: "2026-08-15",
    });
  });

  it("cycle_day 15 returns null before this month's run date (none due yet)", () => {
    expect(currentDuePeriod(15, "2026-08-10")).toBeNull();
  });

  it("cycle_day 28 on the run date", () => {
    expect(currentDuePeriod(28, "2026-08-28")).toEqual({
      periodStart: "2026-07-28",
      periodEnd: "2026-08-27",
      scheduledRunDate: "2026-08-28",
    });
  });

  it("cycle_day 28 returns null before the 28th (no backfill of an un-opened month)", () => {
    expect(currentDuePeriod(28, "2026-08-19")).toBeNull();
  });

  it("crosses the year boundary — a January run reaches back to the prior December", () => {
    expect(currentDuePeriod(15, "2026-01-20")).toEqual({
      periodStart: "2025-12-15",
      periodEnd: "2026-01-14",
      scheduledRunDate: "2026-01-15",
    });
  });

  it("returns null in January before the run date (none due yet, year boundary)", () => {
    expect(currentDuePeriod(15, "2026-01-10")).toBeNull();
  });

  it("cycle_day 28 across February (short month) computes period_end = run date − 1", () => {
    expect(currentDuePeriod(28, "2026-03-28")).toEqual({
      periodStart: "2026-02-28",
      periodEnd: "2026-03-27",
      scheduledRunDate: "2026-03-28",
    });
  });

  it("is total — a malformed today yields null rather than throwing", () => {
    expect(currentDuePeriod(15, "not-a-date")).toBeNull();
  });
});

// bm03-spec §1/§6 — period_partition is the 1st of the run's period month,
// fixed at snapshot time. Verified for a mid-month, month-start, and
// cross-month rerun (§9's "period_partition = 1st of period_start even for a
// cross-month rerun" check).
describe("firstOfMonth (bm03-spec §1)", () => {
  it("returns the 1st of the month for a mid-month date", () => {
    expect(firstOfMonth("2026-07-15")).toBe("2026-07-01");
  });

  it("is idempotent for a date already on the 1st", () => {
    expect(firstOfMonth("2026-07-01")).toBe("2026-07-01");
  });

  it("stays anchored to the ORIGINAL period_start's month across a cross-month rerun", () => {
    // A run whose period_start is July stays July-partitioned even if the
    // rerun itself happens in August or later — the caller always passes the
    // run's stored period_start, never "today".
    expect(firstOfMonth("2026-07-31")).toBe("2026-07-01");
  });
});
