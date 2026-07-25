import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { logger } from "@/lib/logger";

// Build-only script (`npm run pgledger:transform`), never imported by
// application code. Reads the vendored upstream `pgledger.sql` +
// `UPSTREAM_COMMIT` and writes `billing-pgledger.generated.sql`: pgledger
// schema-qualified into `billing`, with `SET search_path = billing,
// pg_catalog` injected into every function. This is a pure text
// qualification pass — see ac01-pgledger-foundation.md §2.2: it changes
// *namespaces*, never *behaviour*. Do not hand-edit the generated output;
// re-run this script instead (module invariant #14).

const PGLEDGER_SQL_PATH = join(import.meta.dirname, "pgledger.sql");
const UPSTREAM_COMMIT_PATH = join(import.meta.dirname, "UPSTREAM_COMMIT");
const OUTPUT_PATH = join(import.meta.dirname, "billing-pgledger.generated.sql");

const SCHEMA = "billing";
const SEARCH_PATH_CLAUSE = `SET search_path = ${SCHEMA}, pg_catalog`;

// --- Expected shape of the vendored file, asserted before qualifying -----
// If a future upstream vendor bump changes these counts, the transform
// fails loudly instead of silently passing through an unrecognised object
// (§3.2.4) — a human must look at the diff and extend the rules below.
const EXPECTED_COUNTS = {
  tables: 3, // pgledger_accounts, pgledger_transfers, pgledger_entries
  views: 3, // pgledger_accounts_view, pgledger_transfers_view, pgledger_entries_view
  types: 1, // transfer_request
  indexes: 5, // 3 on pgledger_transfers, 2 on pgledger_entries
  functions: 9,
} as const;

const RECOGNISED_STATEMENT_PREFIXES = [
  /^CREATE TABLE\b/,
  /^CREATE VIEW\b/,
  /^CREATE TYPE\b/,
  /^CREATE INDEX\b/,
  /^CREATE (OR REPLACE )?FUNCTION\b/,
] as const;

function fail(message: string): never {
  logger.error("pgledger:transform failed.", { message });
  process.exit(1);
}

function readInputs(): { pgledgerSql: string; upstreamCommit: string } {
  let pgledgerSql: string;
  try {
    pgledgerSql = readFileSync(PGLEDGER_SQL_PATH, "utf8");
  } catch {
    return fail(`Missing vendored input: ${PGLEDGER_SQL_PATH}`);
  }

  let upstreamCommit: string;
  try {
    upstreamCommit = readFileSync(UPSTREAM_COMMIT_PATH, "utf8").trim();
  } catch {
    return fail(`Missing vendored input: ${UPSTREAM_COMMIT_PATH}`);
  }
  if (!/^[0-9a-f]{40}$/.test(upstreamCommit)) {
    return fail(
      `UPSTREAM_COMMIT does not look like a 40-char git SHA: "${upstreamCommit}"`,
    );
  }

  return { pgledgerSql, upstreamCommit };
}

function assertRecognisedShape(pgledgerSql: string): void {
  const counts = {
    tables: (pgledgerSql.match(/^CREATE TABLE\b/gm) ?? []).length,
    views: (pgledgerSql.match(/^CREATE VIEW\b/gm) ?? []).length,
    types: (pgledgerSql.match(/^CREATE TYPE\b/gm) ?? []).length,
    indexes: (pgledgerSql.match(/^CREATE INDEX\b/gm) ?? []).length,
    functions: (pgledgerSql.match(/^CREATE (OR REPLACE )?FUNCTION\b/gm) ?? [])
      .length,
  };
  for (const key of Object.keys(
    EXPECTED_COUNTS,
  ) as (keyof typeof EXPECTED_COUNTS)[]) {
    if (counts[key] !== EXPECTED_COUNTS[key]) {
      fail(
        `Upstream pgledger.sql shape changed: expected ${EXPECTED_COUNTS[key]} ` +
          `${key}, found ${counts[key]}. This transform's qualification rules ` +
          `were written for a specific upstream shape — review pgledger.sql's ` +
          `diff against the previous UPSTREAM_COMMIT, extend the rules in ` +
          `transform.ts for any new object kind, then re-run.`,
      );
    }
  }
}

