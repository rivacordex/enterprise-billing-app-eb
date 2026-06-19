import { describe, expect, it } from "vitest";

import { formatDatetime } from "@/lib/formatters";

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
