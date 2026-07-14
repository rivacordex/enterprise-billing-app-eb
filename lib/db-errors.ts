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
export function isUniqueViolation(
  err: unknown,
  constraintName: string,
): boolean {
  for (const candidate of [err, (err as { cause?: unknown } | null)?.cause]) {
    const pgError = candidate as Partial<PostgresError> | null | undefined;
    if (
      pgError?.code === "23505" &&
      pgError.constraint_name === constraintName
    ) {
      return true;
    }
  }
  return false;
}
