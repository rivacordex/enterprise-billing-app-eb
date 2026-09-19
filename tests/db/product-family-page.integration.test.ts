import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { LifecycleStatus } from "@/types/product";

// pm39-spec I8.1 / V9. Live-DB proof of findFamilyPage: one row per family, the
// primary version chosen ACTIVE → open → highest, with versionCount and
// openVersionId; filters apply to the primary; paging/total count families.
const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)("findFamilyPage (requires DATABASE_URL)", () => {
  let sql: postgresjs.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;

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
    db = drizzle(sql, { schema });
    await migrate(db, {
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

  beforeEach(async () => {
    await sql.unsafe("TRUNCATE product.product_offering CASCADE");
  });

  async function seedOffering(o: {
    name: string;
    status: LifecycleStatus;
    family?: string | null;
    version: number;
    isSellable?: boolean;
    billingOnly?: boolean;
  }): Promise<string> {
    const rows = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status,
           version, family_offering_id)
        VALUES (${o.name}, false, ${o.isSellable ?? true},
                ${o.billingOnly ?? false},
                ${o.status}::product.lifecycle_status, ${o.version},
                ${o.family ?? null})
        RETURNING product_offering_id`;
    return rows[0]!.product_offering_id;
  }

  const ALL = { q: "", status: null, page: 1, pageSize: 50 } as const;

  it("picks the ACTIVE version as primary and carries the open DRAFT as openVersionId", async () => {
    const root = await seedOffering({
      name: "Fibre",
      status: "ACTIVE",
      version: 1,
    });
    const draft = await seedOffering({
      name: "Fibre",
      status: "DRAFT",
      family: root,
      version: 2,
    });

    const { rows, total } = await productOfferingRepository.findFamilyPage(
      db,
      ALL,
    );

    expect(total).toBe(1);
    expect(rows[0]).toMatchObject({
      familyId: root,
      primaryVersionId: root,
      lifecycleStatus: "ACTIVE",
      version: 1,
      versionCount: 2,
      openVersionId: draft,
    });
  });

  it("picks the open version as primary when there is no ACTIVE version (DRAFT only)", async () => {
    const root = await seedOffering({
      name: "Draft Only",
      status: "DRAFT",
      version: 1,
    });

    const { rows } = await productOfferingRepository.findFamilyPage(db, ALL);

    expect(rows[0]).toMatchObject({
      primaryVersionId: root,
      lifecycleStatus: "DRAFT",
      versionCount: 1,
      openVersionId: root,
    });
  });

  it("picks ACTIVE over OBSOLETE and reports no open version", async () => {
    // OBSOLETE root, ACTIVE branch — one family, no open (DRAFT/TESTING) row.
    const root = await seedOffering({
      name: "Superseded",
      status: "OBSOLETE",
      version: 1,
    });
    await seedOffering({
      name: "Superseded",
      status: "ACTIVE",
      family: root,
      version: 2,
    });

    const { rows } = await productOfferingRepository.findFamilyPage(db, ALL);

    expect(rows[0]).toMatchObject({
      familyId: root,
      lifecycleStatus: "ACTIVE",
      version: 2,
      versionCount: 2,
      openVersionId: null,
    });
  });

  it("falls back to the highest version for a single RETIRED version", async () => {
    const root = await seedOffering({
      name: "Legacy",
      status: "RETIRED",
      version: 3,
    });

    const { rows } = await productOfferingRepository.findFamilyPage(db, ALL);

    expect(rows[0]).toMatchObject({
      primaryVersionId: root,
      lifecycleStatus: "RETIRED",
      version: 3,
      versionCount: 1,
      openVersionId: null,
    });
  });

  it("filters q and status against the primary version, not any version", async () => {
    // Alpha's primary is ACTIVE though it has a DRAFT child.
    const alpha = await seedOffering({
      name: "Alpha",
      status: "ACTIVE",
      version: 1,
    });
    await seedOffering({
      name: "Alpha",
      status: "DRAFT",
      family: alpha,
      version: 2,
    });
    await seedOffering({ name: "Beta", status: "DRAFT", version: 1 });

    const byName = await productOfferingRepository.findFamilyPage(db, {
      ...ALL,
      q: "alph",
    });
    expect(byName.total).toBe(1);
    expect(byName.rows[0]?.name).toBe("Alpha");

    const drafts = await productOfferingRepository.findFamilyPage(db, {
      ...ALL,
      status: "DRAFT",
    });
    // Only Beta — Alpha's primary is ACTIVE, so it does not match DRAFT (D3).
    expect(drafts.total).toBe(1);
    expect(drafts.rows[0]?.name).toBe("Beta");

    const actives = await productOfferingRepository.findFamilyPage(db, {
      ...ALL,
      status: "ACTIVE",
    });
    expect(actives.total).toBe(1);
    expect(actives.rows[0]?.name).toBe("Alpha");
  });

  it("pages families (not versions) in name order with a total that survives LIMIT", async () => {
    // Insert in a deliberately shuffled order so the assertions prove the SQL
    // ORDER BY name — not incidental insertion/id order.
    const seedOrder = [7, 2, 11, 4, 9, 1, 6, 12, 3, 8, 5, 10];
    for (const i of seedOrder) {
      await seedOffering({
        name: `Product ${String(i).padStart(2, "0")}`,
        status: "ACTIVE",
        version: 1,
      });
    }

    const page1 = await productOfferingRepository.findFamilyPage(db, {
      q: "",
      status: null,
      page: 1,
      pageSize: 5,
    });
    const page3 = await productOfferingRepository.findFamilyPage(db, {
      q: "",
      status: null,
      page: 3,
      pageSize: 5,
    });

    expect(page1.total).toBe(12);
    expect(page1.rows.map((r) => r.name)).toEqual([
      "Product 01",
      "Product 02",
      "Product 03",
      "Product 04",
      "Product 05",
    ]);
    expect(page3.total).toBe(12);
    expect(page3.rows.map((r) => r.name)).toEqual(["Product 11", "Product 12"]);
  });
});
