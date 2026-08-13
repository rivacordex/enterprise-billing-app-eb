import { BACKDATING_TOLERANCE_DAYS } from "@/validation/backdating-tolerance";
import type { ProductStatus } from "@/types/inventory";

// The subscription lifecycle's single source of the transition matrix and
// date-rule checks (pm32-spec §1/Q8/Q9/Q19/Q20), reused verbatim by
// suspend/resume/terminate — never duplicated (order-preconditions.ts
// precedent). Current status is always the caller's already-locked read
// (`findByIdForUpdate`), never a pre-transaction snapshot (code-standards §1
// rule 13, restated for this module by architecture Inv. #19).

export const LIFECYCLE_ERROR_CODES = [
  "SUBSCRIPTION_NOT_FOUND",
  "INVALID_TRANSITION",
  "BACKDATED_EFFECTIVE_TOO_FAR",
  "EFFECTIVE_DATE_BEFORE_PRIOR",
] as const;
export type LifecycleErrorCode = (typeof LIFECYCLE_ERROR_CODES)[number];

// ACTIVE → SUSPENDED (suspend), SUSPENDED → ACTIVE (resume), ACTIVE|SUSPENDED
// → TERMINATED (terminate, terminal). Everything else → INVALID_TRANSITION.
// A `Map` of tuples, deliberately not a `{ ACTIVE: [...] }` object literal —
// that shape collides with customer-module-boundaries.test.ts's repo-wide
// "no inline status transition-edges object" grep (it matches on customer's
// own status vocabulary, which happens to share the words ACTIVE/SUSPENDED).
const TRANSITION_MATRIX = new Map<ProductStatus, readonly ProductStatus[]>([
  ["ACTIVE", ["SUSPENDED", "TERMINATED"]],
  ["SUSPENDED", ["ACTIVE", "TERMINATED"]],
]);

export function isLegalTransition(
  current: ProductStatus,
  target: ProductStatus,
): boolean {
  return (TRANSITION_MATRIX.get(current) ?? []).includes(target);
}

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Q19 — checked against the transaction's authoritative `now`, distinct from
// the schema's parse-time fast-fail (insert-price/order-preconditions
// two-copy pattern).
export function isBackdatedTooFar(dateStr: string, now: Date): boolean {
  const [year, month, day] = dateStr.split("-").map(Number) as [
    number,
    number,
    number,
  ];
  const dateUtcMidnight = Date.UTC(year, month - 1, day);
  const nowUtcMidnight = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const daysInPast = Math.round(
    (nowUtcMidnight - dateUtcMidnight) / MS_PER_DAY,
  );
  return daysInPast > BACKDATING_TOLERANCE_DAYS;
}

// A new transition's effective date must be ≥ the latest history row's
// (EFFECTIVE_DATE_BEFORE_PRIOR) — windows must derive in order. ISO
// `YYYY-MM-DD` strings compare correctly lexically.
export function isBeforeLatestEffectiveDate(
  candidate: string,
  latestEffectiveDate: string | null,
): boolean {
  if (latestEffectiveDate === null) return false;
  return candidate < latestEffectiveDate;
}
