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
