import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm36-spec I3 — live-DB proof that 0040_product_family_guards.sql makes the
// database refuse what the services already refuse: a second open (DRAFT|
// TESTING) or a second ACTIVE version in one family (the two expression unique
// indexes), and any INSERT/UPDATE/DELETE against a specification or price row
// whose parent offering is not DRAFT (the child_write_requires_draft trigger).
// Every rejection is provoked by raw SQL — never a repository/service — so a
// green run means the guard holds even when a direct write goes around the app
// (code-standards §6.7/§6.8/§6.18). Same reset pattern as the sibling
// product/migration integration suites: drop-all → migrate from empty.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product family guards: uniqueness indexes + DRAFT-guard trigger (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      // "product" holds FKs into "core", so it must drop first.
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

      // pm36-spec Dependencies (role-context case). The trigger runs as invoker
      // and its internal SELECT reads product.product_offering; app_runtime must
      // hold SELECT on it or the trigger fails opaquely under that role. The
      // disposable test DB is built by migrate() only (no bootstrap-roles run),
      // so provision a minimal app_runtime here and grant exactly the surface
      // the pm36 role-context cases exercise. Idempotent — the role is
      // cluster-global and may already exist from a real bootstrap.
      await sql.unsafe(`DO $$
        BEGIN
          IF NOT EXISTS (SELECT FROM pg_catalog.pg_roles WHERE rolname = 'app_runtime') THEN
            CREATE ROLE app_runtime NOLOGIN;
          END IF;
        END
      $$;`);
      await sql.unsafe('GRANT USAGE ON SCHEMA "product" TO app_runtime');
      await sql.unsafe(
        'GRANT SELECT ON "product"."product_offering" TO app_runtime',
      );
      await sql.unsafe(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "product"."product_offering_price" TO app_runtime',
      );
      await sql.unsafe(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "product"."product_specifications" TO app_runtime',
      );
      await sql.unsafe(
        'GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA "product" TO app_runtime',
      );
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

    // A family member. familyId null ⇒ this row is the family root; a non-null
    // familyId points at the root (one hop). lifecycle_status defaults to DRAFT.
    async function insertOffering(opts: {
      name: string;
      status?: string;
      familyId?: string | null;
    }): Promise<string> {
      const rows = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status, family_offering_id)
        VALUES (
          ${opts.name}, false, true, true,
          ${opts.status ?? "DRAFT"}::product.lifecycle_status,
          ${opts.familyId ?? null}
        )
        RETURNING product_offering_id`;
      const id = rows[0]?.product_offering_id;
      if (!id) throw new Error("offering insert returned no row");
      return id;
    }

    // A complete `once` flat price (no charge period, no unit) — deliberately
    // the price shape that trips none of pm35's completeness CHECKs, so a
    // rejection here can only be the pm36 trigger. Returns the unawaited insert
    // promise so a caller can assert on rejection.
    function insertPrice(
      offeringId: string,
      opts: { name: string; startDateTime?: string },
    ): Promise<unknown> {
      return sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
        VALUES (
          ${offeringId}, ${opts.name}, ${"once"}, ${"10.00"}, ${"MYR"}, ${"flat"},
          ${opts.startDateTime ?? "2026-01-01T00:00:00Z"}
        )`;
    }

    function insertSpec(offeringId: string, name: string): Promise<unknown> {
      return sql`
        INSERT INTO product.product_specifications
          (ref_product_offering_id, name, is_mandatory, is_default, product_spec_characteristics)
        VALUES (${offeringId}, ${name}, false, false, ${"{}"}::jsonb)`;
    }

    async function countChildren(
      offeringId: string,
    ): Promise<{ specs: number; prices: number; offerings: number }> {
      const [specs] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_specifications
        WHERE ref_product_offering_id = ${offeringId}`;
      const [prices] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${offeringId}`;
      const [offerings] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE product_offering_id = ${offeringId}`;
      return {
        specs: Number(specs?.count),
        prices: Number(prices?.count),
        offerings: Number(offerings?.count),
      };
    }

    // ── Uniqueness indexes ──────────────────────────────────────────────────

    it("rejects a second ACTIVE version in one family (product_offering_one_active_per_family)", async () => {
      const root = await insertOffering({ name: "g1 root", status: "ACTIVE" });
      await expect(
        insertOffering({
          name: "g1 branch",
          status: "ACTIVE",
          familyId: root,
        }),
      ).rejects.toThrow("product_offering_one_active_per_family");
    });

    it("rejects a second open version (DRAFT + DRAFT) in one family (product_offering_one_open_per_family)", async () => {
      const root = await insertOffering({ name: "g2 root", status: "DRAFT" });
      await expect(
        insertOffering({
          name: "g2 branch",
          status: "DRAFT",
          familyId: root,
        }),
      ).rejects.toThrow("product_offering_one_open_per_family");
    });

    it("rejects a DRAFT + TESTING pair in one family — both statuses share the open predicate", async () => {
      const root = await insertOffering({ name: "g3 root", status: "DRAFT" });
      await expect(
        insertOffering({
          name: "g3 branch",
          status: "TESTING",
          familyId: root,
        }),
      ).rejects.toThrow("product_offering_one_open_per_family");
    });

    it("accepts one open, one ACTIVE and an OBSOLETE root together in one family", async () => {
      const root = await insertOffering({
        name: "g4 root",
        status: "OBSOLETE",
      });
      // One ACTIVE branch — the active index permits exactly one.
      await insertOffering({
        name: "g4 active",
        status: "ACTIVE",
        familyId: root,
      });
      // One open branch — the open index permits exactly one; OBSOLETE is
      // unconstrained by either predicate.
      await insertOffering({
        name: "g4 draft",
        status: "DRAFT",
        familyId: root,
      });

      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE product_offering_id = ${root} OR family_offering_id = ${root}`;
      expect(row?.count).toBe("3");
    });

    it("accepts two separate families each carrying their own open version — the key is per family", async () => {
      const rootA = await insertOffering({ name: "g5 rootA", status: "DRAFT" });
      const rootB = await insertOffering({ name: "g5 rootB", status: "DRAFT" });
      expect(rootA).not.toBe(rootB);
      // Both roots are their own family, each open — distinct COALESCE keys.
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering
        WHERE product_offering_id IN (${rootA}, ${rootB})
          AND lifecycle_status = 'DRAFT'`;
      expect(row?.count).toBe("2");
    });

    it("rejects an UPDATE promoting a second version to ACTIVE while a sibling is ACTIVE (active index)", async () => {
      const root = await insertOffering({ name: "g6 root", status: "ACTIVE" });
      const branch = await insertOffering({
        name: "g6 branch",
        status: "DRAFT",
        familyId: root,
      });
      await expect(
        sql`UPDATE product.product_offering
              SET lifecycle_status = 'ACTIVE'
            WHERE product_offering_id = ${branch}`,
      ).rejects.toThrow("product_offering_one_active_per_family");
    });

    // ── DRAFT-guard trigger ─────────────────────────────────────────────────

    for (const status of ["TESTING", "ACTIVE", "OBSOLETE", "RETIRED"]) {
      it(`rejects a price INSERT whose parent is ${status} (trigger names the constraint + status)`, async () => {
        const parent = await insertOffering({
          name: `g7 ${status}`,
          status,
        });
        let err: unknown;
        try {
          await insertPrice(parent, { name: "blocked" });
        } catch (e) {
          err = e;
        }
        expect(String(err)).toContain("product_child_write_requires_draft");
        expect(String(err)).toContain(status);
      });
    }

    it("rejects a spec UPDATE whose parent is ACTIVE (trigger)", async () => {
      const parent = await insertOffering({ name: "g8", status: "DRAFT" });
      await insertSpec(parent, "spec"); // parent DRAFT ⇒ allowed
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${parent}`;
      await expect(
        sql`UPDATE product.product_specifications SET name = 'changed'
              WHERE ref_product_offering_id = ${parent}`,
      ).rejects.toThrow("product_child_write_requires_draft");
    });

    it("rejects a price DELETE whose parent is ACTIVE (trigger)", async () => {
      const parent = await insertOffering({ name: "g9", status: "DRAFT" });
      await insertPrice(parent, { name: "keep" }); // parent DRAFT ⇒ allowed
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${parent}`;
      await expect(
        sql`DELETE FROM product.product_offering_price
              WHERE product_offering_id = ${parent}`,
      ).rejects.toThrow("product_child_write_requires_draft");
    });

    it("accepts INSERT/UPDATE/DELETE of a price and a spec while the parent is DRAFT", async () => {
      const parent = await insertOffering({ name: "g10", status: "DRAFT" });

      await insertSpec(parent, "spec-a");
      await sql`UPDATE product.product_specifications SET name = 'spec-a2'
                WHERE ref_product_offering_id = ${parent}`;
      await sql`DELETE FROM product.product_specifications
                WHERE ref_product_offering_id = ${parent}`;

      await insertPrice(parent, { name: "price-a" });
      await sql`UPDATE product.product_offering_price SET name = 'price-a2'
                WHERE product_offering_id = ${parent}`;
      await sql`DELETE FROM product.product_offering_price
                WHERE product_offering_id = ${parent}`;

      const counts = await countChildren(parent);
      expect(counts.specs).toBe(0);
      expect(counts.prices).toBe(0);
    });

    it("hard-deletes a DRAFT offering carrying 2 specs and 2 prices — the cascade passes the trigger (D4)", async () => {
      const parent = await insertOffering({ name: "g11", status: "DRAFT" });
      await insertSpec(parent, "s1");
      await insertSpec(parent, "s2");
      await insertPrice(parent, {
        name: "p1",
        startDateTime: "2026-01-01T00:00:00Z",
      });
      await insertPrice(parent, {
        name: "p2",
        startDateTime: "2026-02-01T00:00:00Z",
      });

      await sql`DELETE FROM product.product_offering
                WHERE product_offering_id = ${parent}`;

      const counts = await countChildren(parent);
      expect(counts.offerings).toBe(0);
      expect(counts.specs).toBe(0);
      expect(counts.prices).toBe(0);
    });

    it("hard-deletes a TESTING offering carrying children — same path; the status check never runs because the parent is already gone", async () => {
      const parent = await insertOffering({ name: "g12", status: "DRAFT" });
      // Children inserted while DRAFT (the trigger forbids a direct write once
      // the parent leaves DRAFT), then the parent is moved to TESTING.
      await insertSpec(parent, "s1");
      await insertPrice(parent, { name: "p1" });
      await sql`UPDATE product.product_offering SET lifecycle_status = 'TESTING'
                WHERE product_offering_id = ${parent}`;

      await sql`DELETE FROM product.product_offering
                WHERE product_offering_id = ${parent}`;

      const counts = await countChildren(parent);
      expect(counts.offerings).toBe(0);
      expect(counts.specs).toBe(0);
      expect(counts.prices).toBe(0);
    });

    // ── Role-context (pm36-spec Dependencies) ───────────────────────────────
    // Proves the trigger's internal SELECT resolves under app_runtime — the
    // role the production insert-price path actually runs as. A missing SELECT
    // grant would surface as an opaque `permission denied for table
    // product_offering`, NOT the trigger's own message, so asserting the
    // message (not merely "it threw") is what makes the grant proven.

    it("fires and succeeds under app_runtime on a DRAFT parent", async () => {
      const parent = await insertOffering({
        name: "role draft",
        status: "DRAFT",
      });
      await sql.begin(async (tx) => {
        await tx.unsafe("SET LOCAL ROLE app_runtime");
        await tx`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
          VALUES (${parent}, ${"role-ok"}, ${"once"}, ${"10.00"}, ${"MYR"}, ${"flat"}, ${"2026-03-01T00:00:00Z"})`;
      });
      const [row] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${parent}`;
      expect(row?.count).toBe("1");
    });

    it("fires and rejects under app_runtime on an ACTIVE parent (the internal SELECT resolves the status, not a permission error)", async () => {
      const parent = await insertOffering({
        name: "role active",
        status: "ACTIVE",
      });
      let err: unknown;
      try {
        await sql.begin(async (tx) => {
          await tx.unsafe("SET LOCAL ROLE app_runtime");
          await tx`
            INSERT INTO product.product_offering_price
              (product_offering_id, name, price_type, amount, currency, pricing_model, start_date_time)
            VALUES (${parent}, ${"role-blocked"}, ${"once"}, ${"10.00"}, ${"MYR"}, ${"flat"}, ${"2026-03-01T00:00:00Z"})`;
        });
      } catch (e) {
        err = e;
      }
      expect(String(err)).toContain("product_child_write_requires_draft");
      expect(String(err)).toContain("ACTIVE");
    });
  },
);