// --- Qualification rules ---------------------------------------------------
// Applied to the *code* portion of each line only (see splitCodeAndComment
// below) so upstream comment prose is left untouched, per §2.2. Order does
// not matter between rules 1-3 (disjoint identifiers); the TRANSFER_REQUEST
// rules (4-6) must run after rule 1 would otherwise be a no-op for them
// (their identifiers don't start with pgledger_, so there is no actual
// ordering dependency, but they are kept separate because they need
// name-vs-type disambiguation that the generic rule can't do safely).

function qualifyCode(code: string): string {
  let out = code;

  // 1. Every pgledger_* identifier (tables, views, functions, and the
  //    table-row composite types referenced by pgledger_accounts /
  //    PGLEDGER_ACCOUNTS) — case-insensitive since upstream mixes
  //    UPPERCASE (return types, param types) and lowercase (everywhere
  //    else); Postgres folds unquoted identifiers to lowercase regardless,
  //    so prefixing without changing case is semantically identical to
  //    prefixing the lowercased form.
  out = out.replace(/\bpgledger_\w+/gi, (m) => `${SCHEMA}.${m}`);

  // 2. The vendored ULID helper this fork depends on (db/pgledger/ulid.sql,
  //    itself qualified into `billing` — see that file's header). Only the
  //    call site inside pgledger_generate_id needs rewriting.
  out = out.replace(/\buuid_to_ulid\b/gi, (m) => `${SCHEMA}.${m}`);

  // 3. (No bare `format_ulid` calls appear in pgledger.sql itself — only
  //    inside ulid.sql, which qualifies its own internal call directly.)

  // 4-6. TRANSFER_REQUEST: the one non-pgledger_-prefixed schema object.
  //    Every occurrence in pgledger.sql happens to be a genuine type
  //    reference EXCEPT the DECLARE line where the same lowercase token
  //    also names a local variable (`transfer_request transfer_request;`)
  //    — handled as its own literal rule (6) so the variable name is left
  //    alone and only the type half is qualified.
  out = out.replace(
    /\bCREATE TYPE TRANSFER_REQUEST\b/, // 4: definition
    `CREATE TYPE ${SCHEMA}.transfer_request`,
  );
  out = out.replace(
    /::TRANSFER_REQUEST\b/g, // 5a: cast
    `::${SCHEMA}.transfer_request`,
  );
  out = out.replace(
    /\bTRANSFER_REQUEST(\s*\[\])/g, // 5b: array-typed params
    `${SCHEMA}.transfer_request$1`,
  );
  out = out.replace(
    /\btransfer_request transfer_request;/, // 6: DECLARE
    `transfer_request ${SCHEMA}.transfer_request;`,
  );

  return out;
}

function splitCodeAndComment(line: string): { code: string; comment: string } {
  const idx = line.indexOf("--");
  if (idx === -1) return { code: line, comment: "" };
  return { code: line.slice(0, idx), comment: line.slice(idx) };
}

function qualifyLine(line: string): string {
  const { code, comment } = splitCodeAndComment(line);
  return qualifyCode(code) + comment;
}

function injectSearchPath(sql: string): string {
  // Every function ends its final line with `$$ LANGUAGE <lang>[ <volatility>];`
  // (verified true of every one of the 9 functions at the pinned commit —
  // assertRecognisedShape's function count is the guard that this hasn't
  // silently drifted). Insert the SET clause before the terminating `;`.
  return sql.replace(
    /^\$\$ LANGUAGE (\w+)( \w+)?;$/gm,
    (_match, lang: string, volatility: string | undefined) =>
      `$$ LANGUAGE ${lang}${volatility ?? ""} ${SEARCH_PATH_CLAUSE};`,
  );
}

