import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  formatUdrResource,
  parseUdrResource,
  udrResourceSchema,
} from "@/validation/rating/udr-resource.schema";

// rm25-spec §Implementation §5 — the udr_resource `state|district|date`
// contract (Inv 28). Pure-function tests, no database.

describe("udrResourceSchema", () => {
  it.each([
    ["full value", "Selangor|DIST-1|2026-01-01"],
    ["blank state", "|DIST-1|2026-01-01"],
    ["blank district", "Selangor||2026-01-01"],
    ["both blank", "||2026-01-01"],
  ])("accepts a %s", (_, value) => {
    expect(udrResourceSchema.safeParse(value).success).toBe(true);
  });

  it.each([
    ["two segments", "Selangor|2026-01-01"],
    ["four segments", "Selangor|DIST-1|X|2026-01-01"],
    ["a '|' inside a label", "Sel|angor|DIST-1|2026-01-01"],
    ["a non-ISO date", "Selangor|DIST-1|01/01/2026"],
    ["an impossible date", "Selangor|DIST-1|2026-02-30"],
    ["a whitespace-only state", "   |DIST-1|2026-01-01"],
    ["a whitespace-only district", "Selangor|\t|2026-01-01"],
  ])("rejects %s", (_, value) => {
    expect(udrResourceSchema.safeParse(value).success).toBe(false);
  });

  it("reports one issue, not a spurious date issue, for a malformed value", () => {
    const result = udrResourceSchema.safeParse("Selangor|DIST-1|2026-01-01\n");
    expect(result.error?.issues).toHaveLength(1);
  });
});

describe("blank-label rule (mirrors PRP's _geo_label / Python str.strip())", () => {
  it.each([
    ["U+0085 (NEL)", "\u0085"],
    ["U+001C (file separator)", "\u001c"],
  ])("treats %s as blank, as Python does", (_, label) => {
    expect(
      formatUdrResource({
        state: "Selangor",
        district: label,
        polygonStartDate: "2026-01-01",
      }),
    ).toBe("Selangor||2026-01-01");
  });

  it("keeps U+FEFF, which Python does not strip, as a label", () => {
    expect(
      formatUdrResource({
        state: "\u{FEFF}",
        district: "DIST-1",
        polygonStartDate: "2026-01-01",
      }),
    ).toBe("\u{FEFF}|DIST-1|2026-01-01");
  });
});

describe("formatUdrResource", () => {
  it("round-trips through parseUdrResource", () => {
    const parts = {
      state: "Selangor",
      district: "DIST-1",
      polygonStartDate: "2026-01-01",
    };
    const value = formatUdrResource(parts);
    expect(value).toBe("Selangor|DIST-1|2026-01-01");
    expect(parseUdrResource(value)).toEqual(parts);
  });

  it("round-trips blank labels as null", () => {
    const value = formatUdrResource({
      state: null,
      district: undefined,
      polygonStartDate: "2026-01-01",
    });
    expect(value).toBe("||2026-01-01");
    expect(parseUdrResource(value)).toEqual({
      state: null,
      district: null,
      polygonStartDate: "2026-01-01",
    });
  });

  it("writes a whitespace-only label as an empty segment", () => {
    expect(
      formatUdrResource({
        state: "   ",
        district: "\t",
        polygonStartDate: "2026-01-01",
      }),
    ).toBe("||2026-01-01");
  });

  it("keeps a label with inner spaces exactly", () => {
    const value = formatUdrResource({
      state: "KUALA LUMPUR",
      district: " Bukit Bintang ",
      polygonStartDate: "2026-01-01",
    });
    expect(value).toBe("KUALA LUMPUR| Bukit Bintang |2026-01-01");
    expect(parseUdrResource(value).state).toBe("KUALA LUMPUR");
    expect(parseUdrResource(value).district).toBe(" Bukit Bintang ");
  });

  it("throws on a '|' in the state label", () => {
    expect(() =>
      formatUdrResource({
        state: "Sel|angor",
        district: "DIST-1",
        polygonStartDate: "2026-01-01",
      }),
    ).toThrow(/state/);
  });

  it("throws on a '|' in the district label", () => {
    expect(() =>
      formatUdrResource({
        state: "Selangor",
        district: "DIST|1",
        polygonStartDate: "2026-01-01",
      }),
    ).toThrow(/district/);
  });

  it.each(["2026-02-30", "2026-1-01", "01/01/2026", ""])(
    "throws on an invalid date %j",
    (polygonStartDate) => {
      expect(() =>
        formatUdrResource({
          state: "Selangor",
          district: "DIST-1",
          polygonStartDate,
        }),
      ).toThrow(/polygonStartDate/);
    },
  );
});

describe("parseUdrResource", () => {
  it("throws on a value the schema rejects", () => {
    expect(() => parseUdrResource("Selangor|2026-01-01")).toThrow();
  });
});

describe("label preservation (bm48 D2)", () => {
  it("calls no trimming or case-changing method in its source", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../validation/rating/udr-resource.schema.ts"),
      "utf8",
    );
    expect(source).not.toMatch(
      /\.(trim\w*|to(Locale)?(Lower|Upper)Case|normalize)\s*\(/,
    );
  });
});
