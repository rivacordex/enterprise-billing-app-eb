import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, or } from "drizzle-orm";
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
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { priceCharacteristicsSchema } from "@/validation/product/pricing-characteristics.schema";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import type { getOfferingDetail as GetOfferingDetail } from "@/services/product/get-offering-detail";
import type { addSpecification as AddSpecification } from "@/services/product/add-specification";
import type { updateSpecification as UpdateSpecification } from "@/services/product/update-specification";
import type { deleteSpecification as DeleteSpecification } from "@/services/product/delete-specification";
import type { insertPrice as InsertPrice } from "@/services/product/insert-price";
import type { updateOffering as UpdateOffering } from "@/services/product/update-offering";
import type { activateOffering as ActivateOffering } from "@/services/product/activate-offering";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { LifecycleStatus } from "@/types/product";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "product repositories + services/product (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let getOfferingDetail: typeof GetOfferingDetail;
    let addSpecification: typeof AddSpecification;
    let updateSpecification: typeof UpdateSpecification;
    let deleteSpecification: typeof DeleteSpecification;
    let insertPrice: typeof InsertPrice;
    let updateOffering: typeof UpdateOffering;
    let activateOffering: typeof ActivateOffering;
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

      // Exercises the real services' own internal `@/db/client` pool (not
      // the local `db` connection above) — dynamic import after confirming
      // DATABASE_URL, mirroring tests/services/roles-read.service.
      // integration.test.ts. Bundled into one Promise.all, same convention
      // as tests/auth/guard.integration.test.ts's action-module imports.
      const [
        getOfferingDetailMod,
        addSpecificationMod,
        updateSpecificationMod,
        deleteSpecificationMod,
        insertPriceMod,
        updateOfferingMod,
        activateOfferingMod,
      ] = await Promise.all([
        import("@/services/product/get-offering-detail"),
        import("@/services/product/add-specification"),
        import("@/services/product/update-specification"),
        import("@/services/product/delete-specification"),
        import("@/services/product/insert-price"),
        import("@/services/product/update-offering"),
        import("@/services/product/activate-offering"),
      ]);
      getOfferingDetail = getOfferingDetailMod.getOfferingDetail;
      addSpecification = addSpecificationMod.addSpecification;
      updateSpecification = updateSpecificationMod.updateSpecification;
      deleteSpecification = deleteSpecificationMod.deleteSpecification;
      insertPrice = insertPriceMod.insertPrice;
      updateOffering = updateOfferingMod.updateOffering;
      activateOffering = activateOfferingMod.activateOffering;

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

    async function insertSpecRow(data: {
      productOfferingId: string;
      name: string;
      isMandatory?: boolean;
      isDefault?: boolean;
      defaultValue?: string | null;
    }): Promise<string> {
      const characteristics = productSpecCharacteristicsSchema.parse({
        SST_ID: "01",
      });
      const [row] = await db
        .insert(productSpecifications)
        .values({
          refProductOfferingId: data.productOfferingId,
          name: data.name,
          isMandatory: data.isMandatory ?? false,
          isDefault: data.isDefault ?? false,
          defaultValue: data.defaultValue ?? null,
          productSpecCharacteristics: characteristics,
        })
        .returning({ productSpecId: productSpecifications.productSpecId });
      return row!.productSpecId;
    }

    async function findFamilyRows(
      rootId: string,
    ): Promise<
      { productOfferingId: string; lifecycleStatus: LifecycleStatus }[]
    > {
      const rows = await db
        .select({
          productOfferingId: productOffering.productOfferingId,
          lifecycleStatus: productOffering.lifecycleStatus,
        })
        .from(productOffering)
        .where(
          or(
            eq(productOffering.productOfferingId, rootId),
            eq(productOffering.familyOfferingId, rootId),
          ),
        );
      return rows.map((r) => ({
        ...r,
        lifecycleStatus: r.lifecycleStatus as LifecycleStatus,
      }));
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

    // pm24-spec §3.1 pre-flight audit: guardrails 8/9/14 (code-standards-
    // phase2 §9) were verified against a live DB during pm12/13/14/15/16's
    // own development, but only via disposable, uncommitted scripts (per
    // each unit's progress-tracker note) — never captured as a permanent,
    // committed CI proof. pm24's ledger marks these rows "INHERIT — audit
    // present & green"; that audit found no such test existed. Added here,
    // under the owning behavior's own file, rather than invented as a
    // pm24-local workaround (pm24-spec §2.1's explicit boundary).
    describe("activateOffering (guardrail 8: single-active-per-family)", () => {
      it("activating a sibling draft retires the prior ACTIVE version in the same transaction", async () => {
        const rootId = await insertOffering({
          name: "GATE8 Root",
          lifecycleStatus: "DRAFT",
        });
        await insertFlatPrice({
          productOfferingId: rootId,
          priceType: "recurring",
          startDateTime: new Date(),
          amount: "10.00",
        });
        await insertSpecRow({ productOfferingId: rootId, name: "Slice" });

        const first = await activateOffering(rootId, {}, editorUserId);
        expect(first).toMatchObject({ ok: true, supersededOfferingId: null });

        const { offeringId: draftId } = await db.transaction((tx) =>
          productOfferingRepository.branchOfferingAsDraft(tx, rootId),
        );

        const second = await activateOffering(draftId, {}, editorUserId);
        expect(second).toMatchObject({
          ok: true,
          supersededOfferingId: rootId,
        });

        const rootRow = await productOfferingRepository.findDetailById(
          db,
          rootId,
        );
        const draftRow = await productOfferingRepository.findDetailById(
          db,
          draftId,
        );
        expect(rootRow?.lifecycleStatus).toBe("RETIRED");
        expect(draftRow?.lifecycleStatus).toBe("ACTIVE");
      });

      it("two near-simultaneous activations on sibling drafts leave exactly one ACTIVE member in the family", async () => {
        const rootId = await insertOffering({
          name: "GATE8 Race Root",
          lifecycleStatus: "DRAFT",
        });
        await insertFlatPrice({
          productOfferingId: rootId,
          priceType: "recurring",
          startDateTime: new Date(),
          amount: "10.00",
        });
        await insertSpecRow({ productOfferingId: rootId, name: "Slice" });

        const { offeringId: draftA } = await db.transaction((tx) =>
          productOfferingRepository.branchOfferingAsDraft(tx, rootId),
        );
        const { offeringId: draftB } = await db.transaction((tx) =>
          productOfferingRepository.branchOfferingAsDraft(tx, rootId),
        );

        const [resultA, resultB] = await Promise.all([
          activateOffering(draftA, {}, editorUserId),
          activateOffering(draftB, {}, editorUserId),
        ]);
        expect(resultA.ok).toBe(true);
        expect(resultB.ok).toBe(true);

        const familyRows = await findFamilyRows(rootId);
        const activeRows = familyRows.filter(
          (r) => r.lifecycleStatus === "ACTIVE",
        );
        expect(activeRows).toHaveLength(1);
      });
    });

    describe("branch-not-mutate (guardrail 9)", () => {
      it("editing an ACTIVE offering's fields leaves the original row byte-identical and produces exactly one new sibling DRAFT", async () => {
        const originalId = await insertOffering({
          name: "GATE9 Fields Original",
          lifecycleStatus: "ACTIVE",
        });
        const before = await productOfferingRepository.findDetailById(
          db,
          originalId,
        );

        const result = await updateOffering(
          originalId,
          {
            name: "GATE9 Fields Changed",
            isSellable: false,
            billingOnly: true,
            saveAsNew: false,
          },
          editorUserId,
        );
        expect(result).toMatchObject({ ok: true, branched: true });

        const after = await productOfferingRepository.findDetailById(
          db,
          originalId,
        );
        expect(after).toEqual(before);

        const familyRows = await findFamilyRows(originalId);
        const siblings = familyRows.filter(
          (r) => r.productOfferingId !== originalId,
        );
        expect(siblings).toHaveLength(1);
        expect(siblings[0]?.lifecycleStatus).toBe("DRAFT");

        if (result.ok) {
          const branched = await productOfferingRepository.findDetailById(
            db,
            result.offeringId,
          );
          expect(branched?.name).toBe("GATE9 Fields Changed");
          expect(branched?.isSellable).toBe(false);
          expect(branched?.billingOnly).toBe(true);
        }
      });

      it("adding a specification to an ACTIVE offering leaves existing specs untouched and clones them into one new sibling DRAFT", async () => {
        const originalId = await insertOffering({
          name: "GATE9 AddSpec Original",
          lifecycleStatus: "ACTIVE",
        });
        await insertSpecRow({
          productOfferingId: originalId,
          name: "Existing Spec",
        });
        const beforeSpecs =
          await productSpecificationRepository.findByOfferingId(db, originalId);

        const result = await addSpecification(
          originalId,
          {
            name: "New Spec",
            isMandatory: false,
            isDefault: false,
            defaultValue: null,
            productSpecCharacteristics: productSpecCharacteristicsSchema.parse({
              SST_ID: "02",
            }),
          },
          editorUserId,
        );
        expect(result).toMatchObject({ ok: true, branched: true });

        const afterSpecs =
          await productSpecificationRepository.findByOfferingId(db, originalId);
        expect(afterSpecs).toEqual(beforeSpecs);

        if (result.ok) {
          const branchedSpecs =
            await productSpecificationRepository.findByOfferingId(
              db,
              result.offeringId,
            );
          expect(branchedSpecs.map((s) => s.name).sort()).toEqual([
            "Existing Spec",
            "New Spec",
          ]);
        }
      });

      it("updating a specification on an ACTIVE offering leaves the original spec row byte-identical and updates only the cloned counterpart", async () => {
        const originalId = await insertOffering({
          name: "GATE9 UpdateSpec Original",
          lifecycleStatus: "ACTIVE",
        });
        const specId = await insertSpecRow({
          productOfferingId: originalId,
          name: "Mutable Spec",
          defaultValue: "old-value",
        });
        const beforeSpecs =
          await productSpecificationRepository.findByOfferingId(db, originalId);

        const result = await updateSpecification(
          specId,
          originalId,
          {
            name: "Mutable Spec",
            isMandatory: false,
            isDefault: false,
            defaultValue: "new-value",
            productSpecCharacteristics: productSpecCharacteristicsSchema.parse({
              SST_ID: "01",
            }),
          },
          editorUserId,
        );
        expect(result).toMatchObject({ ok: true, branched: true });

        const afterSpecs =
          await productSpecificationRepository.findByOfferingId(db, originalId);
        expect(afterSpecs).toEqual(beforeSpecs);

        if (result.ok) {
          const branchedSpecs =
            await productSpecificationRepository.findByOfferingId(
              db,
              result.offeringId,
            );
          expect(branchedSpecs).toHaveLength(1);
          expect(branchedSpecs[0]?.defaultValue).toBe("new-value");
        }
      });

      it("deleting a specification on an ACTIVE offering leaves the original spec row untouched and removes only the cloned counterpart", async () => {
        const originalId = await insertOffering({
          name: "GATE9 DeleteSpec Original",
          lifecycleStatus: "ACTIVE",
        });
        const keepId = await insertSpecRow({
          productOfferingId: originalId,
          name: "Keep Spec",
        });
        const removeId = await insertSpecRow({
          productOfferingId: originalId,
          name: "Remove Spec",
        });
        const beforeSpecs =
          await productSpecificationRepository.findByOfferingId(db, originalId);

        const result = await deleteSpecification(
          removeId,
          originalId,
          editorUserId,
        );
        expect(result).toMatchObject({ ok: true, branched: true });

        const afterSpecs =
          await productSpecificationRepository.findByOfferingId(db, originalId);
        expect(afterSpecs).toEqual(beforeSpecs);
        expect(afterSpecs.map((s) => s.productSpecId).sort()).toEqual(
          [keepId, removeId].sort(),
        );

        if (result.ok) {
          const branchedSpecs =
            await productSpecificationRepository.findByOfferingId(
              db,
              result.offeringId,
            );
          expect(branchedSpecs).toHaveLength(1);
          expect(branchedSpecs[0]?.name).toBe("Keep Spec");
        }
      });

      it("inserting a price on an ACTIVE offering leaves the original price row untouched and produces exactly one new sibling DRAFT", async () => {
        const originalId = await insertOffering({
          name: "GATE9 InsertPrice Original",
          lifecycleStatus: "ACTIVE",
        });
        await insertFlatPrice({
          productOfferingId: originalId,
          priceType: "recurring",
          startDateTime: new Date("2025-01-01T00:00:00Z"),
          amount: "50.00",
          name: "Existing Price",
        });
        const beforePrices = await db
          .select()
          .from(productOfferingPrice)
          .where(eq(productOfferingPrice.productOfferingId, originalId));

        const result = await insertPrice(
          originalId,
          {
            name: "New Price",
            priceType: "usage",
            currency: "MYR",
            glCode: null,
            startDateTime: new Date(),
            priceCharacteristics: priceCharacteristicsSchema.parse({
              pricing_model: "flat",
              amount: "5.00",
              pricing_characteristics: null,
            }),
          },
          editorUserId,
        );
        expect(result).toMatchObject({ ok: true, branched: true });

        const afterPrices = await db
          .select()
          .from(productOfferingPrice)
          .where(eq(productOfferingPrice.productOfferingId, originalId));
        expect(afterPrices).toEqual(beforePrices);

        if (result.ok) {
          const branchedPrices = await db
            .select()
            .from(productOfferingPrice)
            .where(
              eq(productOfferingPrice.productOfferingId, result.offeringId),
            );
          expect(branchedPrices.map((p) => p.name).sort()).toEqual([
            "Existing Price",
            "New Price",
          ]);
        }
      });
    });

    describe("price immutability, behavioral (guardrail 14)", () => {
      it("inserting a successor price on a DRAFT offering leaves the prior price row byte-identical and does not bump the offering version", async () => {
        const offeringId = await insertOffering({
          name: "GATE14 Price Original",
          lifecycleStatus: "DRAFT",
        });
        await insertFlatPrice({
          productOfferingId: offeringId,
          priceType: "recurring",
          startDateTime: new Date("2025-01-01T00:00:00Z"),
          amount: "50.00",
          name: "Original Price",
        });
        const beforeRows = await db
          .select()
          .from(productOfferingPrice)
          .where(eq(productOfferingPrice.productOfferingId, offeringId));
        expect(beforeRows).toHaveLength(1);
        const beforeOffering = await productOfferingRepository.findDetailById(
          db,
          offeringId,
        );

        const result = await insertPrice(
          offeringId,
          {
            name: "Successor Price",
            priceType: "recurring",
            currency: "MYR",
            glCode: null,
            startDateTime: new Date(),
            priceCharacteristics: priceCharacteristicsSchema.parse({
              pricing_model: "flat",
              amount: "60.00",
              pricing_characteristics: null,
            }),
          },
          editorUserId,
        );
        expect(result).toMatchObject({
          ok: true,
          branched: false,
          offeringId,
        });

        const afterRows = await db
          .select()
          .from(productOfferingPrice)
          .where(eq(productOfferingPrice.productOfferingId, offeringId));
        expect(afterRows).toHaveLength(2);
        const originalAfter = afterRows.find(
          (r) =>
            r.productOfferingPriceId === beforeRows[0]!.productOfferingPriceId,
        );
        expect(originalAfter).toEqual(beforeRows[0]);

        const afterOffering = await productOfferingRepository.findDetailById(
          db,
          offeringId,
        );
        expect(afterOffering?.version).toBe(beforeOffering?.version);
      });
    });
  },
);
