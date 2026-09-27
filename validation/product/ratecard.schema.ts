import { z } from "zod";

// ---------------------------------------------------------------------------
// The rate-card upload contract — pm58-spec. This file is the single home of
// the upload contract: the ten-column header of D0, a strict row schema, a
// file-level validator that refuses a header mismatch or a duplicate key
// outright, and the `RateCardIssue` line-number contract every later layer
// (parser pm59, service pm61, error table pm66) reports against.
//
// It is PURE and DATABASE-FREE (D7): every export here is a function over
// already-parsed string cells. It imports nothing from `db/**`, `services/**`
// or a CSV parser — the split is workflow §4.2's (the schema owns the shape,
// the parser owns the cells, the service owns the transaction). Zod is the
// primary guard; pm57a's database CHECKs/uniqueness are the backstop, never
// the reverse.
//
// No capacity field (RC4), no `currency` field (Inv. #53), no field the plan
// does not show (workflow §5.4).
// ---------------------------------------------------------------------------

// D0 — the column set. THIS RECORD IS THE ONLY PLACE THE TEN HEADER STRINGS
// ARE SPELLED (pm58-spec I1). It maps each file header (the exact, binding
// text RevOps' export carries — OR7′, confirmed 2026-09-25) to the table
// column it lands in. `MNO Name` lands in `mno_public_key`, `Commercial Unit
// ID` in `commercial_unit_public_key`, and so on: the table column keeps its
// name, but the key is still the MNO's identity for matching. pm59, pm61,
// pm66 and pm67 import this map from here; nothing else spells the header
// text. Insertion order is D0's column order (1–10).
export const RATE_CARD_HEADER_MAP = {
  "MNO Name": "mno_public_key",
  "Commercial Unit ID": "commercial_unit_public_key",
  "Polygon ID": "polygon_id",
  "Polygon Start Date": "polygon_start_date",
  "Polygon End Date": "polygon_end_date",
  State: "state",
  District: "district",
  "Subscriber Reference ID": "lkp_subscriber_ref_id",
  "Service Code": "service_code",
  "Rate per Unit": "rate_per_unit",
} as const;

export type RateCardFileHeader = keyof typeof RATE_CARD_HEADER_MAP;
export type RateCardTableColumn =
  (typeof RATE_CARD_HEADER_MAP)[RateCardFileHeader];

// The ten file headers and the ten table columns, derived from the map so the
// header text is never re-spelled. Header order is not significant to matching
// (columns are matched by name); this array only fixes a canonical iteration
// order (D0's) for building a row and for header diffs.
export const RATE_CARD_FILE_HEADERS = Object.keys(
  RATE_CARD_HEADER_MAP,
) as RateCardFileHeader[];
export const RATE_CARD_TABLE_COLUMNS = Object.values(
  RATE_CARD_HEADER_MAP,
) as RateCardTableColumn[];

// ---------------------------------------------------------------------------
// Cell rules (D0, D2). Values are validated but NEVER rewritten: key cells are
// stored as-is (no trimming, no case folding, no leading-zero loss — §2.20),
// and an empty optional cell stays "" (it is NEVER coerced to `0` or to NULL
// here — the "→ NULL" storage outcome in D0 is the service's, pm61). The one
// normalisation in this file is on HEADER cells, not data cells.
// ---------------------------------------------------------------------------

