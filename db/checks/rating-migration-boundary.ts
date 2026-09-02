import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

// Side-effect-free (no CLI logic, no process.exit) — the same
// data-module/runner split rm02 used for the event-catalog seed, so
// tests/rating/rm13-migration-boundary.test.ts can import the checker
// without triggering a CLI run. The runner is check-rating-migration-
// boundary.ts.
//
// rm13-spec D4/Implementation §4 — the source-level half of Inv #17/#18: no
// rating migration may write `billing.*`. The runtime half (rating_runtime
// holds no CONNECT on the billing database) is asserted by the grant suite
// (rm03); this scans the migration SQL text itself, so the boundary is
// caught at review time, not just at runtime.
//
// "A rating migration" is identified by filename, matching the convention
// every rating migration has used so far (`ratemgmt-code-standards.md` §8:
// `db/migrations/00NN_rating.sql`) rather than by parsing which schema each
// statement creates — a future rating migration that adds a column (e.g.
// `00NN_rating_add_x.sql`) is still caught by the same pattern.
const RATING_MIGRATION_FILENAME = /rating/i;
const SQL_MIGRATION_FILE = /\.sql$/i;

// A schema-qualified `billing.<identifier>` reference — the shape any real
// DDL/DML against the billing schema takes (`INSERT INTO billing.foo`,
// `FROM billing.bar`, a trigger/FK referencing `billing.baz`, ...).
const BILLING_REFERENCE = /\bbilling\.\w+/i;

export interface BillingBoundaryViolation {
  file: string;
  line: number;
  text: string;
}

// Blanks out block comments (preserving line breaks, so line numbers of any
// later match stay accurate) and drops line comments, so prose describing
// the very invariant this check enforces (e.g. "no FK into billing.*") is
// never mistaken for a real reference.
function stripSqlComments(sql: string): string {
  const noBlockComments = sql.replace(/\/\*[\s\S]*?\*\//g, (match) =>
    match.replace(/[^\n]/g, " "),
  );
  return noBlockComments.replace(/--.*$/gm, "");
}

export function findRatingMigrationFiles(migrationsDir: string): string[] {
  return readdirSync(migrationsDir)
    .filter(
      (f) => SQL_MIGRATION_FILE.test(f) && RATING_MIGRATION_FILENAME.test(f),
    )
    .sort();
}

export function checkFileForBillingWrites(
  filePath: string,
): BillingBoundaryViolation[] {
  const stripped = stripSqlComments(readFileSync(filePath, "utf8"));
  const violations: BillingBoundaryViolation[] = [];
  stripped.split("\n").forEach((line, idx) => {
    const match = BILLING_REFERENCE.exec(line);
    if (match) {
      violations.push({ file: filePath, line: idx + 1, text: match[0] });
    }
  });
  return violations;
}

export function checkRatingMigrationBoundary(
  migrationsDir: string,
): BillingBoundaryViolation[] {
  return findRatingMigrationFiles(migrationsDir).flatMap((file) =>
    checkFileForBillingWrites(join(migrationsDir, file)),
  );
}
