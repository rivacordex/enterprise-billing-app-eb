// Pure, framework-agnostic timezone math built on the stdlib `Intl` API
// (um29-spec §2.8). Zero new dependencies — offsets are derived via
// `Intl.DateTimeFormat`/`formatToParts`. Importable from both server and
// client modules, like `lib/formatters.ts`.
//
// DST is NOT specially handled (v1 limitation, um29-spec §2.2): a single
// offset is derived per call, so for `America/New_York`,
// `America/Los_Angeles`, and `Australia/Sydney` an audit day-boundary may be
// off by one hour for roughly one day around each DST transition. Accepted
// and documented; non-integer offsets (`Asia/Kolkata` UTC+5:30) ARE handled.

interface ZoneParts {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

// Extracts the wall-clock components of `date` as observed in `timeZone`.
function getZoneParts(date: Date, timeZone: string): ZoneParts {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const map: Record<string, string> = {};
  for (const part of parts) {
    if (part.type !== "literal") map[part.type] = part.value;
  }

  // Some engines emit "24" for midnight under the h23/2-digit hour cycle.
  let hour = Number(map.hour);
  if (hour === 24) hour = 0;

  return {
    year: Number(map.year),
    month: Number(map.month),
    day: Number(map.day),
    hour,
    minute: Number(map.minute),
    second: Number(map.second),
  };
}

// The zone's UTC offset in minutes at `date` (e.g. +480 for UTC+8, +330 for
// UTC+5:30). Wall-clock-parts subtraction: interpret the zone's wall-clock as
// if it were UTC, then diff against the true instant. DST is not specially
// handled (§2.2).
export function getZoneOffsetMinutes(date: Date, timeZone: string): number {
  const p = getZoneParts(date, timeZone);
  const asUtc = Date.UTC(
    p.year,
    p.month - 1,
    p.day,
    p.hour,
    p.minute,
    p.second,
  );
  // Truncate the instant to whole seconds to match the parts (no ms there).
  const actual = Math.floor(date.getTime() / 1000) * 1000;
  return Math.round((asUtc - actual) / 60000);
}

// Returns the UTC instants bounding a local calendar day in `timeZone`:
// local `00:00:00.000` and `23:59:59.999`. Total and pure — NEVER throws
// (precondition: `day` is a valid `YYYY-MM-DD`, which callers guarantee via
// `z.string().date()`), preserving the audit filter's "never 500s" contract
// (um29-spec §2.6). For the `UTC` zone the conversion is the identity.
export function localDayToUtcBounds(
  day: string,
  timeZone: string,
): { start: Date; end: Date } {
  const parts = day.split("-");
  const year = Number(parts[0]);
  const month = Number(parts[1]);
  const dayOfMonth = Number(parts[2]);

  // The target local wall-clock interpreted as if it were UTC, then shifted by
  // the zone's offset at that instant to recover the true UTC instant.
  const startAsUtc = Date.UTC(year, month - 1, dayOfMonth, 0, 0, 0, 0);
  const endAsUtc = Date.UTC(year, month - 1, dayOfMonth, 23, 59, 59, 999);

  const startOffset = getZoneOffsetMinutes(new Date(startAsUtc), timeZone);
  const endOffset = getZoneOffsetMinutes(new Date(endAsUtc), timeZone);

  return {
    start: new Date(startAsUtc - startOffset * 60000),
    end: new Date(endAsUtc - endOffset * 60000),
  };
}

// The `Intl` `shortOffset` label for `timeZone` at `date` — e.g. "GMT+8",
// "GMT+5:30". Special-cased to "UTC" so the default audit display keeps the
// exact existing literal suffix (um29-spec §2.5/§2.8). We do NOT rewrite
// "GMT" to "UTC" for other zones — staying consistent with the platform
// formatter.
export function formatZoneSuffix(date: Date, timeZone: string): string {
  if (timeZone === "UTC") return "UTC";
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "shortOffset",
  }).formatToParts(date);
  return parts.find((p) => p.type === "timeZoneName")?.value ?? "UTC";
}

// The local wall-clock of `date` in `timeZone` as `YYYY-MM-DD HH:mm:ss`
// (no zone label). For `UTC` this is byte-identical to
// `date.toISOString()` truncated to seconds.
export function formatZoneWallClock(date: Date, timeZone: string): string {
  const p = getZoneParts(date, timeZone);
  const pad = (n: number, width = 2): string => String(n).padStart(width, "0");
  return (
    `${pad(p.year, 4)}-${pad(p.month)}-${pad(p.day)} ` +
    `${pad(p.hour)}:${pad(p.minute)}:${pad(p.second)}`
  );
}

// Full audit-style timestamp: local wall-clock + zone label. For `UTC` returns
// the exact existing literal `"2026-06-17 09:14:22 UTC"` (no parentheses,
// byte-identical to today, um29-spec §2.5); for other zones returns
// `"2026-06-17 17:14:22 (GMT+8)"`. Reused by both the Audit Log row display
// (§2.5) and the System Configuration tooltip (§2.7).
export function formatZoneTimestamp(date: Date, timeZone: string): string {
  const wallClock = formatZoneWallClock(date, timeZone);
  return timeZone === "UTC"
    ? `${wallClock} UTC`
    : `${wallClock} (${formatZoneSuffix(date, timeZone)})`;
}
