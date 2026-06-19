// Integration suites point a real `postgres()` client at `DATABASE_URL` and
// immediately `DROP SCHEMA ... CASCADE` against it. That's safe against the
// throwaway/CI containers this suite is designed for, but a misconfigured
// `DATABASE_URL` (e.g. accidentally pointing at a shared or production host)
// would silently destroy data. This is a last-line sanity check, not a
// substitute for using a dedicated database.
export function assertTestDatabaseUrl(databaseUrl: string): void {
  const url = new URL(databaseUrl);
  const isLocalHost =
    url.hostname === "localhost" || url.hostname === "127.0.0.1";
  const looksLikeTestDb = /test/i.test(url.pathname);

  if (!isLocalHost && !looksLikeTestDb) {
    throw new Error(
      `Refusing to run destructive integration-test schema drops against "${databaseUrl}". ` +
        "DATABASE_URL must point at localhost/127.0.0.1 or a database whose name contains " +
        '"test" — set it to a throwaway/CI Postgres container, not a shared or production host.',
    );
  }
}
