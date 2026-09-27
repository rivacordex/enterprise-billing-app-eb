import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { RATE_CARD_HEADER_MAP } from "@/validation/product/ratecard.schema";
import { parseRateCardCsv } from "@/services/product/ratecard/parse-csv";

// pm59-spec I4 — the parser's tests. Fixtures are built in-code from pm58's
// header map (the ONLY spelling of the ten header strings, pm58 I1); a small
// helper joins its keys. No 5,400-row file is committed; one generated
// few-hundred-row file proves the buffered path.

const REPO_ROOT = path.resolve(__dirname, "../..");
const PARSER_RELATIVE = "services/product/ratecard/parse-csv.ts";

// The ten OR7′ headers, taken from the imported map — never typed out again.
const HEADER_CELLS = Object.keys(RATE_CARD_HEADER_MAP);

// One well-formed cell per header, in header order.
const DEFAULT_ROW: Record<string, string> = {
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

function dataLine(overrides: Partial<Record<string, string>> = {}): string {
  return HEADER_CELLS.map((h) =>
    h in overrides ? (overrides[h] ?? "") : (DEFAULT_ROW[h] ?? ""),
  ).join(",");
}

// A file with the standard ten-column header and the given raw data lines.
function csv(dataLines: string[]): Buffer {
  return Buffer.from([HEADER_CELLS.join(","), ...dataLines].join("\n"), "utf8");
}

// A file with an explicit (possibly wrong) header and raw data lines.
function csvWith(headerCells: string[], dataLines: string[]): Buffer {
  return Buffer.from([headerCells.join(","), ...dataLines].join("\n"), "utf8");
}

function collectSourceFiles(dir: string): string[] {
  const SKIP = new Set([
    "node_modules",
    ".next",
    ".git",
    "dist",
    "coverage",
    ".turbo",
  ]);
  if (!fs.existsSync(dir)) return [];
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP.has(entry.name)) continue;
      out.push(...collectSourceFiles(path.join(dir, entry.name)));
    } else if (/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("rate-card CSV parser (pm59)", () => {
  // I4.1 — every cell is a string.
  it("returns every cell as a string", () => {
    const result = parseRateCardCsv(csv([dataLine(), dataLine()]));
    expect(result.rows).toHaveLength(2);
    for (const row of result.rows) {
      for (const value of Object.values(row.cells)) {
        expect(typeof value).toBe("string");
      }
    }
  });

  // I4.2 — an empty cell arrives as "" and never 0/null/undefined.
  it("preserves an empty cell as '' (never 0/null/undefined)", () => {
    const result = parseRateCardCsv(
      csv([dataLine({ "Rate per Unit": "", "Service Code": "" })]),
    );
    const cells = result.rows[0]!.cells;
    expect(cells["Rate per Unit"]).toBe("");
    expect(cells["Service Code"]).toBe("");
    expect(cells["Rate per Unit"]).not.toBe(0);
    expect(cells["Rate per Unit"]).not.toBeNull();
    expect(cells["Rate per Unit"]).not.toBeUndefined();
  });

  // I4.3 — a whitespace-only cell is preserved, not trimmed away.
  it("preserves a whitespace-only cell untrimmed", () => {
    const result = parseRateCardCsv(csv([dataLine({ "Service Code": "   " })]));
    expect(result.rows[0]!.cells["Service Code"]).toBe("   ");
  });

  // I4.4 — "0" is the string "0", distinguishable from "".
  it("keeps '0' as the string '0', distinct from ''", () => {
    const result = parseRateCardCsv(csv([dataLine({ "Rate per Unit": "0" })]));
    expect(result.rows[0]!.cells["Rate per Unit"]).toBe("0");
  });

  // I4.5 — a missing column is visible in the returned header; the parser
  // fills nothing.
  it("surfaces a missing column in the header and fills nothing", () => {
    const headerCells = HEADER_CELLS.filter((h) => h !== "Polygon End Date");
    const line = headerCells.map((h) => DEFAULT_ROW[h] ?? "").join(",");
    const result = parseRateCardCsv(csvWith(headerCells, [line]));
    expect(result.header).not.toContain("Polygon End Date");
    expect(result.header).toHaveLength(9);
    expect("Polygon End Date" in result.rows[0]!.cells).toBe(false);
  });

  // I4.6 — a duplicate header is visible, not silently de-duplicated.
  it("surfaces a duplicate header rather than de-duplicating it", () => {
    const headerCells = [...HEADER_CELLS, "State"]; // State appears twice
    const line = headerCells.map((h) => DEFAULT_ROW[h] ?? "").join(",");
    const result = parseRateCardCsv(csvWith(headerCells, [line]));
    expect(result.header.filter((h) => h === "State")).toHaveLength(2);
  });

  // I4.7 — a leading-zero key survives unmangled.
  it("preserves a leading-zero key ('007' stays '007')", () => {
    const result = parseRateCardCsv(
      csv([dataLine({ "Polygon ID": "007", "MNO Name": "00MNO" })]),
    );
    expect(result.rows[0]!.cells["Polygon ID"]).toBe("007");
    expect(result.rows[0]!.cells["MNO Name"]).toBe("00MNO");
  });

  // I4.8 — a date-shaped cell stays a string, and no Date is constructed
  // anywhere in the module.
  it("keeps a date-shaped cell as a string and constructs no Date", () => {
    const result = parseRateCardCsv(csv([dataLine()]));
    expect(typeof result.rows[0]!.cells["Polygon Start Date"]).toBe("string");
    expect(result.rows[0]!.cells["Polygon Start Date"]).toBe("2026-08-01");

    const source = fs.readFileSync(
      path.join(REPO_ROOT, PARSER_RELATIVE),
      "utf8",
    );
    expect(source).not.toMatch(/new\s+Date\b/);
    expect(source).not.toMatch(/\bDate\.(now|parse|UTC)\b/);
  });

  // I4.9 — the first data row is line 2; a 10-row file reports lines 2–11.
  it("numbers the first data row as line 2 (10 rows → 2..11)", () => {
    const result = parseRateCardCsv(
      csv(Array.from({ length: 10 }, () => dataLine())),
    );
    expect(result.rows.map((r) => r.line)).toEqual([
      2, 3, 4, 5, 6, 7, 8, 9, 10, 11,
    ]);
  });

  // I4.10 — a quoted comma and an embedded newline parse correctly.
  it("parses a quoted comma and an embedded newline correctly", () => {
    const raw = [
      '"a,b"', // MNO Name with a comma
      "CU-001",
      '"multi\nline"', // Polygon ID with an embedded newline
      "2026-08-01",
      "2026-12-31",
      "Selangor",
      "Petaling",
      "PRDINV00000001",
      "SVC1",
      "0.0125",
    ].join(",");
    const result = parseRateCardCsv(csv([raw]));
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]!.cells["MNO Name"]).toBe("a,b");
    expect(result.rows[0]!.cells["Polygon ID"]).toBe("multi\nline");
  });

  // I4.11 — grep proves exactly one import of the parser package in the tree.
  it("imports csv-parse in exactly one file (the parser module)", () => {
    const importers = collectSourceFiles(REPO_ROOT).filter((file) => {
      const source = fs.readFileSync(file, "utf8");
      return /from\s+["']csv-parse(\/sync)?["']|require\(\s*["']csv-parse/.test(
        source,
      );
    });
    const relative = importers.map((f) =>
      path.relative(REPO_ROOT, f).replace(/\\/g, "/"),
    );
    expect(relative).toEqual([PARSER_RELATIVE]);
  });

  // I4.12 — the module imports no fs and retains no buffer / writes no file.
  it("imports no fs in the parser module", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, PARSER_RELATIVE),
      "utf8",
    );
    expect(source).not.toMatch(/from\s+["'](node:)?fs["']/);
    expect(source).not.toMatch(/require\(\s*["'](node:)?fs["']/);
    // No next/* import either (framework-agnostic).
    expect(source).not.toMatch(/from\s+["']next\//);
  });

  // I4.13 — a leading BOM on the first header cell yields "MNO Name"; a padded
  // header cell and every data cell (including a whitespace-only one) are
  // returned untouched.
  it("strips a leading BOM from the first header cell but trims no data cell", () => {
    const headerCells = [...HEADER_CELLS];
    headerCells[0] = `﻿${headerCells[0]}`; // BOM before "MNO Name"
    headerCells[2] = `  ${headerCells[2]}  `; // padded "Polygon ID" header

    const line = dataLine({
      State: "  padded value  ",
      "Service Code": "   ",
    });
    const result = parseRateCardCsv(csvWith(headerCells, [line]));

    // BOM stripped from the first header cell.
    expect(result.header[0]).toBe("MNO Name");
    // The padded header cell is left untouched (pm58 trims it when matching).
    expect(result.header[2]).toBe("  Polygon ID  ");
    // Data cells are returned exactly as written — no trim reaches them.
    expect(result.rows[0]!.cells["  Polygon ID  "]).toBe("POLY-001");
    expect(result.rows[0]!.cells["State"]).toBe("  padded value  ");
    expect(result.rows[0]!.cells["Service Code"]).toBe("   ");
  });

  // D6 buffered-path smoke: a generated few-hundred-row file parses in one
  // call without blowing up (not committed; proves nothing the small fixtures
  // do not, only that the buffered path holds).
  it("parses a generated few-hundred-row file in one buffered call", () => {
    const rows = Array.from({ length: 400 }, (_, i) =>
      dataLine({ "Polygon ID": `POLY-${i}` }),
    );
    const result = parseRateCardCsv(csv(rows));
    expect(result.rows).toHaveLength(400);
    expect(result.rows.at(-1)!.line).toBe(401);
    expect(result.checksum).toMatch(/^[0-9a-f]{64}$/);
  });

  // D6 — the checksum is a sha256 over the uploaded bytes, stable per content.
  it("computes a sha256 checksum over the uploaded bytes", () => {
    const bytes = csv([dataLine()]);
    const a = parseRateCardCsv(bytes);
    const b = parseRateCardCsv(Buffer.from(bytes));
    expect(a.checksum).toMatch(/^[0-9a-f]{64}$/);
    expect(a.checksum).toBe(b.checksum);
    // A different file yields a different checksum.
    const other = parseRateCardCsv(csv([dataLine({ "MNO Name": "OTHER" })]));
    expect(other.checksum).not.toBe(a.checksum);
  });
});
