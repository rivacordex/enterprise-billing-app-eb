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
// `FROM billing.bar`, a trigger/FK referencing `billing.baz`, ...). Covers
// both quoted and unquoted forms on either side of the dot (`billing.foo`,
// `"billing".foo`, `billing."foo"`, `"billing"."foo"`), and whitespace
// permitted around the dot (`billing . foo`).
const BILLING_REFERENCE = /(?:\bbilling\b|"billing")\s*\.\s*(?:\w+|"[^"]+")/i;

export interface BillingBoundaryViolation {
  file: string;
  line: number;
  text: string;
}

// PostgreSQL dollar-quoted string tag opener at position `i` (`sql[i] === "$"`):
// `$$` or `$tag$`, where `tag` follows unquoted-identifier rules — so `$1` (a
// positional parameter) and `$5` (money-looking text) are NOT tags. Returns the
// full delimiter (e.g. `$$`, `$body$`) or null.
function matchDollarTag(sql: string, i: number): string | null {
  let j = i + 1;
  while (j < sql.length && /[A-Za-z0-9_]/.test(sql[j] as string)) j += 1;
  if (sql[j] !== "$") return null;
  const tag = sql.slice(i + 1, j);
  if (tag !== "" && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(tag)) return null;
  return sql.slice(i, j + 1);
}

// Blanks out SQL comments AND single-quoted string-literal contents (both
// replaced by spaces, newlines preserved so line numbers of any later match
// stay accurate). A naive `.replace(/--.*$/gm, "")` is unsafe: a `--` INSIDE a
// string literal (`'a--b'`) is not a comment, but the naive strip would treat
// it as one and blank the rest of the line — silently erasing any real
// `billing.<ident>` reference that follows it on the SAME line (a false
// negative, the dangerous direction for a boundary gate). This is a small
// state machine that only treats `--`/`/* */` as comments when NOT inside a
// string, and blanks single-quoted string CONTENTS so a `billing.*` merely
// mentioned inside a literal (e.g. an error-message string) is neither a false
// negative source nor a false positive.
//
// Dollar-quoted literals (`$$…$$`, `$tag$…$tag$`) are recognised too, but their
// CONTENTS are kept VISIBLE, not blanked: they are almost always function /
// trigger BODIES, and a body that does `INSERT INTO billing.*` is a real write
// that must be flagged (fail closed). Recognising them also stops an apostrophe
// inside a body (`$$O'Brien$$`, legal because dollar-quoting avoids escaping)
// from being mis-parsed as a single-quote that swallows the following statement
// — the false negative this branch closes. Inner `--` line comments inside a
// body are still stripped (they are comments in the body's own SQL). Real code
// references to `billing.<ident>` are left intact and matched.
function stripSqlComments(sql: string): string {
  const out: string[] = [];
  const n = sql.length;
  let i = 0;
  while (i < n) {
    const c = sql[i] as string; // `i < n` guarantees this is defined
    const next = sql[i + 1]; // may be undefined at end-of-input; comparisons handle it

    // Line comment: -- … to end of line (keep the newline itself).
    if (c === "-" && next === "-") {
      while (i < n && sql[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }

    // Block comment: /* … */ (may span lines; preserve the newlines).
    if (c === "/" && next === "*") {
      out.push("  ");
      i += 2;
      while (i < n && !(sql[i] === "*" && sql[i + 1] === "/")) {
        out.push(sql[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }

    // Single-quoted string literal: '…' with '' as an embedded quote. Blank
    // the contents (so a `--`/`/*` inside is not seen as a comment, and a
    // `billing.*` mention inside is not matched), keeping the delimiters.
    if (c === "'") {
      out.push("'");
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out.push("  ");
          i += 2;
          continue;
        }
        if (sql[i] === "'") {
          out.push("'");
          i += 1;
          break;
        }
        out.push(sql[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      continue;
    }

    // Dollar-quoted literal: $$…$$ or $tag$…$tag$ (PostgreSQL). Contents are
    // kept VISIBLE (a body that writes `billing.*` is a real write — flag it),
    // except inner `--` line comments are still stripped. Checked AFTER the
    // single-quote branch, so a `$$` inside a '…' string is consumed as string
    // content, never treated as a dollar-quote opener.
    if (c === "$") {
      const open = matchDollarTag(sql, i);
      if (open) {
        out.push(open);
        i += open.length;
        while (i < n && !sql.startsWith(open, i)) {
          if (sql[i] === "-" && sql[i + 1] === "-") {
            while (i < n && sql[i] !== "\n") {
              out.push(" ");
              i += 1;
            }
            continue;
          }
          out.push(sql[i] as string);
          i += 1;
        }
        if (i < n) {
          out.push(open);
          i += open.length;
        }
        continue;
      }
    }

    out.push(c);
    i += 1;
  }
  return out.join("");
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
  // Match over the WHOLE stripped text, not line by line, so a reference split
  // across a newline (`billing.\n  foo`) is still caught — `\s*` around the dot
  // already spans newlines. The 1-indexed line number is derived from the
  // match offset (the line the reference STARTS on).
  const re = new RegExp(BILLING_REFERENCE.source, "gi");
  let match: RegExpExecArray | null;
  while ((match = re.exec(stripped)) !== null) {
    const line = stripped.slice(0, match.index).split("\n").length;
    violations.push({
      file: filePath,
      line,
      text: match[0].replace(/\s+/g, " "),
    });
    if (match.index === re.lastIndex) re.lastIndex += 1; // never loop on a zero-width match
  }
  return violations;
}

export function checkRatingMigrationBoundary(
  migrationsDir: string,
): BillingBoundaryViolation[] {
  return findRatingMigrationFiles(migrationsDir).flatMap((file) =>
    checkFileForBillingWrites(join(migrationsDir, file)),
  );
}
