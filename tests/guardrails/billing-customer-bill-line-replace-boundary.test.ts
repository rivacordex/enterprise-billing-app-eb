import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm28-spec §Implementation §6 (guardrails §9.9 + the product read grant).
// Aggregation writes `customer_bill_line` as the whole-account replace (Inv #16,
// D22): drop the non-finalized `customer_bill` via the scoped SECURITY DEFINER
// `billrun_delete_trial_bill` (its lines cascade), then re-INSERT the header +
// lines. It must NEVER `INSERT … ON CONFLICT DO UPDATE` a line and NEVER issue a
// bare `DELETE` against `customer_bill_line` — `billrun_runtime` holds no
// table-level DELETE on it, so the scoped function is the only deletion path.
// This boundary test asserts those properties statically (no DB); the DB-gated
// `billrun-aggregation.integration.test.ts` proves the runtime behaviour.
describe("bm28 customer_bill_line whole-account-replace boundary (spec §Implementation §6)", () => {
  const ROLES_SQL = resolve(process.cwd(), "db/bootstrap/billrun-db-roles.sql");
  const FLOW_YML = resolve(
    process.cwd(),
    "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
  );

  function statements(path: string): string[] {
    return readFileSync(path, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // Strip `-- …` SQL line comments so documentation prose never trips a grep —
  // the assertions apply to executable SQL only.
  function code(statement: string): string {
    return statement
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .trim();
  }

  // ---- the product read grant (§3) ------------------------------------------
  it("grants billrun_runtime USAGE on the product schema", () => {
    const sql = readFileSync(ROLES_SQL, "utf8");
    expect(sql).toMatch(
      /GRANT\s+USAGE\s+ON\s+SCHEMA\s+"product"\s+TO\s+billrun_runtime/i,
    );
  });

  it("grants billrun_runtime SELECT on product.product_offering — no write, no GRANT ALL", () => {
    const grant = statements(ROLES_SQL)
      .map(code)
      .find(
        (s) => /"product"\."product_offering"/i.test(s) && /\bGRANT\b/i.test(s),
      );
    expect(grant).toBeDefined();
    expect(grant).toMatch(/\bGRANT\s+SELECT\b/i);
    expect(grant).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
    expect(grant).not.toMatch(/\bGRANT\s+ALL\b/i);
  });

  it("[CRITICAL] grants NO write privilege of any kind on the product schema", () => {
    const offenders = statements(ROLES_SQL)
      .map(code)
      .filter((s) => {
        const touchesProduct = /\bproduct\b/i.test(s);
        const isGrant = /\bGRANT\b/i.test(s);
        const hasWriteVerb =
          /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s) ||
          /\bGRANT\s+ALL\b/i.test(s);
        return touchesProduct && isGrant && hasWriteVerb;
      });
    expect(offenders).toEqual([]);
  });

  // ---- the bm29 pricing read grants (§3) ------------------------------------
  it("grants billrun_runtime USAGE on the ordering schema (bm29)", () => {
    const sql = readFileSync(ROLES_SQL, "utf8");
    expect(sql).toMatch(
      /GRANT\s+USAGE\s+ON\s+SCHEMA\s+"ordering"\s+TO\s+billrun_runtime/i,
    );
  });

  it("grants billrun_runtime SELECT on the recurring-price reads — no write, no GRANT ALL (bm29)", () => {
    for (const table of [
      /"product"\."product_offering_price"/i,
      /"ordering"\."order_item_price_override"/i,
    ]) {
      const grant = statements(ROLES_SQL)
        .map(code)
        .find((s) => table.test(s) && /\bGRANT\b/i.test(s));
      expect(grant).toBeDefined();
      expect(grant).toMatch(/\bGRANT\s+SELECT\b/i);
      expect(grant).not.toMatch(/\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i);
      expect(grant).not.toMatch(/\bGRANT\s+ALL\b/i);
    }
  });

  it("[CRITICAL] grants NO write privilege of any kind on the ordering schema (bm29)", () => {
    const offenders = statements(ROLES_SQL)
      .map(code)
      .filter((s) => {
        const touchesOrdering = /\bordering\b/i.test(s);
        const isGrant = /\bGRANT\b/i.test(s);
        const hasWriteVerb =
          /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s) ||
          /\bGRANT\s+ALL\b/i.test(s);
        return touchesOrdering && isGrant && hasWriteVerb;
      });
    expect(offenders).toEqual([]);
  });

  // ---- billrun_runtime holds no DELETE/UPDATE on customer_bill_line ----------
  it("[CRITICAL] grants billrun_runtime no DELETE and no UPDATE on customer_bill_line", () => {
    const offenders = statements(ROLES_SQL)
      .map(code)
      .filter(
        (s) =>
          /\bGRANT\b/i.test(s) &&
          /"customer_bill_line"/i.test(s) &&
          /\b(DELETE|UPDATE)\b/i.test(s),
      );
    expect(offenders).toEqual([]);
  });

  // ---- the flow's aggregation re-derivation ---------------------------------
  it("[CRITICAL] the processing flow re-derives via billrun_delete_trial_bill, never a bare DELETE/TRUNCATE or ON CONFLICT on customer_bill_line", () => {
    const flow = readFileSync(FLOW_YML, "utf8");
    // Strip BOTH `#`-prefixed YAML comment lines AND in-line `--` SQL comments
    // (the aggregation SQL lives in a heredoc whose comments use `--`), so the
    // contract prose — which freely names DELETE/ON CONFLICT while documenting
    // the boundary — is ignored. Symmetric with the ROLES_SQL `code()` path.
    const executable = flow
      .split("\n")
      .filter((line) => !/^\s*#/.test(line))
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n");

    // The whole-account replace is present.
    expect(executable).toMatch(/billrun_delete_trial_bill/);
    // No upsert against customer_bill_line.
    expect(executable).not.toMatch(/ON\s+CONFLICT/i);
    // No bare DELETE/TRUNCATE against customer_bill_line (the only deletion path
    // is the scoped SECURITY DEFINER on the header; lines cascade). Matches the
    // partitioned-table `DELETE FROM ONLY …` form too — customer_bill_line IS
    // partitioned, so `ONLY` is a real form the boundary must forbid.
    expect(executable).not.toMatch(
      /DELETE\s+FROM\s+(ONLY\s+)?("?billing"?\.)?"?customer_bill_line"?/i,
    );
    expect(executable).not.toMatch(
      /TRUNCATE\s+(TABLE\s+)?(ONLY\s+)?("?billing"?\.)?"?customer_bill_line"?/i,
    );
  });
});
