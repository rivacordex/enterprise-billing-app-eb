import fs from "node:fs";
import path from "node:path";

import * as fc from "fast-check";
import { describe, expect, it } from "vitest";

import {
  RATE_CARD_FILE_HEADERS,
  RATE_CARD_HEADER_MAP,
  RATE_CARD_REJECT_SUMMARY_MAX_ISSUES,
  RATE_CARD_TABLE_COLUMNS,
  RATE_CARD_UPLOAD_VIOLATIONS,
  rateCardIssueSchema,
  rateCardRowKey,
  rateCardRowSchema,
  rejectSummarySchema,
  validateRateCardFile,
  type ParsedRateCardFile,
  type RateCardIssue,
} from "@/validation/product/ratecard.schema";

// pm58-spec I3 — the upload contract's pure tests, one per condition. No
// database, no parser, no file: every case is a function over already-parsed
// string cells.

// The ten D0 headers in their canonical order, and a well-formed data row
// aligned to them. Helpers below reorder/mutate copies of these.
const ORDERED_HEADERS = [
  "MNO Name",
  "Commercial Unit ID",
  "Polygon ID",
  "Polygon Start Date",
  "Polygon End Date",
  "State",
  "District",
  "Subscriber Reference ID",
  "Service Code",
  "Rate per Unit",
];

// A valid data row keyed by header text, so tests can reorder columns freely.
function validRowByHeader(): Record<string, string> {
  return {
    "MNO Name": "MNO-001",
    "Commercial Unit ID": "CU-001",
    "Polygon ID": "POLY-001",
    "Polygon Start Date": "2026-08-01",
    "Polygon End Date": "2026-12-31",
    State: "Selangor",
    District: "Petaling",
    "Subscriber Reference ID": "PRDINV00000001",
    "Service Code": "SVC1",
    "Rate per Unit": "0.0125",
  };
}

// Build a ParsedRateCardFile from a header order and a list of header-keyed
// rows, aligning each row's cells to the given header positions.
function fileFrom(
  headers: string[],
  rows: Record<string, string>[],
): ParsedRateCardFile {
  return {
    header: headers,
    rows: rows.map((row) => headers.map((h) => row[h] ?? "")),
  };
}

