import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// pm39-spec I8.2 (the unit's headline proof) / V9, extended by pm40 I7/D5.
// Renders the real Manage Products page against the test database with a
// statement counter installed on the pool (the `postgres` client's `debug` hook
// — the harness's own query log), and asserts the exact per-render query budget:
//
//   • no selection      = 2 product_offering statements, 0 child-table (pm39)
//   • family selected   = 6 (findFamilyPage 2 + findFamilyVersions 1 +
//                            getOfferingDetail 3: detail + specs + prices)
//   • version switch    = 6 (same shape, a different `?version=`)
//   • unknown ?family=   = 3 (findFamilyPage 2 + findFamilyVersions 1, no detail)
//   • OBSOLETE selection = 6 product + 1 inventory (the live-subscription count,
//                            pm43 I7 — the D4 "+1" case)
//   • after a mutation   = 6, identical to a fresh selection: revalidatePath
//                            re-renders the whole route, not a partial panel
//                            refresh (pm45 D4)
//
// pm45 D4 extends this suite to the full page lifecycle and pins the EXACT
// integers per table (never a "3 or 4" range) so a real +1 regression — e.g. an
// N+1 against product_offering_price after a write — cannot pass on a
// coincidental total.
//
// pm40 D5 decision (recorded in the tracker): findFamilyPage is NOT held in a
// data cache — the module has no cache layer (architecture §1) and the existing
// mutations revalidate by path, not tag — so the families 2 statements are re-run
// on every selection. The spec checklist's illustrative "selection = 4" assumed
// the cached design; uncached, the always-paid 2 make it 6. Statement matching
// normalises identifier quotes so both findFamilyPage's raw SQL
// (`product.product_offering`) and the Drizzle-builder reads
// (`"product"."product_offering"`) are counted the same way.
//
// Named `.integration.test.ts` so it runs in the DB-backed project (the DB-free
// jsdom project excludes it) — a slight filename deviation from the spec,
// required by the harness split.
//
// `db` is mocked to a counted drizzle client so the page's own `@/db/client`
// singleton routes through the counter; auth and app-config reads are stubbed so
// the only DB traffic during render is the families query and the page-size read.
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({
  // Capture the bind parameters alongside the SQL text: a parameterised query's
  // target id lives in `params`, not the statement string, so proving a version
  // switch actually fetched the requested version needs the params (pm40 I7).
  queries: [] as { query: string; params: readonly unknown[] }[],
  holder: { db: undefined as unknown },
}));

vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

vi.mock("@/auth/guard", () => ({
  requirePermission: vi.fn().mockResolvedValue({
    userId: "admin-1",
    userEmail: "admin@example.com",
    permissionMap: { products: "EDIT" },
  }),
}));

vi.mock("@/services/system-config/app-config-read.service", () => ({
  getAppName: vi.fn().mockResolvedValue("Test"),
  getAppLocale: vi.fn().mockResolvedValue("en-US"),
  getAppTimezone: vi.fn().mockReturnValue("UTC"),
}));

