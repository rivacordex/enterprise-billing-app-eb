import type { AccountStatus, RunStatus } from "@/types/billing";

// bm04-spec §Design/§Implementation §4/§8. Pure, total account-status-set →
// run-status derivation — the ONLY place this decision is made (architecture
// Inv. #12: run status is recomputed under a row lock, never an incremented
// counter). `EXCLUDED` (bm03, scoping-time partial-period exclusion) is
// terminal from the moment it's written and is never signalled downstream, so
// it counts toward "every account terminal" alongside the two stage-outcome
// terminals bm04 introduces. Returns `null` when the run should stay
// PROCESSING (i.e. "no status change"), never a stale/incremental guess.
const TERMINAL_ACCOUNT_STATUSES: ReadonlySet<AccountStatus> = new Set([
  "PROCESSED",
  "PROCESSING_FAILED",
  "EXCLUDED",
]);

export function computeRunStatus(
  accountStatuses: readonly AccountStatus[],
): Extract<RunStatus, "PROCESSED"> | null {
  if (accountStatuses.length === 0) return null;
  const allTerminal = accountStatuses.every((status) =>
    TERMINAL_ACCOUNT_STATUSES.has(status),
  );
  return allTerminal ? "PROCESSED" : null;
}

// The `ban_count`/`rated_count`/`failed_count` cache derivation (architecture
// Inv. #12: any stored counter must equal the value derived from the account
// grain). One helper so every write path — the stage-signal recompute
// (`handle-stage-signal.ts`) and the rerun loop-back (`rerun-run.ts`) — derives
// the cache identically; a new terminal `AccountStatus` is handled in one place.
export function computeRunCounters(accountStatuses: readonly AccountStatus[]): {
  banCount: number;
  ratedCount: number;
  failedCount: number;
} {
  return {
    banCount: accountStatuses.length,
    ratedCount: accountStatuses.filter((s) => s === "PROCESSED").length,
    failedCount: accountStatuses.filter((s) => s === "PROCESSING_FAILED")
      .length,
  };
}
