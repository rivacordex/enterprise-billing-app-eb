import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { productOfferingRepository } from "@/db/repositories/product-offering";
import { productOfferingPriceRepository } from "@/db/repositories/product-offering-price";
import { productSpecificationRepository } from "@/db/repositories/product-specification";
import type { activateOffering as ActivateOffering } from "@/services/product/activate-offering";
import type { addSpecification as AddSpecification } from "@/services/product/add-specification";
import type { deleteOffering as DeleteOffering } from "@/services/product/delete-offering";
import type { deleteSpecification as DeleteSpecification } from "@/services/product/delete-specification";
import type { submitForTesting as SubmitForTesting } from "@/services/product/submit-for-testing";
import type { updateSpecification as UpdateSpecification } from "@/services/product/update-specification";
import type * as AuditRepository from "@/db/repositories/audit.repository";
import type { AuditEventInput } from "@/db/repositories/audit.repository";

import {
  auditCalls,
  closeProductDatabase,
  connectProductDatabase,
  countingDb,
  insertTestActor,
  migrateProductDatabase,
  type ProductTestDb,
} from "./helpers/product-db-harness";

// pm72-spec I1 — guardrail 49 (characteristics keep entry order), guardrail 45
// (spec half), Inv. #66 / #69 / #73 (spec half), §1.63 and §3.24.
// Specifications are written through the services; raw SQL appears only where
// the assertion is about the database itself.
const databaseUrl = process.env.DATABASE_URL;

// Audit payloads are asserted on the object the service hands to
// insertAuditEvent: `before_data` / `after_data` are jsonb, which re-orders
// keys, so key ORDER can only be seen before it is stored.
vi.mock("@/db/repositories/audit.repository", async (importOriginal) =>
  (await import("./helpers/product-db-harness")).captureAuditEvents(
    await importOriginal<typeof AuditRepository>(),
  ),
);

const START = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago

// Today's payload keys (§1.63), in order.
const PAYLOAD_KEYS = [
  "offeringId",
  "name",
  "isMandatory",
  "isDefault",
  "defaultValue",
  "productSpecCharacteristics",
];
const BRANCHED_PAYLOAD_KEYS = [
  "offeringId",
  "branchedFromOfferingId",
  ...PAYLOAD_KEYS.slice(1),
];

type PgError = { code?: string; constraint_name?: string; message?: string };
type Characteristics = Record<string, string>;

async function refusal(work: Promise<unknown>): Promise<PgError> {
  try {
    await work;
  } catch (err) {
    return err as PgError;
  }
  throw new Error("expected the statement to be refused");
}

