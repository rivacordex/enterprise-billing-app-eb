import type { PostgresError } from "postgres";

// cm07-spec §3.4: translates a Postgres unique-violation (SQLSTATE 23505) on
// a specific constraint into a typed result instead of a raw exception.
// First needed here; reused by cm08 for the same `organization_registration_number`
// constraint on update.
//
// Drizzle wraps the raw driver error in a `DrizzleQueryError`, exposing the
// original `PostgresError` on `.cause` rather than throwing it directly —
// only caught by the real-DB integration test, not the mocked-repository
// unit test, so both `err` and `err.cause` are checked here.
//
// `constraintName` is OPTIONAL. When given, the match is exact (a caller on a
// non-partitioned table that must distinguish one constraint from another).
// When OMITTED, any SQLSTATE 23505 matches — REQUIRED for PARTITIONED tables:
// Postgres reports the violated LEAF-partition index name (e.g.
// `bill_run_account_stage_default_..._key`), NEVER the parent constraint name,
// so an exact-name match can never succeed there. Callers whose insert can only
// realistically hit one unique constraint (the M2M idempotency latches) use the
// no-name form.
export function isUniqueViolation(
  err: unknown,
  constraintName?: string,
): boolean {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const pgError = candidate as Partial<PostgresError> | null | undefined;
    if (pgError?.code !== "23505") continue;
    if (constraintName === undefined) return true;
    if (pgError.constraint_name === constraintName) return true;
  }
  return false;
}
