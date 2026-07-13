import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
} from "@/db/schema/product";
import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import type { getOfferingDetail as GetOfferingDetail } from "@/services/product/get-offering-detail";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { LifecycleStatus } from "@/types/product";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product repositories + services/product (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let getOfferingDetail: typeof GetOfferingDetail;
    let editorUserId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      // "product" holds FKs into "core", so it must drop first.
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Exercises the real `getOfferingDetail` service's own internal
      // `@/db/client` pool (not the local `db` connection above) — dynamic
      // import after confirming DATABASE_URL, mirroring
      // tests/services/roles-read.service.integration.test.ts.
      ({ getOfferingDetail } =
        await import("@/services/product/get-offering-detail"));

      const [user] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Product Editor",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      editorUserId = user!.id;
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function insertOffering(data: {
      name: string;
      lifecycleStatus?: LifecycleStatus;
      lastModified?: Date;
      lastEditedBy?: string | null;
    }): Promise<string> {
      const [row] = await db
        .insert(productOffering)
        .values({
          name: data.name,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: data.lifecycleStatus ?? "ACTIVE",
          version: 1,
          lastModified: data.lastModified ?? new Date(),
          lastEditedBy: data.lastEditedBy ?? null,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      return row!.productOfferingId;
    }

    async function insertFlatPrice(data: {
      productOfferingId: string;
      priceType: "recurring" | "usage" | "once";
      startDateTime: Date;
      amount: string;
      name?: string;
    }): Promise<void> {
      const characteristics = priceCharacteristicsSchema.parse({
        pricing_model: "flat",
        amount: data.amount,
        pricing_characteristics: null,
      });
      await db.insert(productOfferingPrice).values({
        productOfferingId: data.productOfferingId,
        name: data.name ?? `${data.priceType} price`,
        priceType: data.priceType,
        currency: "MYR",
        pricingModel: characteristics.pricing_model,
        amount: characteristics.amount,
        pricingCharacteristics: characteristics.pricing_characteristics,
        startDateTime: data.startDateTime,
      });
    }

    async function insertTieredPrice(data: {
      productOfferingId: string;
      priceType: "recurring" | "usage" | "once";
      startDateTime: Date;
      name?: string;
    }): Promise<void> {
      const characteristics = priceCharacteristicsSchema.parse({
        pricing_model: "tiered",
        amount: null,
        pricing_characteristics: {
          tiers: [{ from: 0, to: null, rate: "0.05" }],
        },
      });
      await db.insert(productOfferingPrice).values({
        productOfferingId: data.productOfferingId,
        name: data.name ?? `${data.priceType} tiered price`,
        priceType: data.priceType,
        currency: "MYR",
        pricingModel: characteristics.pricing_model,
        amount: characteristics.amount,
        pricingCharacteristics: characteristics.pricing_characteristics,
        startDateTime: data.startDateTime,
      });
    }

    describe("findList", () => {
      it("default (status: null) excludes RETIRED and includes true total across a genuine second page", async () => {
        await insertOffering({ name: "PAGINATE Alpha" });
        await insertOffering({
          name: "PAGINATE Bravo",
          lifecycleStatus: "DRAFT",
        });
        await insertOffering({ name: "PAGINATE Charlie" });
        await insertOffering({
          name: "PAGINATE Delta",
          lifecycleStatus: "RETIRED",
        });
        await insertOffering({ name: "PAGINATE Echo" });
        await insertOffering({
          name: "PAGINATE Foxtrot",
          lifecycleStatus: "DRAFT",
        });
        await insertOffering({ name: "PAGINATE Golf" });

        const all = await productOfferingRepository.findList(db, {
          q: "PAGINATE",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        expect(all.total).toBe(6);
        expect(all.rows.map((r) => r.name)).not.toContain("PAGINATE Delta");

        const page1 = await productOfferingRepository.findList(db, {
          q: "PAGINATE",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 5,
        });
        expect(page1.rows).toHaveLength(5);
        expect(page1.total).toBe(6);

        const page2 = await productOfferingRepository.findList(db, {
          q: "PAGINATE",
          status: null,
          sort: "name",
          page: 2,
          pageSize: 5,
        });
        expect(page2.rows).toHaveLength(1);
        expect(page2.total).toBe(6);

        const combinedNames = [...page1.rows, ...page2.rows].map((r) => r.name);
        expect(new Set(combinedNames).size).toBe(6);
        expect(combinedNames).toEqual(
          all.rows
            .filter((r) => r.name !== "PAGINATE Delta")
            .map((r) => r.name),
        );

        const pastEnd = await productOfferingRepository.findList(db, {
          q: "PAGINATE",
          status: null,
          sort: "name",
          page: 5,
          pageSize: 5,
        });
        expect(pastEnd.rows).toEqual([]);
        expect(pastEnd.total).toBe(6);
      });

      it("status: 'RETIRED' returns only RETIRED rows", async () => {
        const retired = await productOfferingRepository.findList(db, {
          q: "PAGINATE",
          status: "RETIRED",
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        expect(retired.total).toBe(1);
        expect(retired.rows[0]?.name).toBe("PAGINATE Delta");
      });

      it("case-insensitive substring search; %/_ are treated literally; no match returns empty", async () => {
        await insertOffering({ name: "SEARCH Percent%Sign" });
        await insertOffering({ name: "SEARCH Underscore_Char" });
        await insertOffering({ name: "SEARCH Plain" });

        const caseInsensitive = await productOfferingRepository.findList(db, {
          q: "plain",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        expect(caseInsensitive.rows.map((r) => r.name)).toEqual([
          "SEARCH Plain",
        ]);

        const literalPercent = await productOfferingRepository.findList(db, {
          q: "%",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        expect(literalPercent.rows.map((r) => r.name)).toEqual([
          "SEARCH Percent%Sign",
        ]);

        const literalUnderscore = await productOfferingRepository.findList(db, {
          q: "_",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        expect(literalUnderscore.rows.map((r) => r.name)).toEqual([
          "SEARCH Underscore_Char",
        ]);

        const noMatch = await productOfferingRepository.findList(db, {
          q: "zzz_no_match_xyz",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        expect(noMatch).toEqual({ rows: [], total: 0 });
      });

      it("name vs -name reverse each other", async () => {
        await insertOffering({ name: "REV Alpha" });
        await insertOffering({ name: "REV Bravo" });
        await insertOffering({ name: "REV Charlie" });

        const asc = await productOfferingRepository.findList(db, {
          q: "REV",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        const desc = await productOfferingRepository.findList(db, {
          q: "REV",
          status: null,
          sort: "-name",
          page: 1,
          pageSize: 10,
        });

        expect(asc.rows.map((r) => r.name)).toEqual([
          "REV Alpha",
          "REV Bravo",
          "REV Charlie",
        ]);
        expect(desc.rows.map((r) => r.name)).toEqual(
          [...asc.rows.map((r) => r.name)].reverse(),
        );
      });

      it("ties break by product_offering_id ASC regardless of sort direction", async () => {
        const firstId = await insertOffering({ name: "SORTTIE Same" });
        const secondId = await insertOffering({ name: "SORTTIE Same" });

        const asc = await productOfferingRepository.findList(db, {
          q: "SORTTIE",
          status: null,
          sort: "name",
          page: 1,
          pageSize: 10,
        });
        const desc = await productOfferingRepository.findList(db, {
          q: "SORTTIE",
          status: null,
          sort: "-name",
          page: 1,
          pageSize: 10,
        });

        expect(asc.rows.map((r) => r.productOfferingId)).toEqual([
          firstId,
          secondId,
        ]);
        expect(desc.rows.map((r) => r.productOfferingId)).toEqual([
          firstId,
          secondId,
        ]);
      });

      it("-last_modified orders correctly", async () => {
        await insertOffering({
          name: "LASTMOD A",
          lastModified: new Date("2020-01-01T00:00:00Z"),
        });
        await insertOffering({
          name: "LASTMOD B",
          lastModified: new Date("2021-01-01T00:00:00Z"),
        });
        await insertOffering({
          name: "LASTMOD C",
          lastModified: new Date("2022-01-01T00:00:00Z"),
        });

        const desc = await productOfferingRepository.findList(db, {
          q: "LASTMOD",
          status: null,
          sort: "-last_modified",
          page: 1,
          pageSize: 10,
        });
        expect(desc.rows.map((r) => r.name)).toEqual([
          "LASTMOD C",
          "LASTMOD B",
          "LASTMOD A",
        ]);

        const asc = await productOfferingRepository.findList(db, {
          q: "LASTMOD",
          status: null,
          sort: "last_modified",
          page: 1,
          pageSize: 10,
        });
        expect(asc.rows.map((r) => r.name)).toEqual([
          "LASTMOD A",
          "LASTMOD B",
          "LASTMOD C",
        ]);
      });
    });

    describe("findDetailById", () => {
      it("resolves lastEditedByName via the APPUSER join, and null for a NULL last_edited_by", async () => {
        const editedId = await insertOffering({
          name: "DETAIL Edited",
          lastEditedBy: editorUserId,
        });
        const nullEditedId = await insertOffering({
          name: "DETAIL Null Edited",
          lastEditedBy: null,
        });

        const edited = await productOfferingRepository.findDetailById(
          db,
          editedId,
        );
        expect(edited?.lastEditedByName).toBe("Product Editor");

        const nullEdited = await productOfferingRepository.findDetailById(
          db,
          nullEditedId,
        );
        expect(nullEdited?.lastEditedByName).toBeNull();
      });

      it("returns null for an unknown ID", async () => {
        const result = await productOfferingRepository.findDetailById(
          db,
          "PRDOFR999999",
        );
        expect(result).toBeNull();
      });
    });

    describe("derived effectivity from real SQL", () => {
      it("LEAD window derives ends per partition; a different price_type does not truncate the chain", async () => {
        const offeringId = await insertOffering({ name: "DETAIL Main" });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2025-01-01T00:00:00Z"),
          amount: "100.00",
          name: "Recurring Past",
        });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          amount: "110.00",
          name: "Recurring Current",
        });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2027-01-01T00:00:00Z"),
          amount: "120.00",
          name: "Recurring Future",
        });
        // Different price_type, start date interleaved with the recurring
        // chain — must not truncate it if partitioning is correct.
        await insertTieredPrice({
          productOfferingId: offeringId,
          priceType: "usage",
          startDateTime: new Date("2026-06-01T00:00:00Z"),
          name: "Usage Overage",
        });

        const priceRows =
          await productOfferingPriceRepository.findByOfferingIdWithDerivedEnd(
            db,
            offeringId,
          );

        const past = priceRows.find((p) => p.name === "Recurring Past")!;
        const current = priceRows.find((p) => p.name === "Recurring Current")!;
        const future = priceRows.find((p) => p.name === "Recurring Future")!;
        const usage = priceRows.find((p) => p.name === "Usage Overage")!;

        expect(past.endDateTime).toEqual(new Date("2026-01-01T00:00:00Z"));
        expect(current.endDateTime).toEqual(new Date("2027-01-01T00:00:00Z"));
        expect(future.endDateTime).toBeNull();
        // Partition correctness: the usage price's own chain has no
        // successor, so its end is null — unaffected by the recurring chain.
        expect(usage.endDateTime).toBeNull();
      });

      it("getOfferingDetail marks the chain superseded/current/future and never filters rows", async () => {
        const offeringId = await insertOffering({
          name: "DETAIL Assembly",
          lastEditedBy: editorUserId,
        });
        const characteristics = productSpecCharacteristicsSchema.parse({
          SST_ID: "01",
        });
        await db.insert(productSpecifications).values({
          refProductOfferingId: offeringId,
          name: "Network Slice",
          isMandatory: true,
          isDefault: true,
          defaultValue: null,
          productSpecCharacteristics: characteristics,
        });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2025-01-01T00:00:00Z"),
          amount: "100.00",
          name: "Recurring Past",
        });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2026-01-01T00:00:00Z"),
          amount: "110.00",
          name: "Recurring Current",
        });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2027-01-01T00:00:00Z"),
          amount: "120.00",
          name: "Recurring Future",
        });

        const now = new Date("2026-07-04T00:00:00Z");
        const detail = await getOfferingDetail(offeringId, now);

        expect(detail).not.toBeNull();
        expect(detail?.lastEditedByName).toBe("Product Editor");
        expect(detail?.specifications).toHaveLength(1);
        expect(detail?.prices).toHaveLength(3);

        const past = detail!.prices.find((p) => p.name === "Recurring Past")!;
        const current = detail!.prices.find(
          (p) => p.name === "Recurring Current",
        )!;
        const future = detail!.prices.find(
          (p) => p.name === "Recurring Future",
        )!;

        expect(past.effectivityStatus).toBe("superseded");
        expect(current.effectivityStatus).toBe("current");
        expect(future.effectivityStatus).toBe("future");
        expect(future.endDateTime).toBeNull();
      });
    });

    describe("0008 seeded config row", () => {
      it("findActiveValue returns the seeded page-size value", async () => {
        const value = await systemConfigRepository.findActiveValue(
          db,
          "products",
          "offering_list_page_size",
        );
        expect(value).toBe("5");
      });
    });
  },
);
