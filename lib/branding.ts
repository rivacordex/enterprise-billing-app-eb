// Fallback application name when the `app`/`app_name` config row is blank or
// unset. Matches the wordmark literal used before app_name was wired, so a
// wiped config renders an unchanged brand rather than an empty header.
// Framework-agnostic (importable from both the server reader and client code,
// mirroring `lib/locale.ts` / `lib/sidebar.ts`).
export const DEFAULT_APP_NAME = "Enterprise Billing";
