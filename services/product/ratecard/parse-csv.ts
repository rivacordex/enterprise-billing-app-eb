import { createHash } from "node:crypto";

import { parse } from "csv-parse/sync";

// ---------------------------------------------------------------------------
// pm59-spec — the rate-card CSV parser. This is THE ONLY FILE IN THE REPOSITORY
// THAT IMPORTS THE PARSER PACKAGE (`csv-parse`, pinned exact at G-RC4, D2/§7.10):
// the pin stays swappable (one file to change) and Inv. #51's empty-cell
// discipline is asserted in one place. A guardrail greps that this is the sole
// import; a second one is a second place the rule can be got wrong silently.
//
// It turns uploaded bytes into string cells and NOTHING ELSE. It does not
// validate (D7): it does not know what `rate_per_unit` means, does not check
// the header against an expected set, and does not detect duplicate keys —
// those are pm58's, and keeping them there preserves which layer refused a
// write (workflow §4.2). What it owns is the empty-cell discipline AS IT
// MANIFESTS IN PARSING:
//
//   * Coercion is OFF (`cast: false`, set explicitly even though it is the
//     default — a default is a fact about a version, and this one is
//     load-bearing): every cell is a string, an empty cell stays "" and never
//     becomes 0/null/undefined, "0" stays the string "0", and a leading-zero
//     key like "007" survives unmangled (Inv. #51, §2.20).
//   * A date-shaped cell stays a string in its file form — no `Date` is ever
//     constructed here (§2.22, §4.30).
//   * The parser TRIMS NOTHING; whitespace around a cell is pm58's to handle.
//     The one normalisation is stripping a leading UTF-8 BOM from the first
//     header cell (`bom: true`) — an encoding artefact, not part of the text
//     `MNO Name` (D4). No data cell is ever touched.
//
// The file itself is never stored (Inv. #58): no blob, no temp file, no `fs`
// import, no buffer retained past this call. `file_checksum` is computed over
// the uploaded bytes in the same pass that already holds them and returned
// alongside the rows, so nothing downstream re-reads the file; it DETECTS a
// duplicate upload, it never PREVENTS one (§6.37). `source_file` and the
// persisted checksum are pm61's to write, from what this returns.
//
// Buffered and synchronous (RC15): ~5,000–5,500 rows / ~0.5 MB parsed in one
// call. No streaming, no chunked reader, no worker. No `next/*` import —
// `services/product` stays framework-agnostic (§7.2).
// ---------------------------------------------------------------------------

export interface RateCardCsvRow {
  // The 1-based line number of the row in the uploaded file, counting the
  // header as line 1 — so the first data row is line 2 (§2.25, D5). Computed
  // explicitly from the row's position here, never borrowed from the library's
  // own index: a borrowed index is the most likely source of an off-by-one,
  // and an off-by-one points every reported row at its neighbour.
  readonly line: number;
  // Cells keyed by the header text as found. Deliberately NOT a typed row —
  // typing it here would duplicate pm58's schema and invite the two to drift
  // (§2.16). The schema parses; the parser reads.
  readonly cells: Record<string, string>;
}

export interface ParsedRateCardCsv {
  // The header row exactly as found, INCLUDING duplicate headers (some
  // libraries silently de-duplicate; that must stay visible for pm58's file
  // schema to reject, D4). Deciding a column is missing is pm58's job, not this
  // parser's — it hands the header over faithfully and fills nothing.
  readonly header: string[];
  readonly rows: RateCardCsvRow[];
  // sha256 over the uploaded bytes (D6).
  readonly checksum: string;
}

export function parseRateCardCsv(bytes: Buffer): ParsedRateCardCsv {
  // Same pass, same buffer: the checksum is taken over the raw uploaded bytes
  // (BOM included) before the buffer is handed to the parser and dropped.
  const checksum = createHash("sha256").update(bytes).digest("hex");

  // Array mode (no `columns` option) returns string[][]: it preserves duplicate
  // headers (which `columns: true` would collapse into one object key) and lets
  // us attach our own line numbers. `cast: false` and `trim: false` are set
  // explicitly — the two switches this unit exists to hold down.
  const records: string[][] = parse(bytes, {
    bom: true,
    cast: false,
    trim: false,
  });

  const [header = [], ...dataRows] = records;

  const rows: RateCardCsvRow[] = dataRows.map((cells, index) => {
    const record: Record<string, string> = {};
    header.forEach((name, columnIndex) => {
      // Column count is consistent across a well-formed file, so every header
      // position has a cell; the `?? ""` is a type-level guard that never fills
      // a missing column (D4 forbids filling — and none can reach here).
      record[name] = cells[columnIndex] ?? "";
    });
    // index 0 is the first data row → line 2 (header is line 1).
    return { line: index + 2, cells: record };
  });

  return { header, rows, checksum };
}
