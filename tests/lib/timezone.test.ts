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
// isolation. DST transition days ARE now asserted (post-v1 follow-up to the
// §2.2 single-offset approximation): the boundary helper samples the zone
// offset at the resolved instant, so a day that straddles a spring-forward /
// fall-back transition still maps to the correct UTC instants.

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

  // DST transition days — the cases the old single-offset helper got wrong by
  // one hour. Australia/Sydney is the clearest: its day-start straddles the
  // 02:00-local transition (true local midnight is on the other side of the
  // switch from the wall-clock-as-UTC guess), so a one-offset helper is off by
  // an hour; the two-pass helper lands on the correct instant.
  it("handles Australia/Sydney spring-forward (2026-10-04, AEST→AEDT)", () => {
    const { start, end } = localDayToUtcBounds(
      "2026-10-04",
      "Australia/Sydney",
    );
    // 00:00 local is still AEST (UTC+10) — the switch is at 02:00.
    expect(start.toISOString()).toBe("2026-10-03T14:00:00.000Z");
    // 23:59:59.999 local is AEDT (UTC+11) — after the switch.
    expect(end.toISOString()).toBe("2026-10-04T12:59:59.999Z");
  });

  it("handles Australia/Sydney fall-back (2026-04-05, AEDT→AEST)", () => {
    const { start, end } = localDayToUtcBounds(
      "2026-04-05",
      "Australia/Sydney",
    );
    // 00:00 local is still AEDT (UTC+11) — the switch is at 03:00.
    expect(start.toISOString()).toBe("2026-04-04T13:00:00.000Z");
    // 23:59:59.999 local is AEST (UTC+10) — after the switch.
    expect(end.toISOString()).toBe("2026-04-05T13:59:59.999Z");
  });

  it("handles America/New_York spring-forward (2026-03-08, EST→EDT)", () => {
    const { start, end } = localDayToUtcBounds(
      "2026-03-08",
      "America/New_York",
    );
    // 00:00 local is EST (UTC-5); 23:59:59.999 is EDT (UTC-4) — switch at 02:00.
    expect(start.toISOString()).toBe("2026-03-08T05:00:00.000Z");
    expect(end.toISOString()).toBe("2026-03-09T03:59:59.999Z");
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

  // The offset reflects DST for the given instant: America/New_York is EST
  // (UTC-5, -300) in winter and EDT (UTC-4, -240) in summer.
  it("reflects DST for the queried instant (America/New_York)", () => {
    expect(
      getZoneOffsetMinutes(
        new Date("2026-01-15T00:00:00.000Z"),
        "America/New_York",
      ),
    ).toBe(-300);
    expect(
      getZoneOffsetMinutes(
        new Date("2026-07-15T00:00:00.000Z"),
        "America/New_York",
      ),
    ).toBe(-240);
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
