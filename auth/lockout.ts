import type { LockoutState } from "@/types/lockout";

// Pure decision logic (um04-spec §3) — zero DB imports so the sign-in hook's
// lock check stays unit-testable without a database.
export function isCurrentlyLocked(state: LockoutState): boolean {
  return state.lockedUntil !== null && state.lockedUntil.getTime() > Date.now();
}
