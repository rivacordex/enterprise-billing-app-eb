import { readFileSync } from "node:fs";
import { join } from "node:path";

import { parse as parseYaml } from "yaml";
import type postgresjs from "postgres";

// bm40-spec (TC43) — the extracted-SQL harness. It parses the DEPLOYED
// bill_run_processing flow and runs ITS OWN `aggregation`/`verification` psql
// heredocs, instead of a hand-copied double. The bm40 P0 (the deployed flow
// failing every account post-PC14 while the double stayed green) existed
// BECAUSE the double could drift from the flow; running the flow's actual SQL
// text makes that class of drift structurally impossible — a rename or any
// other edit to the flow's heredoc is picked up here with zero code change.
//
// Design (bm40-spec §Implementation §2):
//   (a) parse the YAML;
//   (b) pull the named step's heredoc (the `aggregation` / `verification`
//       psql body);
//   (c) assert it carries no Kestra `{{ }}` pebble — the heredoc must stand
//       alone as plain SQL, bound only through the psql `:'var'` / GUC
//       mechanism the flow itself uses;
//   (d) rebind the flow's `-v`/GUC variables to test values (psql's `:'var'`
//       is a textual, quoted-literal substitution — never a prepared-statement
//       bind — so every value is passed through as a string here too, exactly
//       mirroring psql's own semantics, including where the heredoc appends
//       its own `::type` cast);
//   (e) run the heredoc's statements in one `sql.begin` transaction, matching
//       the flow's own `BEGIN; … COMMIT;`.

const FLOW_PATH = join(
  process.cwd(),
  "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
);

interface KestraNode {
  id?: string;
  tasks?: KestraNode[];
  commands?: string[];
}

let cachedFlow: KestraNode | undefined;

function loadFlow(): KestraNode {
  // Parsed once per process — the volume suite drives aggregation thousands
  // of times and the flow file never changes mid-run.
  if (!cachedFlow) {
    const text = readFileSync(FLOW_PATH, "utf8");
    cachedFlow = parseYaml(text) as KestraNode;
  }
  return cachedFlow;
}

function findTaskById(node: KestraNode, id: string): KestraNode | undefined {
  if (node.id === id) return node;
  for (const child of node.tasks ?? []) {
    const found = findTaskById(child, id);
    if (found) return found;
  }
  return undefined;
}

const HEREDOC_RE = /<<'SQL'\r?\n([\s\S]*?)\r?\nSQL\b/;

/**
 * Throws when `text` still carries an unstripped Kestra pebble expression.
 * Exported standalone (bm40-spec harness self-test) so this failure mode is
 * unit-testable on a synthetic string, not only against the real flow file.
 */
export function assertNoPebble(text: string, context: string): void {
  if (text.includes("{{")) {
    throw new Error(
      `extract-flow-sql: ${context} contains an unstripped Kestra pebble ` +
        `expression ({{ ... }}) — the harness only trusts the <<'SQL' heredoc ` +
        `body, never the surrounding shell/pebble scaffolding; this body must ` +
        `be bound purely through psql :'var' substitution or set_config/` +
        `current_setting GUCs`,
    );
  }
}

/**
 * Pulls the psql heredoc body out of a `scripts.shell.Commands` task's
 * `commands`, by task id (e.g. "aggregation", "verification").
 */
export function extractStageHeredoc(stageId: string): string {
  const task = findTaskById(loadFlow(), stageId);
  if (!task) {
    throw new Error(
      `extract-flow-sql: no task with id "${stageId}" found in ${FLOW_PATH}`,
    );
  }
  const script = task.commands?.[0];
  if (typeof script !== "string") {
    throw new Error(
      `extract-flow-sql: task "${stageId}" is not a shell Commands task with a heredoc body`,
    );
  }
  const match = HEREDOC_RE.exec(script);
  if (!match) {
    throw new Error(
      `extract-flow-sql: task "${stageId}" has no <<'SQL' ... SQL heredoc to extract`,
    );
  }
  const body = match[1]!;
  assertNoPebble(body, `task "${stageId}"'s heredoc`);
  return body;
}

