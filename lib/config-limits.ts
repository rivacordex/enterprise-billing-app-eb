// Per-key maximum lengths for `core.system_config` values (plan §3.13).
// Enforcement lives in the write service, not the Zod schema:
// `updateConfigValueSchema` receives only `configId`, so it structurally cannot
// know which key's limit applies — the service is the first place that knows
// the row's group and key. The generic `max(2000)` in the schema stays as the
// outer bound for every other row.

// D12: the top-bar wordmark's presentation budget. 40 sits inside the top bar,
// the login/set-password/no-access card, and the browser tab with headroom, so
// a compliant name never ellipsizes at ≥1280px. Drives the edit dialog's live
// counter (no native `maxLength` — it counts UTF-16 units, not code points), and
// is checked against the `0005` seed copy by a test (§6.2) so the number and the
// help text can't drift.
export const APP_NAME_MAX_LENGTH = 40;

// Keyed "group:key"; the write service looks up `${configGroup}:${configKey}`.
export const CONFIG_VALUE_MAX_LENGTH: Record<string, number> = {
  "app:app_name": APP_NAME_MAX_LENGTH,
};

// The length a config value counts toward its per-key limit: Unicode code
// points (not UTF-16 units), so an emoji/astral glyph counts as one. Shared by
// the write-service cap and the edit-dialog counter so the two can't measure
// differently (a client/server disagreement would show "40/40" yet be rejected,
// or vice-versa). Callers that want the stored length trim first.
export function configValueLength(value: string): number {
  return [...value].length;
}
