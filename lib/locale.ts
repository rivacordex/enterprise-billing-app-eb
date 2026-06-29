// Curated allow-lists for the `app/locale` and `app/default_currency`
// config rows (um28-spec §2.8). `ConfigEditDialog` is a generic free-text
// Textarea (no per-key dropdown), so enforcement lives in the read path:
// the stored string is validated against these constants and falls back to
// the default on blank/unknown. Framework-agnostic (importable from both
// server and client, like `lib/formatters.ts`).
//
// Why a curated list, not "any Intl-valid tag": locale here drives `Intl`
// date/number/currency formatting only — NOT UI translation (the app has no
// message catalogs). An open list would let an admin pick, say, `ja-JP`
// expecting Japanese text and get only reformatted numbers. Extend the
// constants as the carrier's footprint grows — a one-line edit, no migration.

export const SUPPORTED_LOCALES = [
  "en-MY",
  "ms-MY",
  "en-SG",
  "en-GB",
  "en-US",
] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

// `en-GB` matches today's hardcoded `formatDatetime` output, so a missing/
// blank `locale` row reproduces current behavior exactly.
export const DEFAULT_LOCALE = "en-GB";

export const SUPPORTED_CURRENCIES = [
  "MYR",
  "SGD",
  "USD",
  "EUR",
  "GBP",
] as const;
export type SupportedCurrency = (typeof SUPPORTED_CURRENCIES)[number];

export const DEFAULT_CURRENCY = "MYR";

// Curated allow-list for the `APP_TIMEZONE` env var (um29-spec §2.2). IANA
// names only — never raw offsets like "+08": offsets don't encode DST and
// `Intl` expects IANA. The offset is computed per request from the IANA name
// (lib/timezone.ts), so non-integer zones like `Asia/Kolkata` (UTC+5:30)
// render correctly. DST is NOT supported in v1 — a single offset is derived
// per call, so the three DST zones below may be off by one hour for ~1 day
// around each transition (accepted limitation, revisit if a DST zone becomes
// a primary deployment). Extend as the carrier's footprint grows — a one-line
// edit, no migration.
export const SUPPORTED_TIMEZONES = [
  "Asia/Kuala_Lumpur", // UTC+8  (primary business zone)
  "Asia/Singapore", // UTC+8
  "Asia/Kolkata", // UTC+5:30 — non-integer offset (boundary test case)
  "Africa/Johannesburg", // UTC+2  (South Africa)
  "Asia/Dubai", // UTC+4  (UAE) — no DST
  "America/New_York", // US Eastern  — observes DST
  "America/Los_Angeles", // US Pacific  — observes DST
  "Australia/Sydney", // UTC+10/+11 (Australia Eastern) — observes DST
  "UTC",
] as const;

export type SupportedTimezone = (typeof SUPPORTED_TIMEZONES)[number];

// Behavior-preserving fallback when `APP_TIMEZONE` is unset — every datetime
// renders in UTC exactly as it does today.
export const DEFAULT_TIMEZONE: SupportedTimezone = "UTC";

export function isSupportedTimezone(tz: string): tz is SupportedTimezone {
  return (SUPPORTED_TIMEZONES as readonly string[]).includes(tz);
}
