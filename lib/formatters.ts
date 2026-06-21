import type {
  SystemConfigDisplayRow,
  SystemConfigGroup,
} from "@/types/system-config";
import type { PasswordPolicy } from "@/types/password";

// Pure, framework-agnostic — importable from both server and client modules
// (um07-spec §7.4).
export function formatDatetime(date: Date | null, fallback = "Never"): string {
  if (date === null) return fallback;

  // Locale fixed to `en-GB` (not the runtime default) so day-month-year
  // order and 24-hour time are guaranteed regardless of host locale.
  return new Intl.DateTimeFormat("en-GB", {
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
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
