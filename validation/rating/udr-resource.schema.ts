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

function isCalendarDate(value: string): boolean {
  const date = new Date(`${value}T00:00:00Z`);
  return (
    !Number.isNaN(date.getTime()) && date.toISOString().slice(0, 10) === value
  );
}

export const udrResourceSchema = z
  .string()
  .regex(
    /^[^|]*\|[^|]*\|\d{4}-\d{2}-\d{2}$/,
    "Must be state|district|YYYY-MM-DD with no '|' inside a label",
  )
  .refine(
    // The regex pins the date to the last 10 characters.
    (value) => isCalendarDate(value.slice(-10)),
    "polygon_start_date must be a real calendar date",
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
  if (label == null || /^\s*$/.test(label)) return "";
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
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(parts.polygonStartDate) ||
    !isCalendarDate(parts.polygonStartDate)
  ) {
    throw new Error(
      `udr_resource polygonStartDate is not a valid YYYY-MM-DD date: ${parts.polygonStartDate}`,
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
