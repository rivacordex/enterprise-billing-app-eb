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
      // pm70 (0056): a price is a header + its subtype row, and the deferred
      // completeness trigger reads every pop_* table — app_runtime holds DML on
      // all five child tables in production via the product default privilege.
      await sql.unsafe(
        'GRANT SELECT, INSERT, UPDATE, DELETE ON "product"."pop_usage_rate", "product"."pop_flat_fee", "product"."pop_capacity_commitment", "product"."pop_motivation_step", "product"."product_spec_characteristic" TO app_runtime',
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

    // A complete one-time flat price (no charge period, no unit) — deliberately
    // the price shape that trips none of the per-type CHECKs, so a rejection
    // here can only be the pm36 trigger. Since pm70 (0056) a price is a header
    // plus its `pop_flat_fee` row, written in ONE transaction (the deferred
    // completeness trigger refuses a header committed alone). Returns the
    // header id.
    async function insertPrice(
      offeringId: string,
      opts: { name: string; startDateTime?: string },
    ): Promise<string> {
      let id = "";
      await sql.begin(async (tx) => {
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_type, currency, start_date_time)
          VALUES (
            ${offeringId}, ${opts.name}, ${"flat_fee"}, ${"oneTime"},
            ${"MYR"},
            ${opts.startDateTime ?? "2026-01-01T00:00:00Z"}
          )
          RETURNING product_offering_price_id AS id`;
        id = row?.id ?? "";
        await tx`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount)
                 VALUES (${id}, 10)`;
      });
      return id;
    }

    async function insertSpec(
      offeringId: string,
      name: string,
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO product.product_specifications
          (ref_product_offering_id, name, is_mandatory, is_default)
        VALUES (${offeringId}, ${name}, false, false)
        RETURNING product_spec_id AS id`;
      return row?.id ?? "";
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

    // ── Re-parenting guard (both OLD and NEW parent must be DRAFT) ───────────
    // A direct-SQL UPDATE that moves a child from one offering to another must
    // not strip a spec/price off a released version. The trigger validates the
    // parent losing the row AND the parent gaining it.

    it("rejects re-parenting a price OFF an ACTIVE parent (OLD-side guard)", async () => {
      // Priced while DRAFT, then activated — the price now sits on a released
      // version. Moving it to a DRAFT sibling would silently mutate the ACTIVE
      // offering's price set; the OLD-side check rejects it.
      const active = await insertOffering({
        name: "rp off-active",
        status: "DRAFT",
      });
      await insertPrice(active, { name: "rp-p1" });
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${active}`;
      const draft = await insertOffering({
        name: "rp target-draft",
        status: "DRAFT",
      });

      let err: unknown;
      try {
        await sql`UPDATE product.product_offering_price SET product_offering_id = ${draft}
                  WHERE product_offering_id = ${active}`;
      } catch (e) {
        err = e;
      }
      expect(String(err)).toContain("product_child_write_requires_draft");
      expect(String(err)).toContain("ACTIVE");
    });

    it("rejects re-parenting a price ONTO an ACTIVE parent (NEW-side guard)", async () => {
      const draft = await insertOffering({
        name: "rp src-draft",
        status: "DRAFT",
      });
      await insertPrice(draft, { name: "rp-p2" });
      const active = await insertOffering({
        name: "rp onto-active",
        status: "DRAFT",
      });
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${active}`;

      let err: unknown;
      try {
        await sql`UPDATE product.product_offering_price SET product_offering_id = ${active}
                  WHERE product_offering_id = ${draft}`;
      } catch (e) {
        err = e;
      }
      expect(String(err)).toContain("product_child_write_requires_draft");
      expect(String(err)).toContain("ACTIVE");
    });

    it("allows re-parenting a price between two DRAFT parents", async () => {
      const a = await insertOffering({ name: "rp draft-a", status: "DRAFT" });
      await insertPrice(a, { name: "rp-p3" });
      const b = await insertOffering({ name: "rp draft-b", status: "DRAFT" });

      await sql`UPDATE product.product_offering_price SET product_offering_id = ${b}
                WHERE product_offering_id = ${a}`;

      const [onA] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${a}`;
      const [onB] = await sql<{ count: string }[]>`
        SELECT count(*)::text AS count FROM product.product_offering_price
        WHERE product_offering_id = ${b}`;
      expect(onA?.count).toBe("0");
      expect(onB?.count).toBe("1");
    });

    // ── pm70 (0056): the five new child tables (guardrail 45, DB arm) ───────
    // A write to any of product_spec_characteristic and the four pop_* tables
    // under a non-DRAFT version fails 23514 naming the guard; a discarded DRAFT
    // cascades offering → spec/header → subtype → steps with zero orphans.

    async function addCharacteristic(
      specId: string,
      name: string,
      order: number,
    ): Promise<unknown> {
      return sql`
        INSERT INTO product.product_spec_characteristic
          (product_spec_id, char_name, char_value, display_order)
        VALUES (${specId}, ${name}, 'v', ${order})`;
    }

    // One of each of the four price types on a DRAFT offering, header + child
    // in one transaction each. Returns the header ids by type.
    type PriceType =
      | "usage_rate"
      | "flat_fee"
      | "capacity_commitment"
      | "capacity_motivation";
    async function seedAllPriceTypes(
      offeringId: string,
    ): Promise<Record<PriceType, string>> {
      const ids: Partial<Record<PriceType, string>> = {};
      const headers: [
        PriceType,
        string,
        string | null,
        number | null,
        string | null,
      ][] = [
        ["usage_rate", "usage", "GB", null, null],
        ["flat_fee", "recurring", null, 1, "months"],
        ["capacity_commitment", "commitment", "GB", null, null],
        ["capacity_motivation", "discount", "GB", null, null],
      ];
      for (const [type, priceType, unit, len, period] of headers) {
        await sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO product.product_offering_price
              (product_offering_id, name, component_type, price_type,
               unit_of_measure, recurring_charge_period_length,
               recurring_charge_period_type, currency, start_date_time)
            VALUES (${offeringId}, ${type}, ${type}, ${priceType}, ${unit},
                    ${len}, ${period}, 'MYR', '2026-01-01T00:00:00Z')
            RETURNING product_offering_price_id AS id`;
          const id = row?.id ?? "";
          ids[type] = id;
          if (type === "usage_rate") {
            await tx`INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit) VALUES (${id}, 1)`;
          } else if (type === "flat_fee") {
            await tx`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount) VALUES (${id}, 1)`;
          } else if (type === "capacity_commitment") {
            await tx`INSERT INTO product.pop_capacity_commitment (product_offering_price_id, committed_quantity) VALUES (${id}, 100)`;
          } else {
            await tx`INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit)
                     VALUES (${id}, 100, 2), (${id}, 200, 1)`;
          }
        });
      }
      return ids as Record<PriceType, string>;
    }

    type ChildCounts = Record<
      "chars" | "usage" | "flat" | "commitment" | "steps",
      number
    >;
    async function childCounts(): Promise<ChildCounts> {
      const [row] = await sql<Record<keyof ChildCounts, string>[]>`
        SELECT (SELECT count(*) FROM product.product_spec_characteristic)::text AS chars,
               (SELECT count(*) FROM product.pop_usage_rate)::text AS usage,
               (SELECT count(*) FROM product.pop_flat_fee)::text AS flat,
               (SELECT count(*) FROM product.pop_capacity_commitment)::text AS commitment,
               (SELECT count(*) FROM product.pop_motivation_step)::text AS steps`;
      return {
        chars: Number(row?.chars),
        usage: Number(row?.usage),
        flat: Number(row?.flat),
        commitment: Number(row?.commitment),
        steps: Number(row?.steps),
      };
    }

    async function expectGuard(fn: () => Promise<unknown>): Promise<void> {
      let err: { code?: string; message?: string } | undefined;
      try {
        await fn();
      } catch (e) {
        err = e as { code?: string; message?: string };
      }
      expect(err?.code).toBe("23514");
      expect(String(err?.message)).toContain(
        "product_child_write_requires_draft",
      );
      expect(String(err?.message)).toContain("ACTIVE");
    }

    it("refuses INSERT/UPDATE/DELETE on each of the five new tables under an ACTIVE version (23514)", async () => {
      const parent = await insertOffering({
        name: "n1 active",
        status: "DRAFT",
      });
      const specId = await insertSpec(parent, "spec");
      await addCharacteristic(specId, "SST_ID", 1);
      const ids = await seedAllPriceTypes(parent);
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${parent}`;

      // product_spec_characteristic
      await expectGuard(() => addCharacteristic(specId, "SD_ID", 2));
      await expectGuard(
        () => sql`UPDATE product.product_spec_characteristic SET char_value = 'x'
                  WHERE product_spec_id = ${specId}`,
      );
      await expectGuard(
        () =>
          sql`DELETE FROM product.product_spec_characteristic WHERE product_spec_id = ${specId}`,
      );
      // pop_usage_rate
      await expectGuard(
        () => sql`UPDATE product.pop_usage_rate SET rate_per_unit = 2
                  WHERE product_offering_price_id = ${ids.usage_rate}`,
      );
      await expectGuard(
        () =>
          sql`DELETE FROM product.pop_usage_rate WHERE product_offering_price_id = ${ids.usage_rate}`,
      );
      // pop_flat_fee
      await expectGuard(
        () => sql`UPDATE product.pop_flat_fee SET amount = 2
                  WHERE product_offering_price_id = ${ids.flat_fee}`,
      );
      await expectGuard(
        () =>
          sql`DELETE FROM product.pop_flat_fee WHERE product_offering_price_id = ${ids.flat_fee}`,
      );
      // pop_capacity_commitment
      await expectGuard(
        () => sql`UPDATE product.pop_capacity_commitment SET committed_quantity = 5
                  WHERE product_offering_price_id = ${ids.capacity_commitment}`,
      );
      await expectGuard(
        () =>
          sql`DELETE FROM product.pop_capacity_commitment WHERE product_offering_price_id = ${ids.capacity_commitment}`,
      );
      // pop_motivation_step — INSERT too (a 1:N table accepts a new row)
      await expectGuard(
        () => sql`INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit)
                  VALUES (${ids.capacity_motivation}, 300, 0.5)`,
      );
      await expectGuard(
        () => sql`UPDATE product.pop_motivation_step SET rate_per_unit = 9
                  WHERE product_offering_price_id = ${ids.capacity_motivation}`,
      );
      await expectGuard(
        () =>
          sql`DELETE FROM product.pop_motivation_step WHERE product_offering_price_id = ${ids.capacity_motivation}`,
      );
    });

    it("refuses an INSERT into each 1:1 subtype table under an ACTIVE version (23514 before the PK)", async () => {
      // The guard is a BEFORE trigger, so it refuses ahead of the PK / FK.
      const parent = await insertOffering({
        name: "n1b active",
        status: "DRAFT",
      });
      const ids = await seedAllPriceTypes(parent);
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${parent}`;
      await expectGuard(
        () =>
          sql`INSERT INTO product.pop_usage_rate (product_offering_price_id, rate_per_unit) VALUES (${ids.usage_rate}, 1)`,
      );
      await expectGuard(
        () =>
          sql`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount) VALUES (${ids.flat_fee}, 1)`,
      );
      await expectGuard(
        () =>
          sql`INSERT INTO product.pop_capacity_commitment (product_offering_price_id, committed_quantity) VALUES (${ids.capacity_commitment}, 1)`,
      );
    });

    it("accepts writes to the five new tables while the version is DRAFT", async () => {
      const parent = await insertOffering({
        name: "n2 draft",
        status: "DRAFT",
      });
      const specId = await insertSpec(parent, "spec");
      await addCharacteristic(specId, "A", 1);
      await sql`UPDATE product.product_spec_characteristic SET char_value = 'w'
                WHERE product_spec_id = ${specId}`;
      const ids = await seedAllPriceTypes(parent);
      await sql`UPDATE product.pop_flat_fee SET amount = 3
                WHERE product_offering_price_id = ${ids.flat_fee}`;
      await sql`INSERT INTO product.pop_motivation_step (product_offering_price_id, above_quantity, rate_per_unit)
                VALUES (${ids.capacity_motivation}, 300, 0.5)`;
      const [row] = await sql<{ amount: string }[]>`
        SELECT amount::text AS amount FROM product.pop_flat_fee
         WHERE product_offering_price_id = ${ids.flat_fee}`;
      expect(Number(row?.amount)).toBe(3);
    });

    it("discarding a DRAFT with a spec (two characteristics) and all four price types leaves zero rows in every child table (Inv. #69)", async () => {
      const before = await childCounts();
      const parent = await insertOffering({
        name: "n3 discard",
        status: "DRAFT",
      });
      const specId = await insertSpec(parent, "spec");
      await addCharacteristic(specId, "SST_ID", 1);
      await addCharacteristic(specId, "SD_ID", 2);
      await seedAllPriceTypes(parent);
      const during = await childCounts();
      expect(during.chars - before.chars).toBe(2);
      expect(during.steps - before.steps).toBe(2);

      await sql`DELETE FROM product.product_offering WHERE product_offering_id = ${parent}`;

      expect(await childCounts()).toEqual(before);
      const counts = await countChildren(parent);
      expect(counts).toEqual({ specs: 0, prices: 0, offerings: 0 });
    });

    it("discarding a TESTING version cascades through three levels too (parent-gone branch)", async () => {
      const before = await childCounts();
      const parent = await insertOffering({
        name: "n4 testing",
        status: "DRAFT",
      });
      const specId = await insertSpec(parent, "spec");
      await addCharacteristic(specId, "K", 1);
      await seedAllPriceTypes(parent);
      await sql`UPDATE product.product_offering SET lifecycle_status = 'TESTING'
                WHERE product_offering_id = ${parent}`;
      await sql`DELETE FROM product.product_offering WHERE product_offering_id = ${parent}`;
      expect(await childCounts()).toEqual(before);
    });

    it("refuses moving a pop_flat_fee row OFF a released version's header onto a DRAFT one (OLD-side guard)", async () => {
      const released = await insertOffering({
        name: "n5 released",
        status: "DRAFT",
      });
      const fromHeader = await insertPrice(released, { name: "n5-from" });
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${released}`;
      const draft = await insertOffering({ name: "n5 draft", status: "DRAFT" });
      // A DRAFT flat_fee header with no child yet, inside one transaction so the
      // re-parent attempt is the only thing that could complete it.
      let err: { code?: string; message?: string } | undefined;
      try {
        await sql.begin(async (tx) => {
          const [row] = await tx<{ id: string }[]>`
            INSERT INTO product.product_offering_price
              (product_offering_id, name, component_type, price_type, currency, start_date_time)
            VALUES (${draft}, 'n5-to', 'flat_fee', 'oneTime', 'MYR', '2026-01-01T00:00:00Z')
            RETURNING product_offering_price_id AS id`;
          await tx`UPDATE product.pop_flat_fee SET product_offering_price_id = ${row?.id ?? ""}
                   WHERE product_offering_price_id = ${fromHeader}`;
        });
      } catch (e) {
        err = e as { code?: string; message?: string };
      }
      expect(err?.code).toBe("23514");
      expect(String(err?.message)).toContain(
        "product_child_write_requires_draft",
      );
    });

    it("re-parenting a pop_flat_fee row onto a header of another type is refused by the FK (type pinning)", async () => {
      const parent = await insertOffering({
        name: "n6 draft",
        status: "DRAFT",
      });
      const ids = await seedAllPriceTypes(parent);
      let err: { code?: string; constraint_name?: string } | undefined;
      try {
        await sql`UPDATE product.pop_flat_fee SET product_offering_price_id = ${ids.usage_rate}
                  WHERE product_offering_price_id = ${ids.flat_fee}`;
      } catch (e) {
        err = e as { code?: string; constraint_name?: string };
      }
      expect(err?.code).toBe("23503");
      expect(err?.constraint_name).toBe("pop_flat_fee_header_fk");
    });

    it("a characteristic cannot be moved from a released version's spec to a DRAFT one", async () => {
      const released = await insertOffering({
        name: "n7 released",
        status: "DRAFT",
      });
      const fromSpec = await insertSpec(released, "from");
      await addCharacteristic(fromSpec, "MOVE_ME", 1);
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                WHERE product_offering_id = ${released}`;
      const draft = await insertOffering({ name: "n7 draft", status: "DRAFT" });
      const toSpec = await insertSpec(draft, "to");
      await expectGuard(
        () => sql`UPDATE product.product_spec_characteristic SET product_spec_id = ${toSpec}
                  WHERE product_spec_id = ${fromSpec}`,
      );
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
        const [row] = await tx<{ id: string }[]>`
          INSERT INTO product.product_offering_price
            (product_offering_id, name, component_type, price_type, currency, start_date_time)
          VALUES (${parent}, ${"role-ok"}, ${"flat_fee"}, ${"oneTime"}, ${"MYR"}, ${"2026-03-01T00:00:00Z"})
          RETURNING product_offering_price_id AS id`;
        // The pop_flat_fee guard resolves its offering through the header and
        // the deferred completeness trigger reads pop_flat_fee — both under
        // app_runtime.
        await tx`INSERT INTO product.pop_flat_fee (product_offering_price_id, amount)
                 VALUES (${row?.id ?? ""}, 10)`;
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
              (product_offering_id, name, component_type, price_type, currency, start_date_time)
            VALUES (${parent}, ${"role-blocked"}, ${"flat_fee"}, ${"oneTime"}, ${"MYR"}, ${"2026-03-01T00:00:00Z"})`;
        });
      } catch (e) {
        err = e;
      }
      expect(String(err)).toContain("product_child_write_requires_draft");
      expect(String(err)).toContain("ACTIVE");
    });
  },
);
