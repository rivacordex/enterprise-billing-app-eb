import { describe, expect, it } from "vitest";

import { isPartialPeriod } from "@/services/billing/partial-period";

// bm03-spec §Design (resolved decision #4) / §Implementation §6/§9. Strict
// partial-period rule: a start on period_start or a cease on period_end is
// full-period, not excluded.

const WINDOW = { periodStart: "2026-07-01", periodEnd: "2026-07-31" };

describe("isPartialPeriod (bm03-spec §Design)", () => {
  it("is full-period for a subscription spanning the whole window", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: null }],
        transitions: [],
      }),
    ).toBe(false);
  });

  it("excludes a subscription that started strictly after period_start", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-07-15", endDate: null }],
        transitions: [],
      }),
    ).toBe(true);
  });

  it("is full-period when the subscription starts exactly on period_start (strict boundary)", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-07-01", endDate: null }],
        transitions: [],
      }),
    ).toBe(false);
  });

  it("excludes a subscription that ceased strictly before period_end", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: "2026-07-15" }],
        transitions: [],
      }),
    ).toBe(true);
  });

  it("is full-period when the subscription ceases exactly on period_end (strict boundary)", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: "2026-07-31" }],
        transitions: [],
      }),
    ).toBe(false);
  });

  it("ignores an end_date that already ended before the window began", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: "2026-06-15" }],
        transitions: [],
      }),
    ).toBe(false);
  });

  it("excludes an account with a SUSPENDED transition strictly inside the window", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: null }],
        transitions: [
          {
            fromStatus: "ACTIVE",
            toStatus: "SUSPENDED",
            effectiveDate: "2026-07-15",
          },
        ],
      }),
    ).toBe(true);
  });

  it("excludes an account with a resume (SUSPENDED → ACTIVE) transition strictly inside the window", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: null }],
        transitions: [
          {
            fromStatus: "SUSPENDED",
            toStatus: "ACTIVE",
            effectiveDate: "2026-07-20",
          },
        ],
      }),
    ).toBe(true);
  });

  it("is full-period when a transition falls exactly on a window boundary (strict interior only)", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: null }],
        transitions: [
          {
            fromStatus: "ACTIVE",
            toStatus: "SUSPENDED",
            effectiveDate: "2026-07-01",
          },
          {
            fromStatus: "SUSPENDED",
            toStatus: "ACTIVE",
            effectiveDate: "2026-07-31",
          },
        ],
      }),
    ).toBe(false);
  });

  it("ignores an unrelated transition type (e.g. TERMINATED)", () => {
    expect(
      isPartialPeriod({
        ...WINDOW,
        subscriptions: [{ startDate: "2026-01-01", endDate: "2026-07-31" }],
        transitions: [
          {
            fromStatus: "ACTIVE",
            toStatus: "TERMINATED",
            effectiveDate: "2026-07-31",
          },
        ],
      }),
    ).toBe(false);
  });

  it("is full-period for an account with no subscriptions or transitions", () => {
    expect(
      isPartialPeriod({ ...WINDOW, subscriptions: [], transitions: [] }),
    ).toBe(false);
  });
});
