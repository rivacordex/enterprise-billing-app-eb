// bm18-spec §Phase-2 review folds T9 — "a per-session rate limit on the
// draft route", backing the session-guarded draft-invoice PDF route. A plain
// in-memory sliding window keyed by an arbitrary caller-chosen string (the
// route keys on the session's user id); per-process only and reset on
// restart — an interactive-draft throttle, not a security control, so no new
// config/store is warranted for it (spec §Config/env — "No new env for draft
// rendering").
const hits = new Map<string, number[]>();

export function isRateLimited(
  key: string,
  maxRequests: number,
  windowMs: number,
): boolean {
  const now = Date.now();
  const cutoff = now - windowMs;
  const recent = (hits.get(key) ?? []).filter((t) => t > cutoff);
  recent.push(now);
  hits.set(key, recent);
  return recent.length > maxRequests;
}