// Strips the heredoc's own explicit `BEGIN;`/`COMMIT;` — the equivalent
// transaction boundary is provided by the caller's `sql.begin(...)` instead,
// so the flow's own BEGIN/COMMIT text would otherwise double up (and a
// literal mid-transaction COMMIT would end `sql.begin`'s wrapper early).
function stripExplicitTransactionBounds(sql: string): string {
  let text = sql.trim();
  if (text.startsWith("BEGIN;")) {
    text = text.slice("BEGIN;".length).trimStart();
  }
  if (text.endsWith("COMMIT;")) {
    text = text.slice(0, -"COMMIT;".length).trimEnd();
  }
  return text;
}

type SplitState = "normal" | "line_comment" | "single_quote" | "dollar_quote";

/**
 * Splits a block of SQL into its top-level `;`-terminated statements,
 * respecting line comments (`-- …`), single-quoted strings (incl. the SQL
 * `''` escape), and dollar-quoted blocks (`$$ … $$` / `$tag$ … $tag$`) — a
 * semicolon inside any of those must never be mistaken for a statement
 * terminator (the flow's `DO $$ … END $$;` blocks depend on this).
 */
export function splitSqlStatements(sqlText: string): string[] {
  const statements: string[] = [];
  let current = "";
  let state: SplitState = "normal";
  let dollarTag = "";
  let i = 0;
  const n = sqlText.length;

  while (i < n) {
    const ch = sqlText[i]!;

    if (state === "normal") {
      if (ch === "-" && sqlText[i + 1] === "-") {
        state = "line_comment";
        current += "--";
        i += 2;
        continue;
      }
      if (ch === "'") {
        state = "single_quote";
        current += ch;
        i += 1;
        continue;
      }
      if (ch === "$") {
        const tagMatch = /^\$[A-Za-z0-9_]*\$/.exec(sqlText.slice(i));
        if (tagMatch) {
          dollarTag = tagMatch[0];
          state = "dollar_quote";
          current += dollarTag;
          i += dollarTag.length;
          continue;
        }
      }
      if (ch === ";") {
        statements.push(current);
        current = "";
        i += 1;
        continue;
      }
      current += ch;
      i += 1;
      continue;
    }

    if (state === "line_comment") {
      current += ch;
      if (ch === "\n") state = "normal";
      i += 1;
      continue;
    }

    if (state === "single_quote") {
      current += ch;
      if (ch === "'" && sqlText[i + 1] === "'") {
        current += "'";
        i += 2;
        continue;
      }
      if (ch === "'") state = "normal";
      i += 1;
      continue;
    }

    // state === "dollar_quote"
    if (sqlText.startsWith(dollarTag, i)) {
      current += dollarTag;
      i += dollarTag.length;
      state = "normal";
      dollarTag = "";
      continue;
    }
    current += ch;
    i += 1;
  }

  if (current.trim().length > 0) statements.push(current);

  return statements.map((s) => s.trim()).filter((s) => s.length > 0);
}

const PSQL_VAR_RE = /:'(\w+)'/g;

/**
 * Rebinds a statement's psql `:'var'` tokens to numbered placeholders bound
 * through `postgres.js`'s extended protocol, pulling each value from
 * `values` by name. Throws when a statement references a variable `values`
 * does not supply — the harness self-test for "a heredoc that reads an unset
 * GUC fails loudly": every GUC the flow sets via `set_config` is first routed
 * through exactly this binder (see `runAggregation`/`runVerification` below),
 * so a GUC the caller forgot to supply a test value for is caught HERE,
 * before any query reaches the server.
 *
 * Unlike `splitSqlStatements`, this scans blind to quote/comment state (real
 * psql IS quote/comment-aware when deciding where `:'var'` substitution
 * applies). Safe today — none of the flow's heredocs puts a `:'knownVarName'`
 * sequence inside a string literal or a `--` comment — but a future heredoc
 * edit that does would need this binder taught the same state machine.
 */
export function bindPsqlVars(
  sqlText: string,
  values: Readonly<Record<string, string>>,
): { text: string; params: string[] } {
  const params: string[] = [];
  const text = sqlText.replace(PSQL_VAR_RE, (_match, name: string) => {
    if (!(name in values)) {
      throw new Error(
        `extract-flow-sql: statement references :'${name}' but no test value was supplied for it`,
      );
    }
    params.push(values[name]!);
    return `$${params.length}`;
  });
  return { text, params };
}

async function runHeredocStatements(
  tx: postgresjs.TransactionSql<Record<string, unknown>>,
  heredoc: string,
  values: Readonly<Record<string, string>>,
): Promise<void> {
  for (const statement of splitSqlStatements(heredoc)) {
    const { text, params } = bindPsqlVars(statement, values);
    await tx.unsafe(text, params);
  }
}

