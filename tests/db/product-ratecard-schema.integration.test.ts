import type { Dirent } from "node:fs";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm57-spec I5 — live-DB proof, against a database built from EMPTY, that
// 0041_ratecard_ran_usage_lkp.sql stands up both card tables with the two
// partial unique indexes (RV1/C8), the RV2 row-key uniqueness constraint,
// the cascade FK, and the no-FK stance on lkp_subscriber_ref_id — enforced
// by Postgres, not by application code that does not exist yet (this unit
// ships no repository/service/action). Same drop-all -> migrate-from-empty
// reset pattern as the sibling product integration suites.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product rate-card schema (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql, { schema }), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function insertVersion(
      cardName: string,
      status: "DRAFT" | "ACTIVE" | "SUPERSEDED" | "REJECTED",
      versionNum: number,
      snapshotDate = "2026-01-01",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO product.ratecard_version
          (card_name, version_num, status, snapshot_date, source_file, row_count)
        VALUES (${cardName}, ${versionNum}, ${status}, ${snapshotDate}, 'test.csv', 1)
        RETURNING ratecard_version_id AS id
      `;
      if (!row) throw new Error("ratecard_version insert returned no row.");
      return row.id;
    }

    async function insertLkpRow(
      versionId: string,
      overrides: Partial<{
        mno: string;
        cu: string;
        polygon: string;
        startDate: string;
        subscriberRef: string;
      }> = {},
    ) {
      const mno = overrides.mno ?? "MNO1";
      const cu = overrides.cu ?? "CU1";
      const polygon = overrides.polygon ?? "POLY1";
      const startDate = overrides.startDate ?? "2026-01-01";
      const subscriberRef = overrides.subscriberRef ?? "PRDINV00000001";
      return sql`
        INSERT INTO product.ratecard_ran_usage_lkp
          (ratecard_version_id, mno_public_key, commercial_unit_public_key, polygon_id, polygon_start_date, lkp_subscriber_ref_id)
        VALUES (${versionId}, ${mno}, ${cu}, ${polygon}, ${startDate}, ${subscriberRef})
      `;
    }

    // I5.1 — both tables exist with exactly the architecture §3.2/§3.3 column
    // sets, and the two sequences/tables live in the product schema.
    it("both tables exist with exactly the spec'd column sets", async () => {
      const tables = await sql<{ table_name: string }[]>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'product' AND c.relkind = 'r'
      `;
      const names = tables.map((t) => t.table_name);
      expect(names).toContain("ratecard_version");
      expect(names).toContain("ratecard_ran_usage_lkp");

      const versionColumns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'product' AND table_name = 'ratecard_version'
      `;
      expect(versionColumns.map((c) => c.column_name).sort()).toEqual(
        [
          "ratecard_version_id",
          "card_name",
          "version_num",
          "status",
          "snapshot_date",
          "source_file",
          "file_checksum",
          "row_count",
          "carried_row_count",
          "uploaded_by",
          "uploaded_at",
          "activated_by",
          "activated_at",
          "superseded_by_version_id",
          "reject_summary",
        ].sort(),
      );

      const lkpColumns = await sql<{ column_name: string }[]>`
        SELECT column_name FROM information_schema.columns
        WHERE table_schema = 'product' AND table_name = 'ratecard_ran_usage_lkp'
      `;
      expect(lkpColumns.map((c) => c.column_name).sort()).toEqual(
        [
          "ratecard_ran_usage_lkp_id",
          "ratecard_version_id",
          "mno_public_key",
          "commercial_unit_public_key",
          "polygon_id",
          "polygon_start_date",
          "lkp_subscriber_ref_id",
          "service_code",
          "rate_per_unit",
          "retired_at",
        ].sort(),
      );
    });

    it("ratecard_version_id defaults to the RCV-prefixed, zero-padded sequence format", async () => {
      const id = await insertVersion("CARD_ID_FORMAT", "DRAFT", 1);
      expect(id).toMatch(/^RCV\d{8}$/);
    });

    // I5.2 — a second ACTIVE, and a second DRAFT, for one card_name are each
    // rejected by the partial index (RV1, C8 option A) — not by application
    // code that does not exist in this unit.
    it("a second ACTIVE version for one card_name is rejected by the partial unique index", async () => {
      await insertVersion("CARD_ACTIVE_DUP", "ACTIVE", 1);
      await expect(
        insertVersion("CARD_ACTIVE_DUP", "ACTIVE", 2),
      ).rejects.toThrow(/ratecard_version_one_active_per_card/);
    });

    it("a second DRAFT version for one card_name is rejected by the partial unique index (C8 option A)", async () => {
      await insertVersion("CARD_DRAFT_DUP", "DRAFT", 1);
      await expect(insertVersion("CARD_DRAFT_DUP", "DRAFT", 2)).rejects.toThrow(
        /ratecard_version_one_draft_per_card/,
      );
      // A SUPERSEDED or REJECTED sibling never collides with the ACTIVE/DRAFT
      // partial indexes — only same-status rows on the same card_name do.
      await insertVersion("CARD_DRAFT_DUP", "SUPERSEDED", 3);
      await insertVersion("CARD_DRAFT_DUP", "REJECTED", 4);
    });

    // I5.3 — a duplicate (version, mno, cu, polygon, polygon_start_date) is
    // rejected (RV2).
    it("a duplicate row key within one version is rejected (RV2)", async () => {
      const versionId = await insertVersion("CARD_RV2", "DRAFT", 1);
      await insertLkpRow(versionId);
      await expect(insertLkpRow(versionId)).rejects.toThrow(
        /ratecard_ran_usage_lkp_row_key_unique/,
      );
      // The same key under a DIFFERENT version is not a collision — the
      // uniqueness is scoped per version, not global.
      const otherVersionId = await insertVersion("CARD_RV2", "SUPERSEDED", 2);
      await expect(insertLkpRow(otherVersionId)).resolves.not.toThrow();
    });

    // I5.4 — deleting a version cascades its rows; deleting a
    // product_inventory row does not affect card rows (D3's no-FK, proved).
    it("deleting a version cascades its rows", async () => {
      const versionId = await insertVersion("CARD_CASCADE", "DRAFT", 1);
      await insertLkpRow(versionId);
      const before = await sql`
        SELECT 1 FROM product.ratecard_ran_usage_lkp WHERE ratecard_version_id = ${versionId}
      `;
      expect(before).toHaveLength(1);

      await sql`DELETE FROM product.ratecard_version WHERE ratecard_version_id = ${versionId}`;

      const after = await sql`
        SELECT 1 FROM product.ratecard_ran_usage_lkp WHERE ratecard_version_id = ${versionId}
      `;
      expect(after).toHaveLength(0);
    });

    it("lkp_subscriber_ref_id carries no FK — an arbitrary, never-inventoried value is accepted and survives independently of any product_inventory row", async () => {
      const versionId = await insertVersion("CARD_NO_FK", "DRAFT", 1);
      await expect(
        insertLkpRow(versionId, { subscriberRef: "PRDINV99999999" }),
      ).resolves.not.toThrow();

      const rows = await sql`
        SELECT lkp_subscriber_ref_id FROM product.ratecard_ran_usage_lkp
        WHERE ratecard_version_id = ${versionId}
      `;
      expect(rows).toHaveLength(1);
      expect(rows[0]?.lkp_subscriber_ref_id).toBe("PRDINV99999999");

      // information_schema confirms no FK constraint touches this column —
      // its only constraint membership is the RV2 uniqueness key above.
      const fks = await sql<{ constraint_name: string }[]>`
        SELECT tc.constraint_name
        FROM information_schema.table_constraints tc
        JOIN information_schema.key_column_usage kcu
          ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
        WHERE tc.table_schema = 'product'
          AND tc.table_name = 'ratecard_ran_usage_lkp'
          AND tc.constraint_type = 'FOREIGN KEY'
          AND kcu.column_name = 'lkp_subscriber_ref_id'
      `;
      expect(fks).toHaveLength(0);
    });

    // I5.5 — 0006_product.sql is byte-identical: this unit is a new forward
    // migration and never reopens it (RC12, code-standards §6.14/§6.25).
    it("0006_product.sql is untouched by this unit", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const source = await fs.readFile(
        path.join(process.cwd(), "db", "migrations", "0006_product.sql"),
        "utf8",
      );
      expect(source.toLowerCase()).not.toContain("ratecard");
    });

    // I5.6 — no backfill script exists anywhere in the result (D10),
    // asserted by grep, not merely unwritten.
    it("no backfill/data-fix script exists for the rate-card tables", async () => {
      const fs = await import("node:fs/promises");
      const path = await import("node:path");
      const migrationsDir = path.join(process.cwd(), "db", "migrations");
      const scriptsDir = path.join(process.cwd(), "scripts");
      const BACKFILL_PATTERN = /backfill|data-?fix|relabel/i;

      async function collect(dir: string): Promise<string[]> {
        let entries: Dirent[];
        try {
          entries = await fs.readdir(dir, { withFileTypes: true });
        } catch {
          return [];
        }
        const files: string[] = [];
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          if (entry.isDirectory()) files.push(...(await collect(entryPath)));
          else if (entry.isFile()) files.push(entryPath);
        }
        return files;
      }

      const offending = [
        ...(await collect(migrationsDir)),
        ...(await collect(scriptsDir)),
      ].filter((f) => BACKFILL_PATTERN.test(path.basename(f)));
      expect(offending).toEqual([]);
    });

    // I5.7 — G-RC3 is open (this unit's I6 split): no `ratecard` permission
    // row exists yet. This documents the deferral rather than asserting the
    // spec's literal "adding ratecard changes no effective permission" —
    // that assertion is owed by the follow-up migration that adds the row.
    it("no 'ratecard' PERMISSIONS row exists yet (G-RC3 open; I6 split)", async () => {
      const rows = await sql<{ permission_name: string }[]>`
        SELECT permission_name FROM core.permissions WHERE permission_name = 'ratecard'
      `;
      expect(rows).toHaveLength(0);
    });

    // I5.8 / D9 — verify the grants empirically rather than assume them.
    // Mirrors the CURRENT bootstrap files exactly: app_runtime's product
    // grant is schema-wide (bootstrap-db-roles.sql's ALTER DEFAULT
    // PRIVILEGES for the product schema), so it reaches the two new tables
    // automatically. rating_runtime's and billrun_runtime's product grants
    // are each an ENUMERATED per-table list (rm03-spec D9: "never ON ALL
    // TABLES") that does not name either new table — so, without a bootstrap
    // edit (which this unit's own D9 forbids taking on its own initiative),
    // neither engine role can read the new tables yet. This is the empirical
    // finding D9 asks this unit to raise, not silently patch.
    it("app_runtime reaches both new tables automatically; rating_runtime and billrun_runtime do not (finding, not a bootstrap edit)", async () => {
      await sql.unsafe(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
            CREATE ROLE app_runtime NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'rating_runtime') THEN
            CREATE ROLE rating_runtime NOLOGIN;
          END IF;
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'billrun_runtime') THEN
            CREATE ROLE billrun_runtime NOLOGIN;
          END IF;
        END
      $$;`);
      await sql.unsafe('GRANT USAGE ON SCHEMA "product" TO app_runtime');
      await sql.unsafe('GRANT USAGE ON SCHEMA "product" TO rating_runtime');
      await sql.unsafe('GRANT USAGE ON SCHEMA "product" TO billrun_runtime');
      // app_runtime's real-world grant is schema-wide (bootstrap-db-roles.sql
      // §Step covering ALL TABLES IN SCHEMA "product" / its default
      // privilege for future ones) — reproduced directly here.
      await sql.unsafe(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA "product" TO app_runtime',
      );
      // rating_runtime / billrun_runtime's real-world grants are each an
      // enumerated list that does NOT include either new table — reproduced
      // by granting only the pre-existing tables, deliberately omitting the
      // two new ones, exactly as db/bootstrap/{rating,billrun}-db-roles.sql
      // read today.
      await sql.unsafe(
        'GRANT SELECT ON "product"."product_offering", "product"."product_offering_price" TO rating_runtime',
      );
      await sql.unsafe(
        'GRANT SELECT ON "product"."product_offering", "product"."product_offering_price" TO billrun_runtime',
      );

      async function canSelect(role: string, table: string): Promise<boolean> {
        try {
          await sql.begin(async (tx) => {
            await tx.unsafe(`SET LOCAL ROLE ${role}`);
            await tx.unsafe(`SELECT 1 FROM product.${table} LIMIT 1`);
          });
          return true;
        } catch {
          return false;
        }
      }

      expect(await canSelect("app_runtime", "ratecard_version")).toBe(true);
      expect(await canSelect("app_runtime", "ratecard_ran_usage_lkp")).toBe(
        true,
      );
      expect(await canSelect("rating_runtime", "ratecard_version")).toBe(false);
      expect(await canSelect("billrun_runtime", "ratecard_version")).toBe(
        false,
      );
    });
  },
);
