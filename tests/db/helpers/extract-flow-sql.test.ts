import { describe, expect, it } from "vitest";

import {
  assertNoPebble,
  bindPsqlVars,
  extractStageHeredoc,
  splitSqlStatements,
} from "@/tests/db/helpers/extract-flow-sql";

// bm40-spec (TC43) — harness self-tests, DB-free (no DATABASE_URL needed: this
// file only parses YAML/strings). Covers the harness's own failure modes per
// the spec's Implementation §2 / Verification checklist: a heredoc that reads
// an unset GUC fails loudly, and an unstripped pebble expression is detected
// rather than silently run.

describe("extract-flow-sql — assertNoPebble", () => {
  it("passes a clean SQL string through untouched", () => {
    expect(() => assertNoPebble("SELECT 1;", "test")).not.toThrow();
  });

  it("throws on an unstripped Kestra pebble expression", () => {
    expect(() =>
      assertNoPebble(
        "SELECT '{{ inputs.bill_run_id }}';",
        "a synthetic heredoc",
      ),
    ).toThrow(/unstripped Kestra pebble/);
  });
});

describe("extract-flow-sql — bindPsqlVars", () => {
  it("rebinds a single :'var' token to $1 and collects its value", () => {
    const { text, params } = bindPsqlVars("WHERE ban = :'ban'", {
      ban: "BAN-1",
    });
    expect(text).toBe("WHERE ban = $1");
    expect(params).toEqual(["BAN-1"]);
  });

  it("assigns sequential placeholders across distinct vars, in order of appearance", () => {
    const { text, params } = bindPsqlVars(
      "WHERE run = :'run' AND ban = :'ban' AND attempt = :'attempt'::int",
      { run: "BRN-1", ban: "BAN-1", attempt: "2" },
    );
    expect(text).toBe("WHERE run = $1 AND ban = $2 AND attempt = $3::int");
    expect(params).toEqual(["BRN-1", "BAN-1", "2"]);
  });

  it("preserves a trailing ::cast exactly", () => {
    const { text } = bindPsqlVars("SELECT :'period_start'::date", {
      period_start: "2026-06-01",
    });
    expect(text).toBe("SELECT $1::date");
  });

  it("leaves :'var' inside a -- line comment untouched (the flow's own explanatory comments)", () => {
    const sqlText =
      "-- psql does not substitute :'var' inside a dollar-quoted body\nWHERE ban = :'ban'";
    const { text, params } = bindPsqlVars(sqlText, { ban: "BAN-1" });
    expect(text).toBe(
      "-- psql does not substitute :'var' inside a dollar-quoted body\nWHERE ban = $1",
    );
    expect(params).toEqual(["BAN-1"]);
  });

  it("leaves :'var' inside a single-quoted string untouched, incl. the '' escape", () => {
    // The token's own quotes are doubled, so `:''var''` sits wholly inside one
    // valid literal ('it''s :''var'' here') and must survive verbatim.
    const { text, params } = bindPsqlVars(
      "SELECT 'it''s :''var'' here', :'ban'",
      { ban: "BAN-1" },
    );
    expect(text).toBe("SELECT 'it''s :''var'' here', $1");
    expect(params).toEqual(["BAN-1"]);
  });

  it("leaves :'var' inside a dollar-quoted body untouched (psql does not substitute there)", () => {
    const { text, params } = bindPsqlVars(
      "DO $$ BEGIN PERFORM :'var'; END $$; SELECT :'ban'",
      { ban: "BAN-1" },
    );
    expect(text).toBe("DO $$ BEGIN PERFORM :'var'; END $$; SELECT $1");
    expect(params).toEqual(["BAN-1"]);
  });

  it("resumes substitution after the comment ends at the newline", () => {
    const { text, params } = bindPsqlVars("-- :'a'\n:'b' -- :'c'\n:'d'", {
      b: "B",
      d: "D",
    });
    expect(text).toBe("-- :'a'\n$1 -- :'c'\n$2");
    expect(params).toEqual(["B", "D"]);
  });

  it("still throws for an unset variable that sits in plain SQL, even next to a comment", () => {
    expect(() => bindPsqlVars("-- :'ok'\nWHERE x = :'missing'", {})).toThrow(
      /:'missing' but no test value/,
    );
  });

  it("does not treat a lone colon or a ::cast as a variable", () => {
    const { text, params } = bindPsqlVars("SELECT a::int, b:c, :'ban'::text", {
      ban: "BAN-1",
    });
    expect(text).toBe("SELECT a::int, b:c, $1::text");
    expect(params).toEqual(["BAN-1"]);
  });

  it("fails loudly when a heredoc reads an unset GUC/variable (no silent fallback)", () => {
    expect(() => bindPsqlVars("WHERE ban = :'ban'", {})).toThrow(
      /no test value was supplied/,
    );
  });
});

describe("extract-flow-sql — splitSqlStatements", () => {
  it("splits plain statements on top-level semicolons", () => {
    expect(splitSqlStatements("SELECT 1; SELECT 2;")).toEqual([
      "SELECT 1",
      "SELECT 2",
    ]);
  });

  it("never splits inside a dollar-quoted DO block, even across embedded semicolons and quotes", () => {
    const sql = [
      "SELECT 1;",
      "DO $$ BEGIN RAISE NOTICE 'a;b'' c'; END; $$;",
      "SELECT 2;",
    ].join("\n");
    const statements = splitSqlStatements(sql);
    expect(statements).toHaveLength(3);
    expect(statements[1]).toContain("RAISE NOTICE 'a;b'' c';");
  });

  it("never splits inside a single-quoted string, incl. the '' escape", () => {
    const statements = splitSqlStatements(
      "SELECT 'it''s; still one statement';",
    );
    expect(statements).toHaveLength(1);
  });

  it("ignores a semicolon inside a line comment", () => {
    const statements = splitSqlStatements(
      "-- a comment; with a semicolon\nSELECT 1;",
    );
    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain("SELECT 1");
  });
});

describe("extract-flow-sql — extractStageHeredoc (against the real deployed flow)", () => {
  it("extracts the aggregation heredoc, free of Kestra pebble", () => {
    const heredoc = extractStageHeredoc("aggregation");
    expect(heredoc).toContain("billrun_delete_trial_bill");
    expect(heredoc).not.toContain("{{");
  });

  it("extracts the verification heredoc, free of Kestra pebble", () => {
    const heredoc = extractStageHeredoc("verification");
    expect(heredoc).toContain("RECONCILIATION_MISMATCH");
    expect(heredoc).not.toContain("{{");
  });

  it("throws for a stage id the flow does not define", () => {
    expect(() => extractStageHeredoc("not_a_real_stage")).toThrow(
      /no task with id/,
    );
  });
});
