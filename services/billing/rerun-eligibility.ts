// bm84 (D1) — the rerun's eligible set: every scoped account, minus EXCLUDED and posted,
// intersected with the selection (empty ⇒ all). Shared with the rerun warning read so the
// two can never disagree. Review fix — a pure module, so the read-only warning does not
// load the rerun's engine and capture graph; `rerun-run.ts` re-exports it.
export function selectRerunEligible<
  T extends { billingAccountId: string; status: string },
>(accounts: T[], postedIds: string[], accountIds: string[]): T[] {
  const posted = new Set(postedIds);
  const requested = new Set(accountIds);
  return accounts.filter(
    (a) =>
      a.status !== "EXCLUDED" &&
      !posted.has(a.billingAccountId) &&
      (requested.size === 0 || requested.has(a.billingAccountId)),
  );
}
