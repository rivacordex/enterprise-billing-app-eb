import { describe, expect, it } from "vitest";

import {
  formatDatetime,
  formatRelativeTime,
  groupConfigRows,
} from "@/lib/formatters";
import type { SystemConfigDisplayRow } from "@/types/system-config";

describe("formatDatetime", () => {
  it('returns "Never" for null with no fallback given', () => {
    expect(formatDatetime(null)).toBe("Never");
  });

  it("returns the custom fallback for null", () => {
    expect(formatDatetime(null, "N/A")).toBe("N/A");
  });

  it("formats a valid date in day-month-year, 24h, UTC order", () => {
    const result = formatDatetime(new Date("2026-06-15T09:32:00Z"));
    expect(result).toContain("Jun");
    expect(result).toContain("2026");
    expect(result).toContain("09:32");
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