describe.skipIf(!databaseUrl)(
  "Manage Products query budget (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    // Captured from the fixtures so the selection/switch cases can deep-link a
    // real family + version (the family root's own id is its family key).
    let alphaFamilyId: string;
    let alphaDraftId: string;
    // A single-version OBSOLETE family: selecting it resolves the OBSOLETE
    // primary, the one status whose page render also reads the live-subscription
    // count (pm43 I7) — the "+1" case in pm45 D4.
    let gammaFamilyId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, {
        max: 1,
        onnotice: () => {},
        debug: (_connection, query, params) => {
          hoisted.queries.push({ query, params });
        },
      });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      const db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      hoisted.holder.db = db;

      // Two families so the page has rows to render (the count is unaffected).
      // Alpha gets a second, DRAFT version so the selection/switch cases have a
      // real family with two versions — the one-open-per-family index (pm36)
      // permits exactly this one open version.
      const [alpha] = await sql<{ id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status, version)
        VALUES ('Alpha', false, true, false, 'ACTIVE', 1)
        RETURNING product_offering_id AS id`;
      alphaFamilyId = alpha!.id;

      await sql`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status, version)
        VALUES ('Beta', false, true, false, 'ACTIVE', 1)`;

      const [alphaDraft] = await sql<{ id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status, version, family_offering_id)
        VALUES ('Alpha', false, false, false, 'DRAFT', 2, ${alphaFamilyId})
        RETURNING product_offering_id AS id`;
      alphaDraftId = alphaDraft!.id;

      // Gamma: a lone OBSOLETE version (its own id is its family key). Selecting
      // family=Gamma resolves this OBSOLETE version as the primary (no ACTIVE,
      // no open, highest wins), so the page additionally reads the live count.
      // OBSOLETE is neither open nor ACTIVE, so no family index rejects it.
      const [gamma] = await sql<{ id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status, version)
        VALUES ('Gamma', false, false, false, 'OBSOLETE', 1)
        RETURNING product_offering_id AS id`;
      gammaFamilyId = gamma!.id;
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

    beforeEach(() => {
      hoisted.queries.length = 0;
    });

    // Strip identifier quotes first so raw SQL (`product.product_offering`) and
    // Drizzle-builder SQL (`"product"."product_offering"`) count identically.
    // We count STATEMENTS, not occurrences: `.filter(test)` hits each statement
    // once, so a statement that also references an offering *column* (e.g.
    // `product.product_offering.product_offering_id`) is still counted once, the
    // same as its `FROM product.product_offering`. The regex's trailing `\b`
    // matters only to keep the *price* child table out of the offering bucket:
    // `product.product_offering_price` has a `_` after "offering" (no word
    // boundary), so a price-only statement is never miscounted as an offering one.
    function countProductStatements(): {
      offering: number;
      price: number;
      spec: number;
      inventory: number;
    } {
      const normalised = hoisted.queries.map((q) => q.query.replace(/"/g, ""));
      return {
        offering: normalised.filter((q) =>
          /\bproduct\.product_offering\b/.test(q),
        ).length,
        price: normalised.filter((q) => /product_offering_price/.test(q))
          .length,
        spec: normalised.filter((q) => /product_specifications/.test(q)).length,
        // The live-subscription count (pm43 I7) — the only inventory read the
        // page ever issues, and only for an OBSOLETE selection.
        inventory: normalised.filter((q) =>
          /\binventory\.product_inventory\b/.test(q),
        ).length,
      };
    }

    // Every bind parameter across the render, flattened — used to prove WHICH
    // offering id getOfferingDetail was called with (the id is a bind param, not
    // in the SQL text), so version resolution is asserted behaviourally, not just
    // by statement count (which is identical for a switch vs a silent fallback).
    function allBindParams(): unknown[] {
      return hoisted.queries.flatMap((q) => [...q.params]);
    }

    async function renderManageProducts(
      searchParams: Record<string, string | string[] | undefined>,
    ): Promise<void> {
      const { default: ManageProductsPage } =
        await import("@/app/(app)/products/manage-products/page");
      await ManageProductsPage({ searchParams: Promise.resolve(searchParams) });
    }

    it("no selection ⇒ two product_offering statements and none against the child tables", async () => {
      await renderManageProducts({});

      const { offering, price, spec } = countProductStatements();
      expect(offering).toBe(2); // findFamilyPage: page + count
      expect(price).toBe(0);
      expect(spec).toBe(0);
    }, 30_000); // cold dynamic import of the page compiles the whole panel tree

    it("selecting a family ⇒ six statements, and the detail is fetched for the primary (ACTIVE) version, not the draft", async () => {
      await renderManageProducts({ family: alphaFamilyId });

      const { offering, price, spec, inventory } = countProductStatements();
      // findFamilyPage (2, re-run — not cached, D5) + findFamilyVersions (1) +
      // findDetailById (1) = 4 offering statements; specs (1) + prices (1).
      expect(offering).toBe(4);
      expect(price).toBe(1);
      expect(spec).toBe(1);
      expect(offering + price + spec).toBe(6);
      // An ACTIVE primary reads NO live-subscription count — that read is
      // OBSOLETE-only (contrast the OBSOLETE case below).
      expect(inventory).toBe(0);
      // No ?version= ⇒ the primary (ACTIVE root = alphaFamilyId) is selected;
      // the draft's detail is NOT fetched (its id never appears as a bind param).
      expect(allBindParams()).not.toContain(alphaDraftId);
    }, 30_000);

    it("switching version ⇒ six statements, and getOfferingDetail targets the requested version", async () => {
      await renderManageProducts({
        family: alphaFamilyId,
        version: alphaDraftId,
      });

      const { offering, price, spec } = countProductStatements();
      expect(offering).toBe(4);
      expect(price).toBe(1);
      expect(spec).toBe(1);
      expect(offering + price + spec).toBe(6);
      // ?version=<draft> is honoured: getOfferingDetail(alphaDraftId) binds the
      // draft id across its detail/specs/prices reads — a silent fallback to the
      // primary would leave alphaDraftId absent, so this distinguishes the two.
      expect(allBindParams()).toContain(alphaDraftId);
    }, 30_000);

    it("a well-formed but unknown ?family= ⇒ three statements (families 2 + versions 1), no detail", async () => {
      await renderManageProducts({ family: "PRDOFR00000404" });

      const { offering, price, spec } = countProductStatements();
      // findFamilyPage (2) + findFamilyVersions (1, returns no rows); the empty
      // version list resolves to null, so getOfferingDetail never runs (the one
      // budget case between "no selection = 2" and "selection = 6").
      expect(offering).toBe(3);
      expect(price).toBe(0);
      expect(spec).toBe(0);
    }, 30_000);

    it("selecting an OBSOLETE version ⇒ the six-statement selection budget PLUS exactly one live-subscription count (pm43 I7 / D4)", async () => {
      await renderManageProducts({ family: gammaFamilyId });

      const { offering, price, spec, inventory } = countProductStatements();
      // The product budget is unchanged from a normal selection (6); the OBSOLETE
      // status adds exactly ONE inventory read — the Retire blocked-state count —
      // and nothing more. This is the D4 "+1 for the live count" case.
      expect(offering).toBe(4);
      expect(price).toBe(1);
      expect(spec).toBe(1);
      expect(offering + price + spec).toBe(6);
      expect(inventory).toBe(1);
    }, 30_000);

    it("after a mutation ⇒ the same selection budget, never a partial 'panels only' refresh (D4)", async () => {
      // A mutation happened (modelled by a direct write to the selected DRAFT
      // version). The Server Action would then call `revalidatePath`, which
      // invalidates the WHOLE route — Next has no panels-only revalidation — so
      // the next render re-issues the FULL selection budget, not a cheaper
      // partial. We measure ONLY the post-mutation re-render (the counter is
      // cleared after the mutation's own statements), and assert per-table counts
      // so an N+1 against product_offering_price after a write fails here even if
      // the total coincidentally still summed to six.
      await sql`
        UPDATE product.product_offering
        SET name = 'Alpha (edited)'
        WHERE product_offering_id = ${alphaDraftId}`;
      hoisted.queries.length = 0;

      await renderManageProducts({
        family: alphaFamilyId,
        version: alphaDraftId,
      });

      const { offering, price, spec, inventory } = countProductStatements();
      expect(offering).toBe(4);
      expect(price).toBe(1);
      expect(spec).toBe(1);
      expect(offering + price + spec).toBe(6);
      // The DRAFT selection is not OBSOLETE, so no live count is read.
      expect(inventory).toBe(0);
      // …and the re-render actually re-selected the requested DRAFT version, not
      // a silent fallback to the ACTIVE primary (which would cost the identical
      // 4/1/1 and hide a "?version= ignored after revalidate" regression).
      expect(allBindParams()).toContain(alphaDraftId);
    }, 30_000);
  },
);
