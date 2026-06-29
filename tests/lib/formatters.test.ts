import { describe, expect, it } from "vitest";

import {
  formatDatetime,
  formatMoney,
  formatRelativeTime,
  groupConfigRows,
} from "@/lib/formatters";
import { DEFAULT_LOCALE } from "@/lib/locale";
import type { SystemConfigDisplayRow } from "@/types/system-config";

describe("formatDatetime", () => {
  it('returns "Never" for null with no fallback given', () => {
    expect(formatDatetime(null, DEFAULT_LOCALE, "UTC")).toBe("Never");
  });

  it("returns the custom fallback for null", () => {
    expect(formatDatetime(null, DEFAULT_LOCALE, "UTC", "N/A")).toBe("N/A");
  });

  it("formats a valid date in day-month-year, 24h, UTC order", () => {
    const result = formatDatetime(
      new Date("2026-06-15T09:32:00Z"),
      "en-GB",
      "UTC",
    );
    expect(result).toContain("Jun");
    expect(result).toContain("2026");
    expect(result).toContain("09:32");
  });

  // um28-spec §5: the locale wiring is proven live, not just defaulting.
  // The seeded `en-MY` produces the same behavior-preserving output as today's
  // `en-GB`. Assert each locale directly against the expected string rather
  // than comparing the two — a cross-locale equality couples the test to
  // ICU/CLDR data that can drift between runtime updates.
  it("renders the seeded en-MY locale in the expected behavior-preserving format", () => {
    const date = new Date("2026-03-09T07:05:00Z");
    expect(formatDatetime(date, "en-GB", "UTC")).toBe("09 Mar 2026, 07:05");
    expect(formatDatetime(date, "en-MY", "UTC")).toBe("09 Mar 2026, 07:05");
  });

  // ...and a non-en locale must genuinely differ, so a silently-inert
  // thread-through can't pass (`ms-MY` renders the month as "Mac").
  it("renders a non-en locale differently (ms-MY uses localized month names)", () => {
    const date = new Date("2026-03-09T07:05:00Z");
    const result = formatDatetime(date, "ms-MY", "UTC");
    expect(result).toContain("Mac");
    expect(result).not.toBe(formatDatetime(date, "en-GB", "UTC"));
  });

  // um29-spec §5: the same instant renders an 8-hour-shifted wall clock for
  // Asia/Kuala_Lumpur (UTC+8) vs UTC — proving the `timezone` thread-through
  // is live, not inert.
  it("shifts the wall clock by the configured zone (UTC+8 vs UTC)", () => {
    const date = new Date("2026-03-09T07:05:00Z");
    expect(formatDatetime(date, "en-GB", "UTC")).toBe("09 Mar 2026, 07:05");
    expect(formatDatetime(date, "en-GB", "Asia/Kuala_Lumpur")).toBe(
      "09 Mar 2026, 15:05",
    );
  });

  it("honors locale and timezone together", () => {
    const date = new Date("2026-03-09T20:05:00Z");
    // +08 pushes this past local midnight to 2026-03-10 04:05; ms-MY localizes
    // the (unchanged) month label to "Mac". Loose assertion to tolerate
    // locale-specific separators/ordering.
    const result = formatDatetime(date, "ms-MY", "Asia/Kuala_Lumpur");
    expect(result).toContain("Mac");
    expect(result).toContain("10");
    expect(result).toContain("04:05");
  });
});

describe("formatMoney", () => {
  // um28-spec §2.9: Intl.NumberFormat separates the currency symbol from the
  // amount with a non-breaking space (U+00A0), not an ASCII space — the test
  // must account for the exact codepoint.
  it("formats MYR for en-MY with the NBSP-separated RM symbol", () => {
    expect(formatMoney(1234.56, "en-MY", "MYR")).toBe("RM 1,234.56");
  });

  it("formats USD for en-US with no separator", () => {
    expect(formatMoney(1234.56, "en-US", "USD")).toBe("$1,234.56");
  });
});

describe("formatRelativeTime", () => {
  it('returns "just now" for the current instant', () => {
    expect(formatRelativeTime(new Date())).toBe("just now");
  });

  it("returns minutes ago", () => {
    const date = new Date(Date.now() - 5 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe("5 minutes ago");
  });

  it("returns hours ago", () => {
    const date = new Date(Date.now() - 3 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe("3 hours ago");
  });

  it("returns days ago", () => {
    const date = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    expect(formatRelativeTime(date)).toBe("2 days ago");
  });

  it("singularizes 1 minute/hour/day", () => {
    expect(formatRelativeTime(new Date(Date.now() - 60 * 1000))).toBe(
      "1 minute ago",
    );
    expect(formatRelativeTime(new Date(Date.now() - 60 * 60 * 1000))).toBe(
      "1 hour ago",
    );
    expect(formatRelativeTime(new Date(Date.now() - 24 * 60 * 60 * 1000))).toBe(
      "1 day ago",
    );
  });
});

function row(
  overrides: Partial<SystemConfigDisplayRow>,
): SystemConfigDisplayRow {
  return {
    configId: "id-1",
    configGroup: "app",
    configVersion: 1,
    configKey: "app_name",
    configValue: "Enterprise Billing System",
    description: null,
    isSecret: false,
    status: "ACTIVE",
    modifiedByUserId: null,
    modifiedByName: null,
    lastModifiedDatetime: new Date("2026-01-01T00:00:00Z"),
    ...overrides,
  };
}

describe("groupConfigRows", () => {
  it("returns [] for empty input", () => {
    expect(groupConfigRows([])).toEqual([]);
  });

  it("places all rows of one group under a single SystemConfigGroup", () => {
    const rows = [row({ configKey: "a" }), row({ configKey: "b" })];
    const result = groupConfigRows(rows);
    expect(result).toHaveLength(1);
    expect(result[0]?.group).toBe("app");
    expect(result[0]?.rows).toHaveLength(2);
  });

  it("creates two entries for two distinct groups, each with their own rows", () => {
    const rows = [
      row({ configGroup: "app", configKey: "a" }),
      row({ configGroup: "billing", configKey: "b" }),
    ];
    const result = groupConfigRows(rows);
    expect(result.map((g) => g.group)).toEqual(["app", "billing"]);
    expect(result[0]?.rows).toEqual([rows[0]]);
    expect(result[1]?.rows).toEqual([rows[1]]);
  });

  it("preserves intra-group row order (does not re-sort)", () => {
    const rows = [
      row({ configGroup: "app", configKey: "z" }),
      row({ configGroup: "app", configKey: "a" }),
    ];
    const result = groupConfigRows(rows);
    expect(result[0]?.rows.map((r) => r.configKey)).toEqual(["z", "a"]);
  });

  it("orders groups by first-appearance (insertion order)", () => {
    const rows = [
      row({ configGroup: "z", configKey: "k1" }),
      row({ configGroup: "a", configKey: "k2" }),
      row({ configGroup: "z", configKey: "k3" }),
    ];
    const result = groupConfigRows(rows);
    expect(result.map((g) => g.group)).toEqual(["z", "a"]);
  });
});
