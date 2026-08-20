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