// --- Statement splitting for --> statement-breakpoint ----------------------
// Dollar-quote-aware: a `;` inside a `$$ ... $$` function body is not a
// statement boundary. pgledger.sql only ever uses the bare `$$` tag (never
// `$tag$`), so tracking a single boolean toggle is sufficient.
function splitTopLevelStatements(sql: string): string[] {
  const statements: string[] = [];
  let depth = 0; // dollar-quote nesting (0 = outside, >0 = inside $$...$$)
  let current = "";
  let i = 0;
  while (i < sql.length) {
    if (sql.startsWith("$$", i)) {
      depth = depth === 0 ? 1 : 0;
      current += "$$";
      i += 2;
      continue;
    }
    const ch = sql[i];
    current += ch;
    if (ch === ";" && depth === 0) {
      statements.push(current.trim());
      current = "";
    }
    i += 1;
  }
  const rest = current.trim();
  if (rest.length > 0) statements.push(rest);
  return statements.filter((s) => s.length > 0);
}

function assertNoUnqualifiedReferences(generated: string): void {
  // Scan only code portions (strip comments the same way qualifyLine does)
  // so the one deliberately-untouched comment doesn't trip this check.
  const codeOnly = generated
    .split("\n")
    .map((line) => splitCodeAndComment(line).code)
    .join("\n");

  const unqualifiedPgledger = codeOnly.match(/(?<!billing\.)\bpgledger_\w+/gi);
  if (unqualifiedPgledger) {
    fail(
      `Unqualified pgledger_* reference(s) survived: ${unqualifiedPgledger.join(", ")}`,
    );
  }

  const unqualifiedUuidToUlid = codeOnly.match(
    /(?<!billing\.)\buuid_to_ulid\b/gi,
  );
  if (unqualifiedUuidToUlid) {
    fail("Unqualified uuid_to_ulid reference survived.");
  }

  if (/\bTRANSFER_REQUEST\b/.test(codeOnly)) {
    fail("Unqualified TRANSFER_REQUEST reference survived.");
  }
}

// Pure: given the vendored inputs, returns the generated file content.
// Exported so the transform unit test (tests/pgledger/transform.test.ts)
// can exercise the qualification logic without touching the filesystem.
function buildGeneratedSql(
  pgledgerSql: string,
  upstreamCommit: string,
): string {
  assertRecognisedShape(pgledgerSql);

  const qualified = pgledgerSql.split("\n").map(qualifyLine).join("\n");
  const withSearchPath = injectSearchPath(qualified);

  const statements = splitTopLevelStatements(withSearchPath);
  for (const stmt of statements) {
    // Leading `--` comment lines (e.g. the uuidv7()-availability note above
    // the first CREATE FUNCTION) are part of the statement chunk for
    // breakpoint purposes but not the DDL keyword itself — skip them before
    // checking the statement's shape is one this transform knows about.
    const withoutLeadingComments = stmt
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .join("\n")
      .trim();
    const recognised = RECOGNISED_STATEMENT_PREFIXES.some((re) =>
      re.test(withoutLeadingComments),
    );
    if (!recognised) {
      fail(
        `Unrecognised top-level statement (transform doesn't know how to ` +
          `qualify it): ${withoutLeadingComments.slice(0, 80)}...`,
      );
    }
  }

  const banner =
    `-- GENERATED by db/pgledger/transform.ts from pgledger.sql @ ${upstreamCommit} — DO NOT EDIT\n` +
    `-- Regenerate with: npm run pgledger:transform\n\n`;

  const body = statements.join("\n--> statement-breakpoint\n\n");
  const generated = banner + body + "\n";

  assertNoUnqualifiedReferences(generated);

  return generated;
}

function main(): void {
  const { pgledgerSql, upstreamCommit } = readInputs();
  const generated = buildGeneratedSql(pgledgerSql, upstreamCommit);
  writeFileSync(OUTPUT_PATH, generated);
  const statementCount = generated.split("--> statement-breakpoint").length;
  logger.info("pgledger:transform wrote generated SQL.", {
    path: OUTPUT_PATH,
    statementCount,
  });
}

// CLI entry point only — guarded so importing this module (the transform
// unit test does) doesn't re-run/re-write as a side effect of import.
// pathToFileURL (not a raw `file://${argv[1]}` template) so this compares
// correctly on Windows, where argv[1] is backslash-separated and lacks the
// `file:///` scheme/leading-slash import.meta.url always has.
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  main();
}

export {
  PGLEDGER_SQL_PATH,
  OUTPUT_PATH,
  SCHEMA,
  buildGeneratedSql,
  qualifyLine,
  injectSearchPath,
  splitTopLevelStatements,
  readInputs,
};
