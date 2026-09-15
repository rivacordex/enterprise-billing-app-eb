import { existsSync, readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

// bm27-spec §Implementation §6 (guardrail 1). Collection resolves a RAN_USAGE
// row's subscriber ref to a billing account by READING
// `inventory.product_inventory` (Inv #24) — the correlation reads inventory's
// truth (product_inventory_id → billing_account_id) and NEVER mutates it
// (Inv #25/D32). This boundary test asserts, without a DB:
//   (1) `billrun-db-roles.sql` grants billrun_runtime only USAGE on the
//       `inventory` schema + SELECT on `product_inventory` — no INSERT/UPDATE/
//       DELETE/TRUNCATE on `inventory` of any kind; and
//   (2) no billing-side code (repositories/services) writes
//       `product_inventory.billing_account_id` (or writes product_inventory at
//       all) — the app is untouched by bm27 and the flow reads, never writes.
describe("bm27 inventory correlation write boundary (spec §Implementation §6)", () => {
  const ROLES_SQL = resolve(process.cwd(), "db/bootstrap/billrun-db-roles.sql");

  function statements(path: string): string[] {
    return readFileSync(path, "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter((s) => s.length > 0);
  }

  // Strip `-- ...` line comments so prose (which freely names INSERT/UPDATE/
  // DELETE when documenting the read-only boundary) never trips the grep — the
  // assertions apply to the executable SQL only.
  function code(statement: string): string {
    return statement
      .split("\n")
      .map((line) => line.replace(/--.*$/, ""))
      .join("\n")
      .trim();
  }

  it("grants billrun_runtime USAGE on the inventory schema", () => {
    const sql = readFileSync(ROLES_SQL, "utf8");
    expect(sql).toMatch(
      /GRANT\s+USAGE\s+ON\s+SCHEMA\s+"inventory"\s+TO\s+billrun_runtime/i,
    );
  });

  it("grants billrun_runtime SELECT on inventory.product_inventory", () => {
    // The statement carries leading `-- Step 8` comment lines, so match the
    // GRANT keyword anywhere in it, not at the string start.
    const grantWithInventoryTable = statements(ROLES_SQL)
      .map(code)
      .find(
        (s) =>
          /"inventory"\."product_inventory"/i.test(s) && /\bGRANT\b/i.test(s),
      );
    expect(grantWithInventoryTable).toBeDefined();
    // The ONLY table-level privilege on product_inventory is SELECT — no write
    // verb, and not a blanket `GRANT ALL [PRIVILEGES]` (which confers writes).
    expect(grantWithInventoryTable).toMatch(/\bGRANT\s+SELECT\b/i);
    expect(grantWithInventoryTable).not.toMatch(
      /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i,
    );
    expect(grantWithInventoryTable).not.toMatch(/\bGRANT\s+ALL\b/i);
  });

  it("[CRITICAL] grants NO write privilege of any kind on the inventory schema", () => {
    // Every statement that references `inventory` must be read-only — USAGE on
    // the schema or SELECT on the table. A write verb, OR a blanket
    // `GRANT ALL [PRIVILEGES]` (which silently confers INSERT/UPDATE/DELETE
    // without naming them), in an inventory-referencing GRANT is a boundary
    // breach (Inv #25/D32).
    const offenders = statements(ROLES_SQL)
      .map(code)
      .filter((s) => {
        const touchesInventory = /\binventory\b/i.test(s);
        const isGrant = /\bGRANT\b/i.test(s);
        const hasWriteVerb =
          /\b(INSERT|UPDATE|DELETE|TRUNCATE)\b/i.test(s) ||
          /\bGRANT\s+ALL\b/i.test(s);
        return touchesInventory && isGrant && hasWriteVerb;
      });
    expect(offenders).toEqual([]);
  });

  // ---- no billing-side writer of product_inventory --------------------------
  const BILLING_DIRS = [
    resolve(process.cwd(), "db/repositories/billing"),
    resolve(process.cwd(), "services/billing"),
  ];

  function tsFilesRecursive(dir: string): string[] {
    // Missing dir ⇒ empty (don't crash the [CRITICAL] guardrail if a billing
    // dir is renamed/removed — the read grant assertions still guard the SQL).
    if (!existsSync(dir)) return [];
    const out: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = resolve(dir, entry.name);
      if (entry.isDirectory()) out.push(...tsFilesRecursive(full));
      else if (entry.name.endsWith(".ts")) out.push(full);
    }
    return out;
  }

  it("[CRITICAL] no billing-side file writes product_inventory.billing_account_id", () => {
    const offenders: string[] = [];
    for (const dir of BILLING_DIRS) {
      for (const file of tsFilesRecursive(dir)) {
        const source = readFileSync(file, "utf8");
        // Raw SQL write against inventory.product_inventory …
        const rawInventoryWrite =
          /(INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+("?inventory"?\.)?"?product_inventory"?/i.test(
            source,
          );
        // … or a Drizzle ORM write against the productInventory table import.
        // Drizzle's write API puts the VERB before the table —
        // `db.update(productInventory)`, `.insert(productInventory)`,
        // `.delete(productInventory)` — so match that order (a table-then-verb
        // regex would never fire).
        const ormInventoryWrite =
          /from\s+["']@\/db\/schema\/inventory["']/.test(source) &&
          /\.(insert|update|delete)\(\s*productInventory\b/.test(source);
        if (rawInventoryWrite || ormInventoryWrite) {
          offenders.push(file);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
