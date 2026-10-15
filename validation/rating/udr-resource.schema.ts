import { z } from "zod";

// rating.udr_rated.udr_resource — the matched ratecard cell's label,
// `state|district|polygon_start_date` (Inv 28; rm25-spec). The one
// TypeScript definition of the format: seeds and tests build and read it
// through here, and PRP (rm26) applies the same rule on the Python side.
//
// Three segments split on `|`; the date is ISO `YYYY-MM-DD`; a blank label
// is an empty segment. A non-blank label is kept exactly as stored on the
// card — no trim, no case change (bm48 D2).
export const UDR_RESOURCE_DELIMITER = "|";

// polygon_start_date is the card's `date NOT NULL` column (0041), carried as
// the text PRP writes with `date.isoformat()`: the date of interest is the one
// on the card. Only its `YYYY-MM-DD` shape is checked here — the column already
// guarantees a real day — and it never passes through a `Date`
// (code-standards §0.1 TypeScript rule 4).
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

// Exactly the code points Python's `str.strip()` removes (`str.isspace()`), so
// "blank" here means what it means to PRP's `_geo_label`. Deliberately not JS
// `\s`, which adds U+FEFF and omits U+001C–U+001F and U+0085: a label PRP
// keeps would be blanked here, or the reverse. Numeric, so no invisible
// character sits in the source.
const PYTHON_WHITESPACE: ReadonlySet<number> = new Set([
  0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x1c, 0x1d, 0x1e, 0x1f, 0x20, 0x85, 0xa0,
  0x1680, 0x2000, 0x2001, 0x2002, 0x2003, 0x2004, 0x2005, 0x2006, 0x2007,
  0x2008, 0x2009, 0x200a, 0x2028, 0x2029, 0x202f, 0x205f, 0x3000,
]);

// Blank = empty or whitespace-only (the empty string is blank).
function isBlankLabel(label: string): boolean {
  for (const ch of label) {
    if (!PYTHON_WHITESPACE.has(ch.codePointAt(0)!)) return false;
  }
  return true;
}

export const udrResourceSchema = z
  .string()
  .regex(/^[^|]*\|[^|]*\|\d{4}-\d{2}-\d{2}$/, {
    message: "Must be state|district|YYYY-MM-DD with no '|' inside a label",
    // A value of the wrong shape has no labels to check below.
    abort: true,
  })
  .refine(
    // Inv 28: a blank label is an EMPTY segment, never a whitespace one.
    (value) =>
      value
        .split(UDR_RESOURCE_DELIMITER)
        .slice(0, 2)
        .every((label) => label === "" || !isBlankLabel(label)),
    "A blank state or district must be an empty segment, not whitespace",
  );

export type UdrResourceParts = {
  state: string | null;
  district: string | null;
  polygonStartDate: string;
};

// Blank = null, undefined or whitespace-only — the same rule as PRP's
// `_geo_label`.
function segment(
  field: "state" | "district",
  label: string | null | undefined,
): string {
  if (label == null || isBlankLabel(label)) return "";
  if (label.includes(UDR_RESOURCE_DELIMITER)) {
    throw new Error(
      `udr_resource ${field} label contains '${UDR_RESOURCE_DELIMITER}': ${label}`,
    );
  }
  return label;
}

// Strict: throws rather than write a value PRP would refuse (R9).
export function formatUdrResource(parts: {
  state: string | null | undefined;
  district: string | null | undefined;
  polygonStartDate: string;
}): string {
  const state = segment("state", parts.state);
  const district = segment("district", parts.district);
  if (!ISO_DATE_RE.test(parts.polygonStartDate)) {
    throw new Error(
      `udr_resource polygonStartDate is not YYYY-MM-DD: ${parts.polygonStartDate}`,
    );
  }
  return udrResourceSchema.parse(
    [state, district, parts.polygonStartDate].join(UDR_RESOURCE_DELIMITER),
  );
}

export function parseUdrResource(value: string): UdrResourceParts {
  // The schema guarantees exactly three segments.
  const [state = "", district = "", polygonStartDate = ""] = udrResourceSchema
    .parse(value)
    .split(UDR_RESOURCE_DELIMITER);
  return {
    state: state === "" ? null : state,
    district: district === "" ? null : district,
    polygonStartDate,
  };
}
