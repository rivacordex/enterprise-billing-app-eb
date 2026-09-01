// rm04-spec Implementation §7 / D9 — sets the LOCAL-ONLY kestra_engine role
// password after rm03a's bootstrap (db:bootstrap-kestra-roles) creates the
// role/database. A committed script, not an inline `sh -c "... node -e ..."`
// one-liner: the previous inline form nested a JS template-literal backtick
// inside a double-quoted shell string, which POSIX sh evaluates as command
// substitution regardless of the JS-side escaping — it silently ran `ALTER
// ROLE ...` as a shell command instead of passing it to Node, so the role
// password was never actually set. See kestra-setup's command in
// docker-compose.dev.yml.
import postgres from "postgres";

const password = process.env.KESTRA_DATASOURCES_POSTGRES_PASSWORD;
if (!password) {
  console.error("KESTRA_DATASOURCES_POSTGRES_PASSWORD is not set.");
  process.exit(1);
}

const sql = postgres(process.env.BOOTSTRAP_DATABASE_URL, { max: 1 });
try {
  // ALTER ROLE's PASSWORD clause doesn't take a bind parameter in every PG
  // version's extended-query path, so build the literal directly — the value
  // is a committed local-only dummy (never real credentials), and the
  // standard SQL-literal single-quote doubling still guards against a
  // malformed statement if it ever contains one.
  const escaped = password.replaceAll("'", "''");
  await sql.unsafe(`ALTER ROLE kestra_engine WITH PASSWORD '${escaped}'`);
  console.log("kestra_engine role password set.");
} finally {
  await sql.end();
}