describe("rate-card upload contract (pm58)", () => {
  // I3.1 — the ten D0 headers, in any order, are accepted, and each maps to
  // its table column.
  it("accepts the ten headers in any order and maps each to its table column", () => {
    const shuffled = [...ORDERED_HEADERS].reverse();
    const result = validateRateCardFile(
      fileFrom(shuffled, [validRowByHeader()]),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows).toHaveLength(1);
      // Column-keyed output: MNO Name landed in mno_public_key, etc.
      expect(result.rows[0]).toMatchObject({
        mno_public_key: "MNO-001",
        commercial_unit_public_key: "CU-001",
        polygon_id: "POLY-001",
        polygon_start_date: "2026-08-01",
      });
    }
    // The map itself is the mapping under test.
    expect(RATE_CARD_HEADER_MAP["MNO Name"]).toBe("mno_public_key");
    expect(RATE_CARD_HEADER_MAP["Rate per Unit"]).toBe("rate_per_unit");
    expect(RATE_CARD_FILE_HEADERS).toHaveLength(10);
    expect(RATE_CARD_TABLE_COLUMNS).toHaveLength(10);
  });

  // I3.2 — an unknown column is rejected, not stripped, and the issue names
  // it. A `Date` column is one such case (D-A8).
  it("rejects an unknown column (e.g. Date), naming it, and never strips it", () => {
    const headers = [...ORDERED_HEADERS, "Date"];
    const row = { ...validRowByHeader(), Date: "2026-08-01" };
    const result = validateRateCardFile(fileFrom(headers, [row]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) => i.violation === "HEADER_MISMATCH" && i.column === "Date",
        ),
      ).toBe(true);
    }
  });

  // I3.3 — a missing expected column rejects the FILE as a contract change,
  // not as thousands of row errors.
  it("rejects the file (not each row) when an expected column is missing", () => {
    const headers = ORDERED_HEADERS.filter((h) => h !== "Polygon ID");
    const rows = Array.from({ length: 50 }, () => {
      const row = validRowByHeader();
      delete row["Polygon ID"];
      return row;
    });
    const result = validateRateCardFile(fileFrom(headers, rows));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues).toHaveLength(1);
      expect(result.issues[0]).toMatchObject({
        violation: "HEADER_MISMATCH",
        line: 1,
        column: "Polygon ID",
      });
    }
  });

  // A duplicated EXPECTED column is HEADER_MISMATCH — the parser preserves the
  // duplicate (pm59 D4) so it is rejected here, not silently collapsed to the
  // first occurrence. The unknown- and missing-header checks are unaffected.
  it("rejects a duplicated expected column as HEADER_MISMATCH", () => {
    const headers = [...ORDERED_HEADERS, "State"]; // "State" appears twice
    const result = validateRateCardFile(
      fileFrom(headers, [validRowByHeader()]),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dup = result.issues.filter(
        (i) => i.violation === "HEADER_MISMATCH" && i.column === "State",
      );
      expect(dup).toHaveLength(1);
      expect(dup[0]!.reason).toMatch(/duplicate/i);
      // The duplicate is not misreported as unknown or missing.
      expect(
        result.issues.some((i) => /Unknown column "State"/.test(i.reason)),
      ).toBe(false);
      expect(
        result.issues.some((i) =>
          /Missing required column "State"/.test(i.reason),
        ),
      ).toBe(false);
    }
  });

  // A duplicated UNKNOWN column is reported ONCE (not once per occurrence),
  // matching the single issue a duplicated expected column gets.
  it("reports a duplicated unknown column once, not once per occurrence", () => {
    const headers = [...ORDERED_HEADERS, "Foo", "Foo"];
    const row = { ...validRowByHeader(), Foo: "x" };
    const result = validateRateCardFile(fileFrom(headers, [row]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const foo = result.issues.filter(
        (i) => i.violation === "HEADER_MISMATCH" && i.column === "Foo",
      );
      expect(foo).toHaveLength(1);
    }
  });

  // A NUL byte can never be stored in a Postgres text column and is this
  // module's row-key delimiter, so a key cell containing one is rejected at
  // validation (ROW_SCHEMA_INVALID) rather than causing a false duplicate or an
  // opaque insert error. Built with String.fromCharCode to keep a literal NUL
  // out of the source file.
  it("rejects a key cell containing a NUL byte as ROW_SCHEMA_INVALID", () => {
    const nul = String.fromCharCode(0);
    const row = { ...validRowByHeader(), "MNO Name": `MNO${nul}001` };
    const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.issues.some(
          (i) =>
            i.violation === "ROW_SCHEMA_INVALID" &&
            i.column === "mno_public_key",
        ),
      ).toBe(true);
    }
  });

  // Date validity is a pure day-in-month check (proleptic-Gregorian leap rule),
  // so a validly-formatted date in ANY four-digit year is accepted (0099 must
  // not be rejected by the old Date.UTC two-digit-year mapping), and the
  // leap-year rule is applied correctly.
  it("accepts a valid date in any four-digit year and applies the leap-year rule", () => {
    for (const good of ["0099-01-01", "2024-02-29"]) {
      const row = { ...validRowByHeader(), "Polygon Start Date": good };
      expect(validateRateCardFile(fileFrom(ORDERED_HEADERS, [row])).ok).toBe(
        true,
      );
    }
    for (const bad of ["2026-02-29", "2023-02-29", "2026-04-31"]) {
      const row = { ...validRowByHeader(), "Polygon Start Date": bad };
      const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some(
            (i) =>
              i.violation === "ROW_SCHEMA_INVALID" &&
              i.column === "polygon_start_date",
          ),
        ).toBe(true);
      }
    }
  });

  // I3.4 — a case/spelling variant is HEADER_MISMATCH; a leading BOM and
  // whitespace around a header cell are accepted.
  it("treats a case/spelling variant as HEADER_MISMATCH", () => {
    const headers = ORDERED_HEADERS.map((h) =>
      h === "Polygon ID" ? "Polygon Id" : h,
    );
    const row = { ...validRowByHeader() };
    row["Polygon Id"] = row["Polygon ID"]!;
    delete row["Polygon ID"];
    const result = validateRateCardFile(fileFrom(headers, [row]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const cols = result.issues
        .filter((i) => i.violation === "HEADER_MISMATCH")
        .map((i) => i.column);
      expect(cols).toContain("Polygon Id"); // unknown
      expect(cols).toContain("Polygon ID"); // missing
    }
  });

  it("accepts a leading BOM on the first header cell and whitespace around headers", () => {
    const headers = [...ORDERED_HEADERS];
    headers[0] = `﻿${headers[0]}`; // BOM on first cell
    headers[3] = `  ${headers[3]}  `; // surrounding whitespace
    const result = validateRateCardFile(
      fileFrom(ORDERED_HEADERS, [validRowByHeader()]),
    );
    // sanity: the un-mutated header is fine
    expect(result.ok).toBe(true);
    // BOM + whitespace variant still matches (rows keyed to the mutated header)
    const row = validRowByHeader();
    const mutated: Record<string, string> = {};
    ORDERED_HEADERS.forEach((h, i) => {
      mutated[headers[i]!] = row[h]!;
    });
    const bomResult = validateRateCardFile(fileFrom(headers, [mutated]));
    expect(bomResult.ok).toBe(true);
  });

  // I3.5 — an empty or whitespace-only cell in each required column is
  // ROW_SCHEMA_INVALID, naming the column.
  it("rejects an empty or whitespace-only cell in each required column", () => {
    const requiredColumns = [
      "mno_public_key",
      "commercial_unit_public_key",
      "polygon_id",
      "polygon_start_date",
      "lkp_subscriber_ref_id",
    ];
    const requiredHeaders: Record<string, string> = {
      mno_public_key: "MNO Name",
      commercial_unit_public_key: "Commercial Unit ID",
      polygon_id: "Polygon ID",
      polygon_start_date: "Polygon Start Date",
      lkp_subscriber_ref_id: "Subscriber Reference ID",
    };
    for (const column of requiredColumns) {
      for (const blank of ["", "   "]) {
        const row = validRowByHeader();
        row[requiredHeaders[column]!] = blank;
        const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
        expect(result.ok).toBe(false);
        if (!result.ok) {
          expect(
            result.issues.some(
              (i) =>
                i.violation === "ROW_SCHEMA_INVALID" && i.column === column,
            ),
          ).toBe(true);
        }
      }
    }
  });

  // I3.6 — Polygon Start Date accepts a real YYYY-MM-DD and refuses other
  // shapes / impossible days.
  it("accepts a real YYYY-MM-DD Polygon Start Date and refuses variants", () => {
    const accept = "2026-08-01";
    const reject = ["01/08/2026", "2026-8-1", "2026-02-30", "2026-08-01T00:00"];

    const okRow = { ...validRowByHeader(), "Polygon Start Date": accept };
    expect(validateRateCardFile(fileFrom(ORDERED_HEADERS, [okRow])).ok).toBe(
      true,
    );

    for (const bad of reject) {
      const row = { ...validRowByHeader(), "Polygon Start Date": bad };
      const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(
          result.issues.some(
            (i) =>
              i.violation === "ROW_SCHEMA_INVALID" &&
              i.column === "polygon_start_date",
          ),
        ).toBe(true);
      }
    }
  });

  // I3.7 — a duplicate row key is refused, reporting BOTH line numbers.
  it("refuses a duplicate row key and reports both line numbers", () => {
    const rows = [
      validRowByHeader(), // line 2
      { ...validRowByHeader(), "Polygon Start Date": "2027-01-01" }, // line 3, same key
    ];
    const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, rows));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const dup = result.issues.find(
        (i) => i.violation === "DUPLICATE_ROW_KEY",
      );
      expect(dup).toBeDefined();
      // The duplicate is reported at the later line, and the reason carries
      // both line numbers (2 and 3) — one line number is half an answer.
      expect(dup!.line).toBe(3);
      expect(dup!.reason).toContain("line 2");
      expect(dup!.reason).toContain("line 3");
    }
  });

  // I3.8 — the key delimiter cannot be produced by concatenating two different
  // key tuples. Concrete examples first (the ("AB","C") vs ("A","BC") case a
  // naive `+` join would collide), then a property test over adversarial values.
  it("builds a collision-free row key across distinct tuples (property)", () => {
    // The exact collision a delimiter-less concatenation would produce.
    expect(rateCardRowKey("AB", "C", "x")).not.toBe(
      rateCardRowKey("A", "BC", "x"),
    );
    // An identical tuple always yields the same key (so real duplicates match).
    expect(rateCardRowKey("A", "B", "C")).toBe(rateCardRowKey("A", "B", "C"));

    const tuple = fc.tuple(fc.string(), fc.string(), fc.string());
    const counterexample = fc.check(
      fc.property(tuple, tuple, (a, b) => {
        const sameTuple = a[0] === b[0] && a[1] === b[1] && a[2] === b[2];
        const sameKey =
          rateCardRowKey(a[0], a[1], a[2]) === rateCardRowKey(b[0], b[1], b[2]);
        // Distinct tuples must never share a key; identical tuples always do.
        return sameKey === sameTuple;
      }),
      { numRuns: 2000 },
    );
    expect(counterexample.failed).toBe(false);
  });

  // I3.9 — an empty Rate per Unit or Service Code cell is accepted and stays
  // "": never coerced, never defaulted to 0. Rate per Unit range checks.
  it("accepts empty Rate per Unit / Service Code unchanged and never coerces to 0", () => {
    const row = {
      ...validRowByHeader(),
      "Rate per Unit": "",
      "Service Code": "",
    };
    const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]!.rate_per_unit).toBe("");
      expect(result.rows[0]!.service_code).toBe("");
    }
  });

  it("accepts in-range Rate per Unit values and refuses malformed ones", () => {
    for (const good of ["0", "0.0125", "123456789012.123456"]) {
      expect(
        rateCardRowSchema.safeParse({
          ...validColumnRow(),
          rate_per_unit: good,
        }).success,
      ).toBe(true);
    }
    for (const bad of ["-1", "1,000", "1e3", "0.1234567"]) {
      expect(
        rateCardRowSchema.safeParse({
          ...validColumnRow(),
          rate_per_unit: bad,
        }).success,
      ).toBe(false);
    }
  });

  // I3.10 — key cells keep leading zeros and inner spaces exactly as uploaded.
  it("stores key cells as-is: leading zeros and inner spaces are preserved", () => {
    const row = {
      ...validRowByHeader(),
      "MNO Name": "007",
      "Commercial Unit ID": "CU 12 34",
      "Polygon ID": "00POLY",
    };
    const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.rows[0]!.mno_public_key).toBe("007");
      expect(result.rows[0]!.commercial_unit_public_key).toBe("CU 12 34");
      expect(result.rows[0]!.polygon_id).toBe("00POLY");
    }
  });

  // I3.11 — the line number of the first data row is 2 (header is line 1).
  it("numbers the first data row as line 2", () => {
    const row = { ...validRowByHeader(), "Polygon Start Date": "not-a-date" };
    const result = validateRateCardFile(fileFrom(ORDERED_HEADERS, [row]));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.issues[0]!.line).toBe(2);
    }
  });

  // I3.12 — rejectSummarySchema truncates at 100, sets truncated, and reports
  // totalIssues accurately.
  it("bounds the reject summary at 100 with an accurate totalIssues and truncated flag", () => {
    const makeIssue = (line: number): RateCardIssue => ({
      violation: "ROW_SCHEMA_INVALID",
      line,
      column: "polygon_start_date",
      value: "bad",
      reason: "bad",
    });

    const many = Array.from({ length: 150 }, (_, i) => makeIssue(i + 2));
    const truncated = rejectSummarySchema.parse(many);
    expect(truncated.issues).toHaveLength(RATE_CARD_REJECT_SUMMARY_MAX_ISSUES);
    expect(truncated.totalIssues).toBe(150);
    expect(truncated.truncated).toBe(true);

    const few = Array.from({ length: 5 }, (_, i) => makeIssue(i + 2));
    const untruncated = rejectSummarySchema.parse(few);
    expect(untruncated.issues).toHaveLength(5);
    expect(untruncated.totalIssues).toBe(5);
    expect(untruncated.truncated).toBe(false);
  });

  // I3.13 — RateCardUploadViolation has exactly three members.
  it("has exactly three upload-violation members", () => {
    expect(RATE_CARD_UPLOAD_VIOLATIONS).toHaveLength(3);
    expect([...RATE_CARD_UPLOAD_VIOLATIONS]).toEqual([
      "HEADER_MISMATCH",
      "DUPLICATE_ROW_KEY",
      "ROW_SCHEMA_INVALID",
    ]);
  });

  // The RateCardIssue contract carries line · column · value · reason (+ the
  // classifying violation) — a self-check on the schema's shape.
  it("RateCardIssue carries line, column, value, reason and a violation", () => {
    const parsed = rateCardIssueSchema.safeParse({
      violation: "ROW_SCHEMA_INVALID",
      line: 2,
      column: "polygon_start_date",
      value: "bad",
      reason: "Must be a real calendar date in YYYY-MM-DD format.",
    });
    expect(parsed.success).toBe(true);
  });

  // I3.14 — the module imports NOTHING from db/**, services/** or a parser.
  // Proved by inspecting the module graph (the source's import specifiers),
  // not by eye.
  it("imports nothing from db/**, services/** or a parser package", () => {
    const source = fs.readFileSync(
      path.resolve(__dirname, "../../validation/product/ratecard.schema.ts"),
      "utf8",
    );
    const specifiers = [
      ...source.matchAll(/(?:import|export)[^'"\n]*from\s*["']([^"']+)["']/g),
    ].map((m) => m[1] ?? "");
    // The only import this file may have is Zod.
    expect(specifiers).toEqual(["zod"]);
    // Belt-and-braces: no db/service/parser specifier appears at all.
    for (const spec of specifiers) {
      expect(spec).not.toMatch(/@\/db\//);
      expect(spec).not.toMatch(/@\/services\//);
      expect(spec).not.toMatch(/csv|papaparse|parse/i);
    }
  });
});

// A valid column-keyed row for exercising rateCardRowSchema directly.
function validColumnRow() {
  return {
    mno_public_key: "MNO-001",
    commercial_unit_public_key: "CU-001",
    polygon_id: "POLY-001",
    polygon_start_date: "2026-08-01",
    polygon_end_date: "2026-12-31",
    state: "Selangor",
    district: "Petaling",
    lkp_subscriber_ref_id: "PRDINV00000001",
    service_code: "SVC1",
    rate_per_unit: "0.0125",
  };
}
