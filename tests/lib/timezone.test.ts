import { describe, expect, it } from "vitest";

import { isSupportedTimezone, SUPPORTED_TIMEZONES } from "@/lib/locale";
import {
  formatZoneSuffix,
  formatZoneTimestamp,
  formatZoneWallClock,
  getZoneOffsetMinutes,
  localDayToUtcBounds,
} from "@/lib/timezone";

// um29-spec §2.8 / §5. The helper is the reusable boundary primitive for
// future "today"/cut-off features (billing runs), so it is unit-tested in
// isolation. DST is NOT tested (out of scope, §2.2) — no transition-day
// assertions.

describe("localDayToUtcBounds", () => {
  it("converts a local day to UTC bounds for Asia/Kuala_Lumpur (UTC+8)", () => {
    const { start, end } = localDayToUtcBounds(
      "2026-06-27",
      "Asia/Kuala_Lumpur",
    );
    expect(start.toISOString()).toBe("2026-06-26T16:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-27T15:59:59.999Z");
  });

  it("handles the half-hour offset for Asia/Kolkata (UTC+5:30)", () => {
    const { start, end } = localDayToUtcBounds("2026-06-27", "Asia/Kolkata");
    expect(start.toISOString()).toBe("2026-06-26T18:30:00.000Z");
    expect(end.toISOString()).toBe("2026-06-27T18:29:59.999Z");
  });

  it("is the identity for the UTC zone", () => {
    const { start, end } = localDayToUtcBounds("2026-06-27", "UTC");
    expect(start.toISOString()).toBe("2026-06-27T00:00:00.000Z");
    expect(end.toISOString()).toBe("2026-06-27T23:59:59.999Z");
  });

  // um29-spec §2.6: the helper is total — it never throws for any valid
  // YYYY-MM-DD across every supported zone, preserving um24's "never 500s"
  // lenient-filter contract.
  it("never throws for any valid YYYY-MM-DD across every supported zone", () => {
    for (const zone of SUPPORTED_TIMEZONES) {
      expect(() => localDayToUtcBounds("2026-06-27", zone)).not.toThrow();
      expect(() => localDayToUtcBounds("2026-01-01", zone)).not.toThrow();
      expect(() => localDayToUtcBounds("2026-12-31", zone)).not.toThrow();
    }
  });
});

describe("isSupportedTimezone", () => {
  it("accepts every entry in SUPPORTED_TIMEZONES", () => {
    for (const zone of SUPPORTED_TIMEZONES) {
      expect(isSupportedTimezone(zone)).toBe(true);
    }
  });

  it("rejects an unknown / misspelled string", () => {
    expect(isSupportedTimezone("Mars/Olympus")).toBe(false);
    expect(isSupportedTimezone("+08")).toBe(false);
    expect(isSupportedTimezone("")).toBe(false);
  });
});

describe("getZoneOffsetMinutes", () => {
  const instant = new Date("2026-06-27T00:00:00.000Z");

  it("returns +480 for UTC+8", () => {
    expect(getZoneOffsetMinutes(instant, "Asia/Kuala_Lumpur")).toBe(480);
  });

  it("returns +330 for the half-hour UTC+5:30 zone", () => {
    expect(getZoneOffsetMinutes(instant, "Asia/Kolkata")).toBe(330);
  });

  it("returns 0 for UTC", () => {
    expect(getZoneOffsetMinutes(instant, "UTC")).toBe(0);
  });
});

describe("formatZoneSuffix", () => {
  const instant = new Date("2026-06-27T00:00:00.000Z");

  it("returns the Intl shortOffset for an integer-offset zone", () => {
    expect(formatZoneSuffix(instant, "Asia/Kuala_Lumpur")).toBe("GMT+8");
  });

  it("returns the half-hour shortOffset for Asia/Kolkata", () => {
    expect(formatZoneSuffix(instant, "Asia/Kolkata")).toBe("GMT+5:30");
  });

  it("special-cases UTC to the literal 'UTC' (no GMT rewrite)", () => {
    expect(formatZoneSuffix(instant, "UTC")).toBe("UTC");
  });
});

describe("formatZoneWallClock / formatZoneTimestamp", () => {
  const instant = new Date("2026-06-17T09:14:22.000Z");

  it("renders the local wall-clock as YYYY-MM-DD HH:mm:ss", () => {
    expect(formatZoneWallClock(instant, "Asia/Kuala_Lumpur")).toBe(
      "2026-06-17 17:14:22",
    );
  });

  it("for UTC is byte-identical to the ISO instant truncated to seconds", () => {
    expect(formatZoneWallClock(instant, "UTC")).toBe("2026-06-17 09:14:22");
  });

  it("appends the literal ' UTC' suffix for the UTC zone", () => {
    expect(formatZoneTimestamp(instant, "UTC")).toBe("2026-06-17 09:14:22 UTC");
  });

  it("appends the parenthesized offset suffix for a non-UTC zone", () => {
    expect(formatZoneTimestamp(instant, "Asia/Kuala_Lumpur")).toBe(
      "2026-06-17 17:14:22 (GMT+8)",
    );
  });
});
