import { describe, expect, it } from "vitest";

import { isStalled } from "@/services/billing/stall";

// bm12-spec §Design/§Implementation §3, architecture Inv. #10. Pure,
// total: STALLED is derived on read from `status = 'PROCESSING'` and
// `now() - last_progress_at` versus the configured threshold — never stored.

const NOW = new Date("2026-08-24T12:00:00.000Z");
const THRESHOLD_MINUTES = 30;

describe("isStalled (bm12-spec §3)", () => {
  it("is not stalled just under the threshold", () => {
    const lastProgressAt = new Date(NOW.getTime() - 29 * 60_000);
    expect(
      isStalled(
        { status: "PROCESSING", lastProgressAt },
        NOW,
        THRESHOLD_MINUTES,
      ),
    ).toBe(false);
  });

  it("is not stalled exactly at the threshold", () => {
    const lastProgressAt = new Date(NOW.getTime() - 30 * 60_000);
    expect(
      isStalled(
        { status: "PROCESSING", lastProgressAt },
        NOW,
        THRESHOLD_MINUTES,
      ),
    ).toBe(false);
  });

  it("is stalled just over the threshold", () => {
    const lastProgressAt = new Date(NOW.getTime() - 31 * 60_000);
    expect(
      isStalled(
        { status: "PROCESSING", lastProgressAt },
        NOW,
        THRESHOLD_MINUTES,
      ),
    ).toBe(true);
  });

  it("is never stalled for a non-PROCESSING run, however old the heartbeat", () => {
    const lastProgressAt = new Date(NOW.getTime() - 10_000 * 60_000);
    for (const status of [
      "SCHEDULED",
      "PROCESSED",
      "APPROVED",
      "POSTING",
      "INVOICED",
      "DISTRIBUTING",
      "COMPLETED",
      "PROCESSING_FAILED",
      "DISTRIBUTION_FAILED",
      "CANCELLED",
    ] as const) {
      expect(
        isStalled({ status, lastProgressAt }, NOW, THRESHOLD_MINUTES),
      ).toBe(false);
    }
  });

  it("is not stalled when there is no heartbeat at all (structurally inconsistent, not a crash)", () => {
    expect(
      isStalled(
        { status: "PROCESSING", lastProgressAt: null },
        NOW,
        THRESHOLD_MINUTES,
      ),
    ).toBe(false);
  });
});