describe.skipIf(!databaseUrl)(
  "pm72 specification characteristics — guardrails 49, 45 (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ProductTestDb;
    let addSpecification: typeof AddSpecification;
    let updateSpecification: typeof UpdateSpecification;
    let deleteSpecification: typeof DeleteSpecification;
    let submitForTesting: typeof SubmitForTesting;
    let activateOffering: typeof ActivateOffering;
    let deleteOffering: typeof DeleteOffering;
    let actorId: string;

    const repo = productSpecificationRepository;

    beforeAll(async () => {
      sql = connectProductDatabase(databaseUrl as string);
      db = await migrateProductDatabase(sql);
      ({ addSpecification } =
        await import("@/services/product/add-specification"));
      ({ updateSpecification } =
        await import("@/services/product/update-specification"));
      ({ deleteSpecification } =
        await import("@/services/product/delete-specification"));
      ({ submitForTesting } =
        await import("@/services/product/submit-for-testing"));
      ({ activateOffering } =
        await import("@/services/product/activate-offering"));
      ({ deleteOffering } = await import("@/services/product/delete-offering"));
      actorId = await insertTestActor(db, "Characteristic Tester");
    }, 120_000);

    afterAll(async () => {
      await closeProductDatabase(sql);
    }, 120_000);

    async function createDraft(name: string): Promise<string> {
      const { offeringId } = await db.transaction((tx) =>
        productOfferingRepository.insertOffering(tx, {
          name,
          isSellable: true,
          billingOnly: true,
        }),
      );
      return offeringId;
    }

    function specInput(name: string, record: Characteristics) {
      return {
        name,
        isMandatory: false,
        isDefault: false,
        defaultValue: null,
        productSpecCharacteristics: record,
      };
    }

    async function add(
      offeringId: string,
      name: string,
      record: Characteristics,
    ): Promise<string> {
      const result = await addSpecification(
        offeringId,
        specInput(name, record),
        actorId,
      );
      if (!result.ok) throw new Error(`addSpecification: ${result.code}`);
      return result.productSpecId;
    }

    async function update(
      specId: string,
      offeringId: string,
      name: string,
      record: Characteristics,
    ) {
      const result = await updateSpecification(
        specId,
        offeringId,
        specInput(name, record),
        actorId,
      );
      if (!result.ok) throw new Error(`updateSpecification: ${result.code}`);
      return result;
    }

    // DRAFT → TESTING → ACTIVE through the release services.
    async function activate(offeringId: string): Promise<void> {
      await db.transaction((tx) =>
        productOfferingPriceRepository.insertPrice(tx, {
          productOfferingId: offeringId,
          name: "Fee",
          componentType: "flat_fee",
          component: {
            "@type": "flat_fee",
            specVersion: 1,
            plaSpecId: null,
            priceType: "oneTime",
            appliesAt: "billing",
            basis: "flat",
            boundTo: null,
            params: { amount: "100" },
          },
          currency: "USD",
          glCode: null,
          unitOfMeasure: null,
          recurringChargePeriodLength: null,
          recurringChargePeriodType: null,
          startDateTime: START,
        }),
      );
      const submitted = await submitForTesting(
        offeringId,
        { reason: "" },
        actorId,
      );
      expect(submitted).toEqual({ ok: true, offeringId });
      const activated = await activateOffering(
        offeringId,
        { reason: "" },
        actorId,
      );
      expect(activated.ok).toBe(true);
    }

    async function cardOf(offeringId: string, specId: string) {
      const card = (await repo.findByOfferingId(db, offeringId)).find(
        (c) => c.productSpecId === specId,
      );
      if (!card) throw new Error(`no card for ${specId}`);
      return card;
    }

    async function rowsOf(specId: string) {
      const rows = await sql<
        { char_name: string; char_value: string; display_order: number }[]
      >`
        SELECT char_name, char_value, display_order
          FROM product.product_spec_characteristic
         WHERE product_spec_id = ${specId}
         ORDER BY display_order`;
      return rows.map((r) => [r.char_name, r.char_value, r.display_order]);
    }

    // I1.1
    it("characteristics keep entry order, with display_order 1…n", async () => {
      const offeringId = await createDraft("entry order");
      const id = await add(offeringId, "Slice", {
        SST_ID: "01",
        SD_ID: "A0C4E2",
        DNN: "internet",
      });
      const card = await cardOf(offeringId, id);
      expect(Object.entries(card.characteristics)).toEqual([
        ["SST_ID", "01"],
        ["SD_ID", "A0C4E2"],
        ["DNN", "internet"],
      ]);
      // §2.32 — nothing but the six card fields leaves the repository.
      expect(Object.keys(card).sort()).toEqual([
        "characteristics",
        "defaultValue",
        "isDefault",
        "isMandatory",
        "name",
        "productSpecId",
      ]);
      expect(await rowsOf(id)).toEqual([
        ["SST_ID", "01", 1],
        ["SD_ID", "A0C4E2", 2],
        ["DNN", "internet", 3],
      ]);
    });

    // I1.2
    it("the reverse entry order reads back reversed", async () => {
      const offeringId = await createDraft("reverse order");
      const forward = await add(offeringId, "Forward", {
        SST_ID: "01",
        SD_ID: "A0C4E2",
        DNN: "internet",
      });
      const reversed = await add(offeringId, "Reversed", {
        DNN: "internet",
        SD_ID: "A0C4E2",
        SST_ID: "01",
      });
      const keys = async (id: string) =>
        Object.keys((await cardOf(offeringId, id)).characteristics);
      expect(await keys(forward)).toEqual(["SST_ID", "SD_ID", "DNN"]);
      expect(await keys(reversed)).toEqual(["DNN", "SD_ID", "SST_ID"]);
    });

    // I1.3
    it("{} writes no rows, on insert and on update", async () => {
      const offeringId = await createDraft("empty");
      const id = await add(offeringId, "Empty", {});
      expect(await rowsOf(id)).toEqual([]);
      expect((await cardOf(offeringId, id)).characteristics).toEqual({});

      await update(id, offeringId, "Empty", { A: "1" });
      expect(await rowsOf(id)).toEqual([["A", "1", 1]]);
      await update(id, offeringId, "Empty", {});
      expect(await rowsOf(id)).toEqual([]);
      expect((await cardOf(offeringId, id)).characteristics).toEqual({});
    });

    // I1.4
    it("an update replaces the row set and renumbers it", async () => {
      const offeringId = await createDraft("replace");
      const id = await add(offeringId, "Slice", {
        SST_ID: "01",
        SD_ID: "A0C4E2",
        DNN: "internet",
      });
      await update(id, offeringId, "Slice", { DNN: "ims", SST_ID: "02" });
      expect(await rowsOf(id)).toEqual([
        ["DNN", "ims", 1],
        ["SST_ID", "02", 2],
      ]);
      expect(
        Object.keys((await cardOf(offeringId, id)).characteristics),
      ).toEqual(["DNN", "SST_ID"]);
    });

    it("updateSpecification on the wrong offering throws and leaves the rows alone", async () => {
      const offeringId = await createDraft("backstop");
      const otherId = await createDraft("backstop other");
      const id = await add(offeringId, "Slice", { A: "1", B: "2" });
      await expect(
        db.transaction((tx) =>
          repo.updateSpecification(tx, id, otherId, specInput("x", {})),
        ),
      ).rejects.toThrow(/not found on offering/);
      expect(await rowsOf(id)).toEqual([
        ["A", "1", 1],
        ["B", "2", 2],
      ]);
    });

    // I1.5 (Inv. #73) and the cascade half of I1.6.
    it("a branch copies (char_name, char_value, display_order) verbatim; the source is untouched; discard leaves no rows", async () => {
      const sourceId = await createDraft("branch source");
      // Two specifications share a name: only an exact id map keeps their rows
      // apart.
      await add(sourceId, "Slice", { SST_ID: "01", SD_ID: "A0C4E2", DNN: "i" });
      await add(sourceId, "Slice", { DNN: "ims", SST_ID: "02" });
      await add(sourceId, "Empty", {});
      const gapId = await add(sourceId, "Gap", { Z: "1", A: "2" });
      const editedId = await add(sourceId, "Edited", { Y: "1", X: "2" });
      // Not a state the repository writes: a gap that a renumbering copy would
      // close.
      await sql`UPDATE product.product_spec_characteristic
                   SET display_order = display_order + 10
                 WHERE product_spec_id = ${gapId}`;
      await activate(sourceId);

      const snapshotSource = () => sql<{ r: string }[]>`
        SELECT c::text AS r FROM product.product_spec_characteristic c
          JOIN product.product_specifications s USING (product_spec_id)
         WHERE s.ref_product_offering_id = ${sourceId}
        UNION ALL
        SELECT s::text FROM product.product_specifications s
         WHERE s.ref_product_offering_id = ${sourceId}
         ORDER BY 1`;
      const sourceBefore = [...(await snapshotSource())];

      // A rename only: the edited clone's characteristics stay the source's.
      const result = await update(editedId, sourceId, "Edited v2", {
        Y: "1",
        X: "2",
      });
      expect(result.branched).toBe(true);
      const branchId = result.offeringId;

      const project = async (offeringId: string) => {
        const cards = await repo.findByOfferingId(db, offeringId);
        const projected = await Promise.all(
          cards.map(async (c) =>
            JSON.stringify([
              c.name === "Edited v2" ? "Edited" : c.name,
              c.isMandatory,
              c.isDefault,
              c.defaultValue,
              Object.entries(c.characteristics),
              await rowsOf(c.productSpecId),
            ]),
          ),
        );
        // Same-named specifications tie-break on a generated id, so compare as
        // a multiset of fully ordered contents.
        return projected.sort();
      };
      expect(await project(branchId)).toEqual(await project(sourceId));
      const branchSpecs = await repo.findByOfferingId(db, branchId);
      expect(branchSpecs).toHaveLength(5);
      const branchGap = branchSpecs.find((c) => c.name === "Gap")!;
      expect(await rowsOf(branchGap.productSpecId)).toEqual([
        ["Z", "1", 11],
        ["A", "2", 12],
      ]);
      expect([...(await snapshotSource())]).toEqual(sourceBefore);

      // I1.6, D6 — the discard cascade never trips the guard.
      const branchSpecIds = branchSpecs.map((c) => c.productSpecId);
      const countRows = async () => {
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM product.product_spec_characteristic
           WHERE product_spec_id IN ${sql(branchSpecIds)}`;
        return row!.n;
      };
      expect(await countRows()).toBe(9);
      const discarded = await deleteOffering(branchId, { reason: "" }, actorId);
      expect(discarded.ok).toBe(true);
      expect(await countRows()).toBe(0);
      expect([...(await snapshotSource())]).toEqual(sourceBefore);
    });

    // I1.6 (guardrail 45, spec half; Inv. #69)
    it("raw INSERT, UPDATE and DELETE under an ACTIVE version fail with 23514", async () => {
      const offeringId = await createDraft("guard");
      const id = await add(offeringId, "Slice", { A: "1" });
      await activate(offeringId);
      const attempts = [
        sql`INSERT INTO product.product_spec_characteristic
              (product_spec_id, char_name, char_value, display_order)
            VALUES (${id}, 'B', '2', 2)`,
        sql`UPDATE product.product_spec_characteristic
               SET char_value = '9' WHERE product_spec_id = ${id}`,
        sql`DELETE FROM product.product_spec_characteristic
             WHERE product_spec_id = ${id}`,
      ];
      for (const attempt of attempts) {
        const err = await refusal(attempt);
        expect(err.code).toBe("23514");
        expect(err.message).toContain("product_child_write_requires_draft");
      }
      expect(await rowsOf(id)).toEqual([["A", "1", 1]]);
    });

    // I1.7
    it("the database refuses a duplicate name, a duplicate order and an empty name without Zod", async () => {
      const offeringId = await createDraft("constraints");
      const id = await add(offeringId, "Slice", { A: "1" });
      const insertRaw = (name: string, order: number) =>
        refusal(
          sql`INSERT INTO product.product_spec_characteristic
                (product_spec_id, char_name, char_value, display_order)
              VALUES (${id}, ${name}, 'x', ${order})`,
        );
      const duplicateName = await insertRaw("A", 2);
      expect(duplicateName.code).toBe("23505");
      expect(duplicateName.constraint_name).toBe(
        "product_spec_characteristic_pk",
      );
      const duplicateOrder = await insertRaw("B", 1);
      expect(duplicateOrder.code).toBe("23505");
      expect(duplicateOrder.constraint_name).toBe(
        "product_spec_characteristic_order_unique",
      );
      const emptyName = await insertRaw("", 2);
      expect(emptyName.code).toBe("23514");
      expect(emptyName.constraint_name).toBe(
        "product_spec_characteristic_name_check",
      );
    });

    // I1.8 (§1.63)
    describe("audit payloads carry the record, in order", () => {
      const eventOf = (eventType: AuditEventInput["eventType"]) => {
        const event = auditCalls.find((e) => e.eventType === eventType);
        if (!event) throw new Error(`no ${eventType} event`);
        return {
          before: event.beforeData as Record<string, unknown> | null,
          after: event.afterData as Record<string, unknown> | null,
        };
      };
      // Entry arrays, so key order is compared and not just key sets.
      const entriesOf = (payload: Record<string, unknown> | null) =>
        Object.entries(payload!.productSpecCharacteristics as Characteristics);

      it("CREATED, UPDATED and DELETED on a DRAFT", async () => {
        const offeringId = await createDraft("audit draft");
        auditCalls.length = 0;
        const id = await add(offeringId, "Slice", { Z: "1", A: "2", M: "3" });
        const created = eventOf("PRODUCT_SPECIFICATION_CREATED");
        const read1 = await cardOf(offeringId, id);
        expect(created.before).toBeNull();
        expect(Object.keys(created.after!)).toEqual(PAYLOAD_KEYS);
        expect(entriesOf(created.after)).toEqual(
          Object.entries(read1.characteristics),
        );

        await update(id, offeringId, "Slice", { M: "4", Z: "5" });
        const updated = eventOf("PRODUCT_SPECIFICATION_UPDATED");
        const read2 = await cardOf(offeringId, id);
        expect(Object.keys(updated.before!)).toEqual(PAYLOAD_KEYS);
        expect(Object.keys(updated.after!)).toEqual(PAYLOAD_KEYS);
        expect(entriesOf(updated.before)).toEqual(
          Object.entries(read1.characteristics),
        );
        expect(entriesOf(updated.after)).toEqual(
          Object.entries(read2.characteristics),
        );
        expect(Object.keys(read2.characteristics)).toEqual(["M", "Z"]);

        const deleted = await deleteSpecification(id, offeringId, actorId);
        expect(deleted.ok).toBe(true);
        const removed = eventOf("PRODUCT_SPECIFICATION_DELETED");
        expect(removed.after).toBeNull();
        expect(Object.keys(removed.before!)).toEqual(PAYLOAD_KEYS);
        expect(entriesOf(removed.before)).toEqual(
          Object.entries(read2.characteristics),
        );
        expect(await rowsOf(id)).toEqual([]);
      });

      it("UPDATED on a branch", async () => {
        const offeringId = await createDraft("audit branch");
        const id = await add(offeringId, "Slice", { Z: "1", A: "2" });
        await activate(offeringId);
        const readBefore = await cardOf(offeringId, id);
        auditCalls.length = 0;
        const result = await update(id, offeringId, "Slice", {
          N: "0",
          A: "2",
        });
        expect(result.branched).toBe(true);
        const readAfter = await cardOf(result.offeringId, result.productSpecId);
        const updated = eventOf("PRODUCT_SPECIFICATION_UPDATED");
        expect(Object.keys(updated.before!)).toEqual(PAYLOAD_KEYS);
        expect(Object.keys(updated.after!)).toEqual(BRANCHED_PAYLOAD_KEYS);
        expect(entriesOf(updated.before)).toEqual(
          Object.entries(readBefore.characteristics),
        );
        expect(entriesOf(updated.after)).toEqual(
          Object.entries(readAfter.characteristics),
        );
      });
    });

    // I1.9 (§3.24)
    it("findByOfferingId is ONE statement; findByOfferingIdForUpdate is TWO and returns the same cards", async () => {
      const offeringId = await createDraft("query budget");
      await add(offeringId, "S1", { B: "1", A: "2" });
      await add(offeringId, "S2", { D: "1", C: "2" });
      await add(offeringId, "S3", {});

      const readStatements: string[] = [];
      const cards = await repo.findByOfferingId(
        countingDb(sql, readStatements),
        offeringId,
      );
      expect(cards).toHaveLength(3);
      expect(readStatements).toHaveLength(1);

      const lockStatements: string[] = [];
      const lockedCards = await repo.findByOfferingIdForUpdate(
        countingDb(sql, lockStatements),
        offeringId,
      );
      expect(lockStatements).toHaveLength(2);
      const ordered = (cs: typeof cards) =>
        cs.map((c) => [c, Object.entries(c.characteristics)]);
      expect(ordered(lockedCards)).toEqual(ordered(cards));

      // No specifications: the characteristics statement is skipped.
      const emptyId = await createDraft("query budget empty");
      lockStatements.length = 0;
      expect(
        await repo.findByOfferingIdForUpdate(
          countingDb(sql, lockStatements),
          emptyId,
        ),
      ).toEqual([]);
      expect(lockStatements).toHaveLength(1);
    });

    it("findByOfferingIdForUpdate locks the specification rows", async () => {
      const offeringId = await createDraft("lock");
      const id = await add(offeringId, "S1", { A: "1" });
      const other = postgres(databaseUrl as string, { max: 1 });
      try {
        await db.transaction(async (tx) => {
          await repo.findByOfferingIdForUpdate(tx, offeringId);
          const err = await refusal(
            other`SELECT 1 FROM product.product_specifications
                   WHERE product_spec_id = ${id} FOR UPDATE NOWAIT`,
          );
          expect(err.code).toBe("55P03");
        });
      } finally {
        await other.end();
      }
    });
  },
);
