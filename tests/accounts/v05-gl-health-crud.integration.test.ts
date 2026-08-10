import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// ac12-spec §3.7 — V5 GL-health CRUD tests.
//
// Tests the database-layer invariants that underpin the F5 orphan-block:
//   • gl_resolution_view filters retired gl_mapping rows (migration 0020 fix)
//   • retiring the sole mapping for a pgledger account exposes it as unmapped
//     in the same transaction, allowing the service to detect and block it
//   • editing a mapping to a valid code keeps unmapped count at 0
//   • optimistic-lock CAS: a stale lastModified is detected
//   • no DELETE path exists (Module Inv. #11)
//
// The non-postable-target check and DUPLICATE_SELECTOR check are pure
// application-layer guards in gl-mapping.ts (not DB constraints); those are
// covered by the structural test in route-level-chart-of-accounts.test.ts.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "V5 GL health CRUD — orphan-block & catalog retire (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let actorId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);

      // Migrate on a short-lived connection, then close it and open a fresh one
      // for reads: migrate() poisons the connection's type-OID cache so later
      // timestamptz reads on it return raw strings (module Key Decision —
      // "migrate()-poisons-connection quirk").
      const migrateSql = postgres(databaseUrl as string, { max: 1 });
      try {
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
        await migrateSql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
        await migrate(drizzle(migrateSql), {
          migrationsFolder: "./db/migrations",
          migrationsSchema: "drizzle",
        });
      } finally {
        await migrateSql.end();
      }

      sql = postgres(databaseUrl as string, { max: 1 });

      // retireGlMapping stamps last_edited_by (FK → core.appuser), so seed a
      // real actor rather than a literal string.
      const [actor] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-v05', 'V05 Actor', 'v05@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      actorId = actor!.id;

      // Minimal seed: sys pgledger accounts + CoA + gl_mappings covering all
      // sys accounts. The role-based mappings are omitted so we can test with
      // only the system_account selectors (no customer accounts needed).
      for (const name of [
        "sys.cash.MYR",
        "sys.revenue.MYR",
        "sys.revenue_adj.MYR",
        "sys.write_off.MYR",
        "sys.rounding.MYR",
        "sys.tax_payable.MYR",
      ]) {
        await sql`SELECT id FROM billing.pgledger_create_account(${name}, 'MYR')`;
      }

      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, parent_gl_code, is_postable, state)
        VALUES
          ('1000', 'Current Assets',             'asset',     'debit',  NULL,   false, 'active'),
          ('2000', 'Current Liabilities',         'liability', 'credit', NULL,   false, 'active'),
          ('4000', 'Service Revenue',             'revenue',   'credit', NULL,   true,  'active'),
          ('4090', 'Revenue Adjustments',         'revenue',   'credit', NULL,   true,  'active'),
          ('6100', 'Bad Debt Expense',            'expense',   'debit',  NULL,   true,  'active'),
          ('6900', 'Rounding Differences',        'expense',   'debit',  NULL,   true,  'active'),
          ('1050', 'Cash Clearing',               'asset',     'debit',  '1000', true,  'active'),
          ('1200', 'Accounts Receivable',         'asset',     'debit',  '1000', true,  'active'),
          ('2200', 'SST Payable',                 'liability', 'credit', '2000', true,  'active'),
          ('2300', 'Unapplied Customer Receipts', 'liability', 'credit', '2000', true,  'active'),
          ('2400', 'Customer Deposits',           'liability', 'credit', '2000', true,  'active')
      `;

      // sys.* account mappings only (no ledger_role rows — no BANs/FAs needed).
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES
          ('system_account', 'sys.revenue.MYR',     'MYR', '4000'),
          ('system_account', 'sys.revenue_adj.MYR', 'MYR', '4090'),
          ('system_account', 'sys.write_off.MYR',   'MYR', '6100'),
          ('system_account', 'sys.rounding.MYR',    'MYR', '6900'),
          ('system_account', 'sys.tax_payable.MYR', 'MYR', '2200'),
          ('system_account', 'sys.cash.MYR',        'MYR', '1050')
      `;
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    // ── Baseline ──────────────────────────────────────────────────────────────

    it("V5 baseline — all 6 sys accounts resolve after seeding (0 unmapped)", async () => {
      const [row] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM billing.gl_resolution_view WHERE gl_code IS NULL
      `;
      expect(Number(row?.cnt)).toBe(0);
    });

    // ── migration 0020 fix: retired mappings are excluded ─────────────────────

    it("V5 — gl_resolution_view excludes retired gl_mapping rows (migration 0020 fix)", async () => {
      // Retire the sys.cash.MYR mapping directly (bypassing the service to
      // test the view-level filter in isolation).
      await sql`
        UPDATE billing.gl_mapping SET state = 'retired'
        WHERE selector_type = 'system_account' AND selector = 'sys.cash.MYR'
      `;

      const [row] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM billing.gl_resolution_view WHERE gl_code IS NULL
      `;
      expect(Number(row?.cnt)).toBe(1); // sys.cash.MYR is now unmapped

      // Restore for subsequent tests.
      await sql`
        UPDATE billing.gl_mapping SET state = 'active'
        WHERE selector_type = 'system_account' AND selector = 'sys.cash.MYR'
      `;

      const [restored] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM billing.gl_resolution_view WHERE gl_code IS NULL
      `;
      expect(Number(restored?.cnt)).toBe(0);
    });

    // ── F5 orphan-block: in-transaction detection ─────────────────────────────

    it("V5 — retiring the sole mapping inside a transaction exposes orphaned accounts (F5 orphan-block simulation)", async () => {
      // Simulate what gl-mapping.ts retireGlMapping does: retire inside a
      // transaction, check the unmapped count, then roll back if non-zero.
      let orphanedInTx = -1;
      let orphanedNames: string[] = [];

      await sql
        .begin(async (tx) => {
          await tx`
          UPDATE billing.gl_mapping SET state = 'retired'
          WHERE selector_type = 'system_account' AND selector = 'sys.revenue.MYR'
        `;

          const [row] = await tx<{ cnt: string }[]>`
          SELECT count(*)::text AS cnt
          FROM billing.gl_resolution_view
          WHERE gl_code IS NULL
        `;
          orphanedInTx = Number(row?.cnt);

          const names = await tx<{ name: string }[]>`
          SELECT pav.name
          FROM billing.gl_resolution_view grv
          JOIN billing.pgledger_accounts_view pav ON pav.id = grv.pgledger_account_id
          WHERE grv.gl_code IS NULL
          ORDER BY pav.name
        `;
          orphanedNames = names.map((r) => r.name);

          // Simulate the orphan-block: roll back because count > 0.
          throw new Error("orphan-block-rollback");
        })
        .catch((e: unknown) => {
          if (!(e instanceof Error) || e.message !== "orphan-block-rollback")
            throw e;
        });

      expect(orphanedInTx).toBe(1);
      expect(orphanedNames).toContain("sys.revenue.MYR");

      // Confirm the rollback preserved the mapping as active.
      const [check] = await sql<{ state: string }[]>`
        SELECT state FROM billing.gl_mapping
        WHERE selector_type = 'system_account' AND selector = 'sys.revenue.MYR'
        LIMIT 1
      `;
      expect(check?.state).toBe("active");

      // And the health panel still reads 0 unmapped after the rolled-back tx.
      const [health] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM billing.gl_resolution_view WHERE gl_code IS NULL
      `;
      expect(Number(health?.cnt)).toBe(0);
    });

    // ── Valid mapping edit: unmapped count stays 0 ─────────────────────────────

    it("V5 — editing a mapping to a valid postable code keeps unmapped count at 0", async () => {
      // Change sys.revenue.MYR mapping target from 4000 to 4090 (both postable).
      await sql.begin(async (tx) => {
        await tx`
          UPDATE billing.gl_mapping SET ref_gl_code = '4090', last_modified = now()
          WHERE selector_type = 'system_account' AND selector = 'sys.revenue.MYR'
        `;

        const [row] = await tx<{ cnt: string }[]>`
          SELECT count(*)::text AS cnt
          FROM billing.gl_resolution_view
          WHERE gl_code IS NULL
        `;
        expect(Number(row?.cnt)).toBe(0);
        // Commit (no throw = commit).
      });

      // Restore original target for clean state.
      await sql`
        UPDATE billing.gl_mapping SET ref_gl_code = '4000', last_modified = now()
        WHERE selector_type = 'system_account' AND selector = 'sys.revenue.MYR'
      `;
    });

    // ── Optimistic-lock (CAS) ─────────────────────────────────────────────────

    it("V5 — optimistic-lock: stale lastModified detected before retire", async () => {
      // Fetch the real lastModified, then advance it to simulate a concurrent edit.
      const [row] = await sql<{ lm: Date; id: string }[]>`
        SELECT last_modified AS lm, gl_mapping_id AS id
        FROM billing.gl_mapping
        WHERE selector_type = 'system_account' AND selector = 'sys.rounding.MYR'
        LIMIT 1
      `;
      if (!row) throw new Error("mapping not found");

      // Touch the row to advance lastModified.
      await sql`
        UPDATE billing.gl_mapping SET last_modified = now()
        WHERE gl_mapping_id = ${row.id}
      `;

      // A CAS check using the stale timestamp must not match.
      const [updated] = await sql<{ gl_mapping_id: string }[]>`
        UPDATE billing.gl_mapping SET state = 'retired'
        WHERE gl_mapping_id = ${row.id}
          AND last_modified = ${row.lm}
        RETURNING gl_mapping_id
      `;
      expect(updated).toBeUndefined(); // 0 rows updated = stale lock detected.

      // The mapping must still be active.
      const [check] = await sql<{ state: string }[]>`
        SELECT state FROM billing.gl_mapping WHERE gl_mapping_id = ${row.id} LIMIT 1
      `;
      expect(check?.state).toBe("active");
    });

    // ── Retire-not-delete (Module Inv. #11) ───────────────────────────────────

    it("V5 — retire keeps the mapping row; no DELETE path removes it (Module Inv. #11)", async () => {
      // Insert a spare mapping to retire (so the orphan check stays at 0).
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES ('system_account', 'sys.cash.MYR', 'USD', '1050')
      `;

      const [spare] = await sql<{ id: string }[]>`
        SELECT gl_mapping_id AS id FROM billing.gl_mapping
        WHERE selector_type = 'system_account' AND selector = 'sys.cash.MYR' AND currency = 'USD'
        LIMIT 1
      `;
      if (!spare) throw new Error("spare mapping not found");

      // Retire the spare mapping inside a transaction (0 orphans — USD accounts
      // don't exist, so no pgledger accounts are affected).
      await sql.begin(async (tx) => {
        await tx`
          UPDATE billing.gl_mapping SET state = 'retired' WHERE gl_mapping_id = ${spare.id}
        `;
      });

      // Row must still exist (retired, not deleted).
      const [check] = await sql<{ state: string }[]>`
        SELECT state FROM billing.gl_mapping WHERE gl_mapping_id = ${spare.id} LIMIT 1
      `;
      expect(check?.state).toBe("retired");

      // Health panel unaffected (USD account didn't exist, nothing orphaned).
      const [health] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM billing.gl_resolution_view WHERE gl_code IS NULL
      `;
      expect(Number(health?.cnt)).toBe(0);
    });

    // ── Service-layer retire ──────────────────────────────────────────────────

    it("V5 — service-layer retireGlMapping: OK for non-orphaning retire, ORPHAN_BLOCK for sole mapping", async () => {
      const { retireGlMapping } =
        await import("@/services/accounts/gl-mapping");

      // Insert a spare (EUR selector — no EUR pgledger accounts, so 0 orphans).
      const [spare] = await sql<{ id: string; lm: Date }[]>`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES ('system_account', 'sys.cash.MYR', 'EUR', '1050')
        RETURNING gl_mapping_id AS id, last_modified AS lm
      `;
      if (!spare) throw new Error("spare insert failed");

      const okResult = await retireGlMapping(spare.id, spare.lm, actorId);
      expect(okResult).toEqual({ ok: true });

      const [retiredRow] = await sql<{ state: string }[]>`
        SELECT state FROM billing.gl_mapping WHERE gl_mapping_id = ${spare.id} LIMIT 1
      `;
      expect(retiredRow?.state).toBe("retired");

      // ORPHAN_BLOCK: retire the sole active MYR mapping for sys.revenue.MYR.
      const [revRow] = await sql<{ id: string; lm: Date }[]>`
        SELECT gl_mapping_id AS id, last_modified AS lm
        FROM billing.gl_mapping
        WHERE selector_type = 'system_account' AND selector = 'sys.revenue.MYR'
          AND state = 'active'
        LIMIT 1
      `;
      if (!revRow) throw new Error("sys.revenue.MYR mapping not found");

      const blockResult = await retireGlMapping(revRow.id, revRow.lm, actorId);
      expect(blockResult.ok).toBe(false);
      if (!blockResult.ok) {
        expect(blockResult.code).toBe("ORPHAN_BLOCK");
        expect(
          (blockResult as { affectedAccounts: string[] }).affectedAccounts,
        ).toContain("sys.revenue.MYR");
      }

      const [check] = await sql<{ state: string }[]>`
        SELECT state FROM billing.gl_mapping WHERE gl_mapping_id = ${revRow.id} LIMIT 1
      `;
      expect(check?.state).toBe("active");
    });

    // ── GL code retire: stays in resolution joins ─────────────────────────────

    it("V5 — retiring a GL code keeps existing mappings resolving (code stays in joins)", async () => {
      // Add a spare postable GL code and map a spare selector to it.
      await sql`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, is_postable, state)
        VALUES ('9999', 'Test Spare Account', 'asset', 'debit', true, 'active')
      `;
      await sql`SELECT id FROM billing.pgledger_create_account('sys.cash.SGD', 'SGD')`;
      // Selector must equal the pgledger account name (gl_resolution_view joins
      // system_account mappings on selector = pav.name), so map sys.cash.SGD —
      // not sys.cash.MYR — to resolve the SGD account.
      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code)
        VALUES ('system_account', 'sys.cash.SGD', 'SGD', '9999')
      `;

      // Retire the GL code (the mapping row still exists, still active).
      await sql`UPDATE billing.gl_account SET state = 'retired' WHERE gl_code = '9999'`;

      // The view still resolves sys.cash.SGD → 9999 because gl_resolution_view
      // does NOT filter gl_account.state (only gl_mapping.state matters).
      const [row] = await sql<{ gl_code: string | null }[]>`
        SELECT grv.gl_code
        FROM billing.gl_resolution_view grv
        JOIN billing.pgledger_accounts_view pav ON pav.id = grv.pgledger_account_id
        WHERE pav.name = 'sys.cash.SGD'
        LIMIT 1
      `;
      expect(row?.gl_code).toBe("9999");

      // Health panel: only MYR + SGD sys accounts; the SGD one resolves → 0 unmapped.
      const [health] = await sql<{ cnt: string }[]>`
        SELECT count(*)::text AS cnt FROM billing.gl_resolution_view WHERE gl_code IS NULL
      `;
      expect(Number(health?.cnt)).toBe(0);
    });
  },
);
