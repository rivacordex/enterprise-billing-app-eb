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