// A real calendar date in strict `YYYY-MM-DD` (D0 col 4/5, §2.21). The regex
// pins the exact shape — four-two-two digits, hyphen-separated — so `2026-8-1`
// (single digits), `01/08/2026` (wrong separator/order) and
// `2026-08-01T00:00` (a datetime) are all refused by format. A pure
// day-in-month check (with the proleptic-Gregorian leap rule) then refuses an
// impossible day like `2026-02-30`. Deliberately NO `Date` object: this module
// keeps calendar dates as strings end to end (§2.21), and
// `new Date(Date.UTC(yy, …))` maps two-digit years 0–99 to 1900–1999, which
// would wrongly reject a validly-formatted date such as `0099-01-01`.
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
function isRealIsoDate(value: string): boolean {
  if (!ISO_DATE_RE.test(value)) return false;
  const year = Number(value.slice(0, 4));
  const month = Number(value.slice(5, 7));
  const day = Number(value.slice(8, 10));
  if (month < 1 || month > 12) return false;
  const isLeap = (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
  const daysInMonth = [
    31,
    isLeap ? 29 : 28,
    31,
    30,
    31,
    30,
    31,
    31,
    30,
    31,
    30,
    31,
  ];
  return day >= 1 && day <= daysInMonth[month - 1]!;
}

// `rate_per_unit` fits the column's `numeric(18,6)` (D2): non-negative, at most
// 12 integer digits and 6 decimal places, no sign, no thousands separator, no
// exponent. There is NO reserved rule — `"0"` and any in-range decimal are
// plain valid values, never rounded to fit.
const RATE_PER_UNIT_RE = /^\d{1,12}(\.\d{1,6})?$/;

// A NUL byte (\u0000) can never be stored in a Postgres `text` column, and it
// is also this file's row-key delimiter (ROW_KEY_DELIMITER below) — a key cell
// containing one would both fail to persist and could collide with the
// delimiter, producing a false DUPLICATE_ROW_KEY at the in-memory dedup that
// runs before any insert. Zod is the primary guard (the DB is the backstop),
// so every stored string cell rejects a NUL here with a clear error rather
// than reaching an opaque insert failure or a spurious duplicate. This is not
// normalisation of free-text data (§2.20); it refuses a value the storage
// layer can never hold.
const hasNulByte = (value: string): boolean => value.includes("\u0000");

// A required cell is non-empty: a whitespace-only cell counts as empty and is
// refused (D0). The stored value is left exactly as uploaded — the emptiness
// test trims, the value does not.
const requiredCellSchema = z
  .string()
  .refine((value) => value.trim().length > 0, {
    message: "This required cell must not be empty or whitespace.",
  })
  .refine((value) => !hasNulByte(value), {
    message: "This cell must not contain a NUL byte (\\u0000).",
  });

// A plain optional string column (`state`, `district`, `service_code`): any
// string is accepted, including "". Stored as uploaded; never trimmed, never
// nulled here (D0 cols 6/7/9, §3.3) — but a NUL byte is refused (unstorable).
const optionalStringCellSchema = z
  .string()
  .refine((value) => !hasNulByte(value), {
    message: "This cell must not contain a NUL byte (\\u0000).",
  });

const polygonStartDateCellSchema = z.string().refine(isRealIsoDate, {
  message: "Must be a real calendar date in YYYY-MM-DD format.",
});

const polygonEndDateCellSchema = z
  .string()
  .refine((value) => value === "" || isRealIsoDate(value), {
    message:
      "Must be empty (open-ended) or a real calendar date in YYYY-MM-DD format.",
  });

const ratePerUnitCellSchema = z
  .string()
  .refine((value) => value === "" || RATE_PER_UNIT_RE.test(value), {
    message:
      "Must be empty or a non-negative decimal with at most 12 integer and 6 fractional digits (no sign, thousands separator, or exponent).",
  });

// D1 — the row schema is a strictObject keyed by TABLE COLUMN (not by header
// text, which lives only in RATE_CARD_HEADER_MAP). Strict → an unknown cell is
// rejected, never stripped (a stripped column is a silent contract change).
// `lkp_subscriber_ref_id` is validated STRUCTURALLY ONLY: non-empty, stored
// as-is — no `PRDINV` pattern check and no referential check (D-A1, Inv. #57),
// because a superseded version's rows must survive a subscription's removal.
export const rateCardRowSchema = z.strictObject({
  mno_public_key: requiredCellSchema,
  commercial_unit_public_key: requiredCellSchema,
  polygon_id: requiredCellSchema,
  polygon_start_date: polygonStartDateCellSchema,
  polygon_end_date: polygonEndDateCellSchema,
  state: optionalStringCellSchema,
  district: optionalStringCellSchema,
  lkp_subscriber_ref_id: requiredCellSchema,
  service_code: optionalStringCellSchema,
  rate_per_unit: ratePerUnitCellSchema,
});
export type RateCardRow = z.infer<typeof rateCardRowSchema>;

// D4 — the closed, structural violation set. Exactly three members, each
// decidable by the schema over already-parsed cells with no database and no
// referential check behind it (§2.22). The NAMES are binding: pm66's error
// table keys off them (§4.28). Never invent a fourth (workflow §5.4).
// (`SNAPSHOT_DATE_NOT_CONSTANT` is withdrawn — the file has no date column,
// D-A8.)
export const RATE_CARD_UPLOAD_VIOLATIONS = [
  "HEADER_MISMATCH",
  "DUPLICATE_ROW_KEY",
  "ROW_SCHEMA_INVALID",
] as const;
export type RateCardUploadViolation =
  (typeof RATE_CARD_UPLOAD_VIOLATIONS)[number];

// D5 — the line-number contract, fixed once, here, because the parser (pm59),
// the service (pm61) and the error table (pm66) must all agree. `line` is the
// 1-based line number of the row in the uploaded file, COUNTING THE HEADER AS
// LINE 1 — so the first data row is line 2. An off-by-one between any two
// layers points every reported row at its neighbour, which is worse than
// reporting no line number at all. `column` is the offending table column (or
// null for a whole-file/whole-row issue), `value` the offending cell (or
// null), `reason` the human explanation. `violation` classifies the issue
// against the closed set above.
export const rateCardIssueSchema = z.strictObject({
  violation: z.enum(RATE_CARD_UPLOAD_VIOLATIONS),
  line: z.number().int().positive(),
  column: z.string().nullable(),
  value: z.string().nullable(),
  reason: z.string(),
});
export type RateCardIssue = z.infer<typeof rateCardIssueSchema>;

// D6 — `rejectSummarySchema` is the bounded jsonb contract for a future
// asynchronous ingest. It takes the FULL issue list and TRUNCATES to the first
// 100, recording the true `totalIssues` and whether it `truncated`: a
// 5,500-row file can produce 5,500 issues and a jsonb column is not a log.
//
// NO PATH IN THIS DELIVERY WRITES IT (§1.42). It exists so that whoever writes
// the first one cannot write an unbounded blob; do not invent a writer to make
// the column look used (workflow §3.5). pm57a's `reject_summary` column
// carries the inferred (output) type via `.$type<RejectSummary>()`.
export const RATE_CARD_REJECT_SUMMARY_MAX_ISSUES = 100;
export const rejectSummarySchema = z
  .array(rateCardIssueSchema)
  .transform((issues) => ({
    issues: issues.slice(0, RATE_CARD_REJECT_SUMMARY_MAX_ISSUES),
    totalIssues: issues.length,
    truncated: issues.length > RATE_CARD_REJECT_SUMMARY_MAX_ISSUES,
  }));
export type RejectSummary = z.infer<typeof rejectSummarySchema>;

// The parsed-file envelope this unit validates (D7). POSITIONAL: `header` is
// the raw header cells as read, `rows` are each data row's cells aligned to
// the header by index. strictObject → the envelope itself carries no stray
// fields. The parser (pm59) produces this shape; this file never reads a file.
export const parsedRateCardFileSchema = z.strictObject({
  header: z.array(z.string()),
  rows: z.array(z.array(z.string())),
});
export type ParsedRateCardFile = z.infer<typeof parsedRateCardFileSchema>;

export type RateCardFileResult =
  | { readonly ok: true; readonly rows: readonly RateCardRow[] }
  | { readonly ok: false; readonly issues: readonly RateCardIssue[] };

// The row key delimiter (D3, §6.33). The key components are free-text RevOps
// data, so a naive `+` concatenation would make ("AB","C") and ("A","BC")
// collide. We join on the NUL byte ("\u0000"), and a key component can never
// contain one: `requiredCellSchema` rejects any cell containing a NUL (above),
// and a Postgres `text` column cannot store one either. Because that rejection
// runs at validation — before this in-memory dedup — the join is provably
// injective over every value that reaches it (§2.20).
const ROW_KEY_DELIMITER = "\u0000";

export function rateCardRowKey(
  mnoPublicKey: string,
  commercialUnitPublicKey: string,
  polygonId: string,
): string {
  return [mnoPublicKey, commercialUnitPublicKey, polygonId].join(
    ROW_KEY_DELIMITER,
  );
}

// D3 — the file-level validator. Two whole-file rules, applied in order:
//   1. Header match against D0's ten columns (D1). The only normalisation is
//      stripping a leading UTF-8 BOM from the FIRST header cell and trimming
//      surrounding whitespace from each header cell; matching is otherwise
//      exact and case-sensitive, in any order. A mismatch (any unknown column
//      — `Date` included — or any missing column) is HEADER_MISMATCH and the
//      file is refused outright: the contract changed, so rows are NOT then
//      re-reported as thousands of per-row errors (Inv. #51).
//   2. No duplicate row key (mno_public_key, commercial_unit_public_key,
//      polygon_id) (RV2, D-A9), reporting BOTH line numbers — one line number
//      tells the user half of what they need. Polygon Start Date is NOT part
//      of the key and is never converted to a Date first.
// Row cells are validated by `rateCardRowSchema`; a failure is
// ROW_SCHEMA_INVALID naming the column. All ERROR-severity per §1.41 (the
// checksum WARNING is the service's, pm61 — not a structural rule, so not here).
export function validateRateCardFile(
  file: ParsedRateCardFile,
): RateCardFileResult {
  const normalizedHeaders = file.header.map((cell, index) =>
    (index === 0 ? cell.replace(/^\uFEFF/, "") : cell).trim(),
  );

  // 1. Header match. One pass records each header's first position (so a row's
  // cell can be read positionally by header name) and its occurrence count.
  // Then each DISTINCT header is judged once — unknown if not in the contract,
  // else duplicate if it appears more than once (the parser preserves duplicate
  // headers, pm59 D4, so they are rejected here rather than silently collapsed
  // to the first column). Reporting each distinct header once means a doubled
  // column yields a single issue whether it is known or unknown. Missing
  // expected columns are reported separately.
  const headerIndex = new Map<string, number>();
  const headerCounts = new Map<string, number>();
  normalizedHeaders.forEach((header, index) => {
    if (!headerIndex.has(header)) headerIndex.set(header, index);
    headerCounts.set(header, (headerCounts.get(header) ?? 0) + 1);
  });
  const expectedSet = new Set<string>(RATE_CARD_FILE_HEADERS);

  const headerIssues: RateCardIssue[] = [];
  for (const [header, occurrences] of headerCounts) {
    if (!expectedSet.has(header)) {
      headerIssues.push({
        violation: "HEADER_MISMATCH",
        line: 1,
        column: header,
        value: header,
        reason: `Unknown column "${header}" — the header does not match the rate-card upload contract.`,
      });
    } else if (occurrences > 1) {
      headerIssues.push({
        violation: "HEADER_MISMATCH",
        line: 1,
        column: header,
        value: header,
        reason: `Duplicate column "${header}" — it appears ${occurrences} times; each expected column must appear exactly once.`,
      });
    }
  }
  for (const header of RATE_CARD_FILE_HEADERS) {
    if (!headerCounts.has(header)) {
      headerIssues.push({
        violation: "HEADER_MISMATCH",
        line: 1,
        column: header,
        value: null,
        reason: `Missing required column "${header}".`,
      });
    }
  }
  if (headerIssues.length > 0) {
    return { ok: false, issues: headerIssues };
  }

  // 2. Row schema + duplicate row key. Both accumulate across the file.
  const issues: RateCardIssue[] = [];
  const validRows: RateCardRow[] = [];
  const firstLineByKey = new Map<string, number>();

  file.rows.forEach((cells, rowIndex) => {
    const line = rowIndex + 2; // header is line 1; first data row is line 2.

    const record: Record<string, string> = {};
    for (const header of RATE_CARD_FILE_HEADERS) {
      const column = RATE_CARD_HEADER_MAP[header];
      record[column] = cells[headerIndex.get(header)!] ?? "";
    }

    const parsed = rateCardRowSchema.safeParse(record);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) {
        const column = issue.path[0];
        const columnName = typeof column === "string" ? column : null;
        issues.push({
          violation: "ROW_SCHEMA_INVALID",
          line,
          column: columnName,
          value: columnName ? (record[columnName] ?? null) : null,
          reason: issue.message,
        });
      }
      return;
    }

    const row = parsed.data;
    const key = rateCardRowKey(
      row.mno_public_key,
      row.commercial_unit_public_key,
      row.polygon_id,
    );
    const firstLine = firstLineByKey.get(key);
    if (firstLine !== undefined) {
      issues.push({
        violation: "DUPLICATE_ROW_KEY",
        line,
        column: null,
        value: null,
        reason: `Duplicate row key (MNO Name "${row.mno_public_key}" / Commercial Unit ID "${row.commercial_unit_public_key}" / Polygon ID "${row.polygon_id}") — first seen at line ${firstLine}, repeated at line ${line}.`,
      });
      return;
    }
    firstLineByKey.set(key, line);
    validRows.push(row);
  });

  if (issues.length > 0) {
    return { ok: false, issues };
  }
  return { ok: true, rows: validRows };
}
