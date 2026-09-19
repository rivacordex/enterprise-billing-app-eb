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

// pm39-spec I8.2 (the unit's headline proof) / V9. Renders the real Manage
// Products page against the test database with a statement counter installed on
// the pool (the `postgres` client's `debug` hook — the harness's own query log),
// and asserts the first render issues exactly TWO product_offering statements
// (findFamilyPage's page + count) and ZERO statements against the child tables —
// no per-row detail fetch (§1.16). Named `.integration.test.ts` so it runs in
// the DB-backed project (the DB-free jsdom project excludes it) — a slight
// filename deviation from the spec, required by the harness split.
//
// `db` is mocked to a counted drizzle client so the page's own `@/db/client`
// singleton routes through the counter; auth and app-config reads are stubbed so
// the only DB traffic during render is the families query and the page-size read.
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({
  queries: [] as string[],
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

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, {
        max: 1,
        onnotice: () => {},
        debug: (_connection, query) => {
          hoisted.queries.push(query);
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
      for (const name of ["Alpha", "Beta"]) {
        await sql`
          INSERT INTO product.product_offering
            (name, is_bundle, is_sellable, billing_only, lifecycle_status, version)
          VALUES (${name}, false, true, false, 'ACTIVE', 1)`;
      }
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

    it("issues exactly two product_offering statements and none against the child tables on first render", async () => {
      const { default: ManageProductsPage } =
        await import("@/app/(app)/products/manage-products/page");

      await ManageProductsPage({ searchParams: Promise.resolve({}) });

      const captured = hoisted.queries;
      const offeringStmts = captured.filter((q) =>
        /product\.product_offering\b/.test(q),
      );
      const priceStmts = captured.filter((q) =>
        /product_offering_price/.test(q),
      );
      const specStmts = captured.filter((q) =>
        /product_specifications/.test(q),
      );

      expect(offeringStmts).toHaveLength(2);
      expect(priceStmts).toHaveLength(0);
      expect(specStmts).toHaveLength(0);
    });
  },
);
