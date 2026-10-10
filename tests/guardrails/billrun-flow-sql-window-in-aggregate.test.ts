import { describe, expect, it } from "vitest";

import { extractStageHeredoc } from "@/tests/db/helpers/extract-flow-sql";

// bm42a — DB-free guard for known-issues §21 defect 21c2. Postgres rejects a
// window function inside an aggregate's arguments ("aggregate function calls
// cannot contain window function calls"). bm42 shipped
// `jsonb_agg(jsonb_build_object('band', row_number() OVER (...)))` in the
// `aggregation` step, so the whole statement could never run; only a database
// suite noticed, and the DB suites had never been run. This test reads the
// deployed flow's SQL (the harness's extracted heredocs, Inv #38) and fails in
// the fast unit run if a window function ever sits inside an aggregate call
// again, with no database needed.
//
// Heuristic, not a SQL parser: comments and string literals are blanked, each
// aggregate call's parenthesised argument list is found by depth counting, and
// nested `(SELECT ...)` subqueries are removed first (a subquery may legally
// use its own window function). What remains is searched for `OVER (`. A
// windowed aggregate such as `sum(x) OVER (...)` is fine: its `OVER` follows
// the closing parenthesis, outside the argument list.

const AGGREGATES = [
  "jsonb_agg",
  "json_agg",
  "jsonb_object_agg",
  "array_agg",
  "string_agg",
  "sum",
  "count",
  "avg",
  "min",
  "max",
  "bool_and",
  "bool_or",
];

const AGGREGATE_CALL_RE = new RegExp(
  `\\b(${AGGREGATES.join("|")})\\s*\\(`,
  "gi",
);

// Blank `-- …` comments and '…' literals (keeping length and newlines) so that
// text such as a comment mentioning `OVER (` or a quoted label cannot match.
function blankCommentsAndStrings(sql: string): string {
  let out = "";
  let i = 0;
  const n = sql.length;
  while (i < n) {
    const ch = sql[i]!;
    if (ch === "-" && sql[i + 1] === "-") {
      while (i < n && sql[i] !== "\n") {
        out += " ";
        i += 1;
      }
      continue;
    }
    if (ch === "'") {
      out += "'";
      i += 1;
      while (i < n) {
        if (sql[i] === "'" && sql[i + 1] === "'") {
          out += "  ";
          i += 2;
          continue;
        }
        if (sql[i] === "'") break;
        out += sql[i] === "\n" ? "\n" : " ";
        i += 1;
      }
      out += "'";
      i += 1;
      continue;
    }
    out += ch;
    i += 1;
  }
  return out;
}

// Index just past the `)` that closes the `(` at `openIndex`, or -1.
function matchingClose(text: string, openIndex: number): number {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === "(") depth += 1;
    else if (text[i] === ")") {
      depth -= 1;
      if (depth === 0) return i + 1;
    }
  }
  return -1;
}

// Remove every parenthesised group that starts with SELECT/WITH: a scalar or
// EXISTS subquery inside an argument list owns its own window scope.
function stripSubqueries(text: string): string {
  let out = text;
  for (;;) {
    const m = /\(\s*(?:SELECT|WITH)\b/i.exec(out);
    if (!m) return out;
    const end = matchingClose(out, m.index);
    if (end < 0) return out;
    out = out.slice(0, m.index) + " " + out.slice(end);
  }
}

interface WindowInAggregate {
  aggregate: string;
  argument: string;
}

function findWindowInsideAggregate(sql: string): WindowInAggregate[] {
  const cleaned = blankCommentsAndStrings(sql);
  const found: WindowInAggregate[] = [];
  for (const m of cleaned.matchAll(AGGREGATE_CALL_RE)) {
    const open = m.index! + m[0].length - 1;
    const end = matchingClose(cleaned, open);
    if (end < 0) continue;
    const inner = stripSubqueries(cleaned.slice(open + 1, end - 1));
    if (/\bOVER\s*\(/i.test(inner)) {
      found.push({
        aggregate: m[1]!.toLowerCase(),
        argument: inner.replace(/\s+/g, " ").trim().slice(0, 120),
      });
    }
  }
  return found;
}

describe("findWindowInsideAggregate (detector self-tests)", () => {
  it("flags the exact bm42 defect: row_number() OVER inside jsonb_agg(jsonb_build_object(...))", () => {
    const sql = `SELECT jsonb_agg(
      jsonb_build_object('band', row_number() OVER (PARTITION BY a, b ORDER BY c), 'x', 1)
      ORDER BY c) FROM t GROUP BY a`;
    const hits = findWindowInsideAggregate(sql);
    expect(hits).toHaveLength(1);
    expect(hits[0]!.aggregate).toBe("jsonb_agg");
  });

  it("flags a window function inside sum()/string_agg() too", () => {
    expect(
      findWindowInsideAggregate("SELECT sum(lag(x) OVER (ORDER BY y)) FROM t"),
    ).toHaveLength(1);
    expect(
      findWindowInsideAggregate(
        "SELECT string_agg(rank() OVER (ORDER BY y)::text, ',') FROM t",
      ),
    ).toHaveLength(1);
  });

  it("allows the fixed shape: the window function is computed in the SELECT list, the aggregate reads the column", () => {
    const sql = `WITH c AS (SELECT row_number() OVER (PARTITION BY a ORDER BY b) AS band_no FROM t)
      SELECT jsonb_agg(jsonb_build_object('band', band_no)) FROM c`;
    expect(findWindowInsideAggregate(sql)).toEqual([]);
  });

  it("allows a windowed aggregate: OVER follows the closing parenthesis", () => {
    expect(
      findWindowInsideAggregate("SELECT sum(x) OVER (PARTITION BY a) FROM t"),
    ).toEqual([]);
    expect(
      findWindowInsideAggregate(
        "SELECT lead(x) OVER (ORDER BY y), count(*) OVER () FROM t",
      ),
    ).toEqual([]);
  });

  it("allows a nested subquery that uses its own window function", () => {
    const sql = `SELECT max((SELECT row_number() OVER (ORDER BY z) FROM u LIMIT 1)) FROM t`;
    expect(findWindowInsideAggregate(sql)).toEqual([]);
  });

  it("ignores OVER ( in a -- comment and in a string literal", () => {
    const sql = `SELECT jsonb_agg(x) -- not row_number() OVER (ORDER BY y)
      , sum(CASE WHEN note = 'uses OVER (partition)' THEN 1 ELSE 0 END) FROM t`;
    expect(findWindowInsideAggregate(sql)).toEqual([]);
  });

  it("does not mistake a column named like an aggregate for a call", () => {
    expect(findWindowInsideAggregate("SELECT summary, counter FROM t")).toEqual(
      [],
    );
  });
});

describe("billrun flow SQL: no window function inside an aggregate (bm42a, known-issues §21 21c2)", () => {
  it.each(["validation", "collection", "aggregation", "verification"])(
    "the %s step's SQL has none",
    (stageId) => {
      const hits = findWindowInsideAggregate(extractStageHeredoc(stageId));
      expect(
        hits,
        hits.map((h) => `${h.aggregate}( ${h.argument} … )`).join("\n"),
      ).toEqual([]);
    },
  );
});
