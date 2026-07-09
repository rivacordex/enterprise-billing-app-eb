import type {
  SystemConfigDisplayRow,
  SystemConfigGroup,
} from "@/types/system-config";
import type { PasswordPolicy } from "@/types/password";

// Pure, framework-agnostic — importable from both server and client modules
// (um07-spec §7.4). `locale` (um28-spec §2.9) and `timezone` (um29-spec §2.4)
// are resolved server-side — from the `app/locale` config row and the
// `APP_TIMEZONE` env var respectively — and threaded in as parameters so the
// formatter stays pure (it never reads config). `timezone` is **required** so
// TypeScript forces every call site to pass the resolved zone — the mechanism
// that guarantees no displayed datetime is silently left in UTC. With
// `timezone: "UTC"` the output is byte-identical to today. `fallback` keeps
// its position after `timezone`, matching all existing call sites.
export function formatDatetime(
  date: Date | null,
  locale: string,
  timezone: string,
  fallback = "Never",
): string {
  if (date === null) return fallback;

  return new Intl.DateTimeFormat(locale, {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: timezone,
  }).format(date);
}

// Configuration-driven money formatting (um28-spec §2.9). `locale` +
// `currency` are resolved server-side from `app/locale` + `app/default_currency`
// and threaded in as parameters — the formatter stays pure. No callers in the
// current admin module (no money is displayed yet); ships ready for billing,
// unit-tested only. Note: `Intl.NumberFormat` separates the currency symbol
// from the amount with a non-breaking space (U+00A0), not an ASCII space.
export function formatMoney(
  amount: number,
  locale: string,
  currency: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(amount);
}

// Product Management money display (code-standards §4.4). `amount` arrives as a
// numeric-string from the read model (`PriceCard.amount`, a numeric column);
// `currency` (ISO-4217) and `locale` are resolved server-side and threaded in,
// so the formatter stays pure. Used for the flat price amount — no inline
// `toFixed`, no hand-built currency strings, no hardcoded symbols. Tier `rate`
// is JSONB and prints as stored text (pm08-spec §2.5), so it does NOT pass
// through here.
export function formatCurrency(
  amount: string,
  currency: string,
  locale: string,
): string {
  return new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).format(Number(amount));
}

// Used by `ConfigTable`'s "Last Modified" column (um22-spec §22.5).
export function formatRelativeTime(date: Date): string {
  const diffMs = Date.now() - date.getTime();
  const diffSec = Math.floor(diffMs / 1000);
  const diffMin = Math.floor(diffSec / 60);
  const diffHr = Math.floor(diffMin / 60);
  const diffDay = Math.floor(diffHr / 24);
  if (diffDay > 0) return `${diffDay} day${diffDay === 1 ? "" : "s"} ago`;
  if (diffHr > 0) return `${diffHr} hour${diffHr === 1 ? "" : "s"} ago`;
  if (diffMin > 0) return `${diffMin} minute${diffMin === 1 ? "" : "s"} ago`;
  return "just now";
}

// Groups repository rows by `configGroup`, preserving the repository's
// alphabetical row order within each group (um22-spec §22.5). Group order
// is insertion-order, which is already alphabetical since the repository
// orders by `config_group` ASC.
export function groupConfigRows(
  rows: SystemConfigDisplayRow[],
): SystemConfigGroup[] {
  const map = new Map<string, SystemConfigDisplayRow[]>();
  for (const row of rows) {
    const group = map.get(row.configGroup) ?? [];
    group.push(row);
    map.set(row.configGroup, group);
  }
  return Array.from(map.entries()).map(([group, groupRows]) => ({
    group,
    rows: groupRows,
  }));
}

// um25-spec §"Frontend — error display". Renders the active policy rules
// for the optional password-requirements hint below the New Password input —
// informational only, never the source of truth (server validation via
// `defaultPasswordSchema` is).
export function formatPasswordPolicyHints(policy: PasswordPolicy): string[] {
  const hints = [`At least ${policy.minLength} characters`];
  if (policy.requireUppercase) {
    hints.push("At least one uppercase letter (A–Z)");
  }
  if (policy.requireLowercase) {
    hints.push("At least one lowercase letter (a–z)");
  }
  if (policy.requireNumber) {
    hints.push("At least one number (0–9)");
  }
  if (policy.requireSpecial) {
    hints.push(`At least one special character (${policy.specialChars})`);
  }
  return hints;
}