// ---------------------------------------------------------------------------
// Stage runners — drop-in replacements for the retired
// tests/db/helpers/billrun-aggregate.ts / billrun-verify.ts hand-copied
// doubles. Same exported names and signatures, so callers only change their
// import path (bm40-spec §Implementation §2).
// ---------------------------------------------------------------------------

export interface AggregateParams {
  runId: string;
  ban: string;
  attempt: number;
  periodStart: string;
  periodEnd: string;
  glEventAt: string;
  // bm42-spec §Implementation §1 — the flow's `capacity_max_bands` input
  // (default 1, mirroring the flow's own `defaults: 1`). Optional so every
  // pre-bm42 caller (bm28/bm29's aggregation suites) is unaffected; a
  // capacity test overrides it to exercise CAPACITY_MULTI_STEP_UNSUPPORTED
  // (TC52).
  capacityMaxBands?: number;
  // bm43-spec §Implementation §1 — the flow's `capacity_rate_matching` gate
  // (default true, mirroring the flow's own `defaults: true`). Optional so
  // every pre-bm43 caller is unaffected; a gate test overrides it to false
  // to exercise the WARN-and-bill-Model-1 path.
  capacityRateMatching?: boolean;
}

export async function runAggregation(
  sql: postgresjs.Sql,
  {
    runId,
    ban,
    attempt,
    periodStart,
    periodEnd,
    glEventAt,
    capacityMaxBands,
    capacityRateMatching,
  }: AggregateParams,
): Promise<void> {
  const heredoc = stripExplicitTransactionBounds(
    extractStageHeredoc("aggregation"),
  );
  const values: Record<string, string> = {
    run: runId,
    ban,
    attempt: String(attempt),
    period_start: periodStart,
    period_end: periodEnd,
    gl_event_at: glEventAt,
    capacity_max_bands: String(capacityMaxBands ?? 1),
    capacity_rate_matching: String(capacityRateMatching ?? true),
  };
  await sql.begin((tx) => runHeredocStatements(tx, heredoc, values));
}

export interface VerificationParams {
  runId: string;
  ban: string;
  attempt: number;
  // bm43-spec §Implementation §1 — see AggregateParams.capacityRateMatching.
  capacityRateMatching?: boolean;
}

export interface VerificationOutcome {
  stageStatus: "DONE";
  // A SOFT, advisory finding (or null). Never blocks — surfaced for information.
  softFinding: string | null;
}

export async function runVerification(
  sql: postgresjs.Sql,
  { runId, ban, attempt, capacityRateMatching }: VerificationParams,
): Promise<VerificationOutcome> {
  const heredoc = extractStageHeredoc("verification");
  const values: Record<string, string> = {
    run: runId,
    ban,
    attempt: String(attempt),
    capacity_rate_matching: String(capacityRateMatching ?? true),
  };
  // Runs the flow's OWN statements verbatim: the `SELECT set_config(...)`
  // (rebinding the GUCs the DO block below reads) then the `DO $$ ... END $$;`
  // reconciliation block. A HARD RECONCILIATION_MISMATCH's RAISE EXCEPTION
  // surfaces here as a rejected promise carrying the server's own message
  // text — nothing about the HARD path is reimplemented.
  await sql.begin((tx) => runHeredocStatements(tx, heredoc, values));

  // The DO block's SOFT finding is a RAISE NOTICE — a side-channel psql logs
  // but postgres.js has no per-call hook for here (only a client-wide
  // `onnotice` set at connection time, outside this helper's control). Only
  // reachable once the HARD check above has already passed, so this read is
  // advisory-only: it reconstructs the identical message from the same
  // `total_amount` the flow's own DO block just read, never substituting for
  // the reconciliation logic itself.
  const [bill] = await sql<{ total_amount: string }[]>`
    SELECT total_amount
    FROM   billing.customer_bill
    WHERE  ref_bill_run_id = ${runId}
      AND  ref_billing_account_id = ${ban}
  `;

  const softFinding =
    bill && Number(bill.total_amount) <= 0
      ? `NON_POSITIVE_TOTAL (SOFT): total_amount ${bill.total_amount} <= 0 (advisory, non-blocking)`
      : null;

  return { stageStatus: "DONE", softFinding };
}
