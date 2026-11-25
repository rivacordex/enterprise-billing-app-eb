import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type postgresjs from "postgres";

import {
  fromEnvelope,
  productOfferingPriceRepository,
  toEnvelope,
  type PriceWriteData,
} from "@/db/repositories/product-offering-price";
import { canonicalDecimalString } from "@/lib/decimal-string";
import type { insertPrice as InsertPriceService } from "@/services/product/insert-price";
import type * as AuditRepository from "@/db/repositories/audit.repository";
import type { ComponentType, UnitOfMeasure } from "@/types/product";
import type { PersistablePricingComponent } from "@/validation/product/pricing-component.schema";

import {
  auditCalls,
  closeProductDatabase,
  connectProductDatabase,
  countingDb,
  insertTestActor,
  migrateProductDatabase,
  type ProductTestDb,
} from "./helpers/product-db-harness";

// pm71-spec I1 — guardrail 42 (the envelope round-trip), Inv. #73 (price half:
// a branch copies rows and its envelopes deep-equal the source's) and §1.63
// (the audit payload's `component` is reassembled from rows). Every write goes
// through productOfferingPriceRepository on a transaction; every read through
// findByOfferingIdWithDerivedEnd or a raw relational/SQL read.
//
// Expected values are `canonical(x)`, never `x`'s text: "5500.00" is stored
// as 5500.000000 and read back as "5500" (C18).
const databaseUrl = process.env.DATABASE_URL;

// The PRODUCT_PRICE_ADDED payload is asserted on the object the service hands
// to insertAuditEvent — `after_data` is jsonb, which re-orders keys, so the key
// ORDER can only be seen before it is stored.
vi.mock("@/db/repositories/audit.repository", async (importOriginal) =>
  (await import("./helpers/product-db-harness")).captureAuditEvents(
    await importOriginal<typeof AuditRepository>(),
  ),
);

const START = new Date(Date.now() - 60 * 60 * 1000); // 1 hour ago
const LATER = new Date(START.getTime() + 365 * 24 * 60 * 60 * 1000);

// -- Fixture envelopes (I1.1) --------------------------------------------------

const USAGE_WITH_CARD: PersistablePricingComponent = {
  "@type": "usage_rate",
  specVersion: 1,
  plaSpecId: "PLA_USAGE_RATE",
  priceType: "usage",
  appliesAt: "rating",
  basis: "quantity",
  boundTo: { unitOfMeasure: "GB" },
  params: { ratePerUnit: "0.05", rateCardLookUp: "RAN_CARD_A" },
};
const USAGE_PLAIN: PersistablePricingComponent = {
  "@type": "usage_rate",
  specVersion: 1,
  plaSpecId: null,
  priceType: "usage",
  appliesAt: "rating",
  basis: "quantity",
  boundTo: { unitOfMeasure: "MB" },
  params: { ratePerUnit: "1234567.123456", rateCardLookUp: null },
};
const FLAT_RECURRING: PersistablePricingComponent = {
  "@type": "flat_fee",
  specVersion: 1,
  plaSpecId: null,
  priceType: "recurring",
  appliesAt: "billing",
  basis: "flat",
  boundTo: null,
  params: { amount: "100" },
};
const FLAT_ONE_TIME: PersistablePricingComponent = {
  "@type": "flat_fee",
  specVersion: 1,
  plaSpecId: null,
  priceType: "oneTime",
  appliesAt: "billing",
  basis: "flat",
  boundTo: null,
  params: { amount: "5500.00" }, // C18: back as "5500"
};
const COMMITMENT: PersistablePricingComponent = {
  "@type": "capacity_commitment",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_COMMITMENT",
  priceType: "commitment",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "GB" },
  params: { committedQuantity: 1234567.123456 },
};
const MOTIVATION_FIVE: PersistablePricingComponent = {
  "@type": "capacity_motivation",
  specVersion: 1,
  plaSpecId: "PLA_CAPACITY_MOTIVATION",
  priceType: "discount",
  appliesAt: "post_aggregation",
  basis: "quantity",
  boundTo: { unitOfMeasure: "GB" },
  params: {
    steps: [
      { aboveQuantity: 100, ratePerUnit: "0" },
      { aboveQuantity: 200.5, ratePerUnit: "0.05" },
      { aboveQuantity: 1000, ratePerUnit: "100" },
      { aboveQuantity: 5000, ratePerUnit: "12.5" },
      { aboveQuantity: 10000, ratePerUnit: "1234567.123456" },
    ],
  },
};
const MOTIVATION_THREE: PersistablePricingComponent = {
  ...MOTIVATION_FIVE,
  params: {
    steps: [
      { aboveQuantity: 50, ratePerUnit: "3" },
      { aboveQuantity: 150, ratePerUnit: "2" },
      { aboveQuantity: 750, ratePerUnit: "1" },
    ],
  },
} as PersistablePricingComponent;

const FIXTURES: Array<[string, PersistablePricingComponent]> = [
  ["usage_rate with rateCardLookUp", USAGE_WITH_CARD],
  ["usage_rate without rateCardLookUp", USAGE_PLAIN],
  ["flat_fee recurring", FLAT_RECURRING],
  ["flat_fee oneTime", FLAT_ONE_TIME],
  ["capacity_commitment", COMMITMENT],
  ["capacity_motivation, five bands", MOTIVATION_FIVE],
];

// The reference rows 0056 seeds (`price_component_type`).
const TYPE_ROWS = {
  usage_rate: {
    componentType: "usage_rate",
    appliesAt: "rating",
    basis: "quantity",
    plaSpecId: null,
    applyOrder: 10,
  },
  flat_fee: {
    componentType: "flat_fee",
    appliesAt: "billing",
    basis: "flat",
    plaSpecId: null,
    applyOrder: 20,
  },
  capacity_commitment: {
    componentType: "capacity_commitment",
    appliesAt: "post_aggregation",
    basis: "quantity",
    plaSpecId: "PLA_CAPACITY_COMMITMENT",
    applyOrder: 30,
  },
  capacity_motivation: {
    componentType: "capacity_motivation",
    appliesAt: "post_aggregation",
    basis: "quantity",
    plaSpecId: "PLA_CAPACITY_MOTIVATION",
    applyOrder: 40,
  },
} as const;

// `canonical(x)`: every money string through canonicalDecimalString.
function canonical(
  x: PersistablePricingComponent,
): PersistablePricingComponent {
  switch (x["@type"]) {
    case "usage_rate":
      return {
        ...x,
        params: {
          ...x.params,
          ratePerUnit: canonicalDecimalString(x.params.ratePerUnit),
        },
      };
    case "flat_fee":
      return {
        ...x,
        params: { amount: canonicalDecimalString(x.params.amount) },
      };
    case "capacity_commitment":
      return x;
    case "capacity_motivation":
      return {
        ...x,
        params: {
          steps: x.params.steps.map((s) => ({
            ...s,
            ratePerUnit: canonicalDecimalString(s.ratePerUnit),
          })),
        },
      };
  }
}

// node-postgres / postgres-js return numeric at its declared scale.
function pad6(value: string): string {
  const [int, frac = ""] = value.split(".");
  return `${int}.${frac.padEnd(6, "0")}`;
}

function unitOf(x: PersistablePricingComponent): UnitOfMeasure | null {
  return x.boundTo === null ? null : x.boundTo.unitOfMeasure;
}

function headerOf(x: PersistablePricingComponent) {
  const recurring = x["@type"] === "flat_fee" && x.priceType === "recurring";
  return {
    productOfferingPriceId: "PRDOFP00000001",
    productOfferingId: "PRDOFR00000001",
    name: "fixture",
    componentType: x["@type"],
    priceType: x.priceType,
    recurringChargePeriodLength: recurring ? 1 : null,
    recurringChargePeriodType: recurring ? "months" : null,
    unitOfMeasure: unitOf(x),
    currency: "USD",
    glCode: null,
    policy: null,
    startDateTime: START,
    createdAt: START,
  };
}

function childrenOf(x: PersistablePricingComponent) {
  const { child } = fromEnvelope(x);
  const id = "PRDOFP00000001";
  const type = TYPE_ROWS[x["@type"]];
  const base = {
    type,
    usageRate: null,
    flatFee: null,
    capacityCommitment: null,
    motivationSteps: [] as Array<{
      productOfferingPriceId: string;
      componentType: ComponentType;
      aboveQuantity: string;
      ratePerUnit: string;
    }>,
  };
  switch (child.table) {
    case "pop_usage_rate":
      return {
        ...base,
        usageRate: {
          productOfferingPriceId: id,
          componentType: "usage_rate" as const,
          ratePerUnit: pad6(child.row.ratePerUnit),
          rateCardLookup: child.row.rateCardLookup,
        },
      };
    case "pop_flat_fee":
      return {
        ...base,
        flatFee: {
          productOfferingPriceId: id,
          componentType: "flat_fee" as const,
          amount: pad6(child.row.amount),
        },
      };
    case "pop_capacity_commitment":
      return {
        ...base,
        capacityCommitment: {
          productOfferingPriceId: id,
          componentType: "capacity_commitment" as const,
          committedQuantity: pad6(child.row.committedQuantity),
        },
      };
    case "pop_motivation_step":
      return {
        ...base,
        motivationSteps: child.rows.map((r) => ({
          productOfferingPriceId: id,
          componentType: "capacity_motivation" as const,
          aboveQuantity: pad6(r.aboveQuantity),
          ratePerUnit: pad6(r.ratePerUnit),
        })),
      };
  }
}

function writeDataOf(
  x: PersistablePricingComponent,
  startDateTime: Date = START,
  name = "fixture",
): PriceWriteData {
  const recurring = x["@type"] === "flat_fee" && x.priceType === "recurring";
  return {
    name,
    componentType: x["@type"],
    component: x,
    currency: "USD",
    glCode: null,
    recurringChargePeriodLength: recurring ? 1 : null,
    recurringChargePeriodType: recurring ? "months" : null,
    unitOfMeasure: unitOf(x),
    startDateTime,
  };
}

const PASS = async () => ({ ok: true as const });

describe("pm71 envelope round-trip — pure (guardrail 42, no database)", () => {
  it.each(FIXTURES)(
    "%s: toEnvelope(header, children(fromEnvelope(x))) deep-equals canonical(x)",
    (_label, x) => {
      expect(toEnvelope(headerOf(x), childrenOf(x))).toEqual(canonical(x));
    },
  );

  it('"5500.00" comes back as "5500" (C18); the other fixtures are already canonical', () => {
    const back = toEnvelope(headerOf(FLAT_ONE_TIME), childrenOf(FLAT_ONE_TIME));
    expect(back.params).toEqual({ amount: "5500" });
    for (const [, x] of FIXTURES) {
      if (x !== FLAT_ONE_TIME) expect(canonical(x)).toEqual(x);
    }
  });

  it("throws on a header with no subtype row (a corruption, §1.49)", () => {
    const x = FLAT_RECURRING;
    expect(() =>
      toEnvelope(headerOf(x), { ...childrenOf(x), flatFee: null }),
    ).toThrow(/has no pop_flat_fee row/);
    expect(() =>
      toEnvelope(headerOf(MOTIVATION_FIVE), {
        ...childrenOf(MOTIVATION_FIVE),
        motivationSteps: [],
      }),
    ).toThrow(/has no pop_motivation_step row/);
  });
});

describe.skipIf(!databaseUrl)(
  "pm71 envelope round-trip through the database (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ProductTestDb;
    let insertPriceService: typeof InsertPriceService;
    let actorId: string;

    const repo = productOfferingPriceRepository;

    beforeAll(async () => {
      sql = connectProductDatabase(databaseUrl as string);
      db = await migrateProductDatabase(sql);
      insertPriceService = (await import("@/services/product/insert-price"))
        .insertPrice;
      actorId = await insertTestActor(db, "Envelope Tester");
    }, 120_000);

    afterAll(async () => {
      await closeProductDatabase(sql);
    }, 120_000);

    async function createDraft(name: string): Promise<string> {
      const rows = await sql<{ product_offering_id: string }[]>`
        INSERT INTO product.product_offering
          (name, is_bundle, is_sellable, billing_only, lifecycle_status)
        VALUES (${name}, false, true, true, 'DRAFT')
        RETURNING product_offering_id`;
      return rows[0]!.product_offering_id;
    }

    async function insert(
      offeringId: string,
      x: PersistablePricingComponent,
      start: Date = START,
    ): Promise<string> {
      const { productOfferingPriceId } = await db.transaction((tx) =>
        repo.insertPrice(tx, {
          productOfferingId: offeringId,
          ...writeDataOf(x, start),
        }),
      );
      return productOfferingPriceId;
    }

    async function cards(offeringId: string) {
      return repo.findByOfferingIdWithDerivedEnd(db, offeringId);
    }

    async function cardOf(offeringId: string, priceId: string) {
      const card = (await cards(offeringId)).find(
        (c) => c.productOfferingPriceId === priceId,
      );
      if (!card) throw new Error(`no card for ${priceId}`);
      return card;
    }

    async function countRows(table: string, priceId: string): Promise<number> {
      const [row] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM ${sql("product")}.${sql(table)}
         WHERE product_offering_price_id = ${priceId}`;
      return row!.n;
    }

    // I1.2
    it.each(FIXTURES)(
      "%s: insertPrice → findByOfferingIdWithDerivedEnd gives canonical(x)",
      async (_label, x) => {
        const offeringId = await createDraft(`rt ${_label}`);
        const id = await insert(offeringId, x);
        const card = await cardOf(offeringId, id);
        expect(card.component).toEqual(canonical(x));
        expect(card.componentType).toBe(x["@type"]);
      },
    );

    it('"100" reads back as "100", 1234567.123456 survives numeric(20,6), bands ascend as numbers', async () => {
      const offeringId = await createDraft("rt values");
      const flat = await insert(offeringId, FLAT_RECURRING);
      const commitment = await insert(offeringId, COMMITMENT);
      const motivation = await insert(offeringId, MOTIVATION_FIVE);
      const flatCard = await cardOf(offeringId, flat);
      expect(flatCard.component.params).toEqual({ amount: "100" });
      const cc = await cardOf(offeringId, commitment);
      expect(cc.component.params).toEqual({
        committedQuantity: 1234567.123456,
      });
      const cm = await cardOf(offeringId, motivation);
      const steps = (
        cm.component.params as { steps: Array<{ aboveQuantity: number }> }
      ).steps;
      expect(steps.map((s) => s.aboveQuantity)).toEqual([
        100, 200.5, 1000, 5000, 10000,
      ]);
      for (const s of steps) expect(typeof s.aboveQuantity).toBe("number");
    });

    it("money at the full numeric(18,6) cap round-trips exactly (no JSON-number loss)", async () => {
      const offeringId = await createDraft("rt cap");
      const big: PersistablePricingComponent = {
        ...FLAT_RECURRING,
        params: { amount: "999999999999.999999" },
      } as PersistablePricingComponent;
      const id = await insert(offeringId, big);
      expect((await cardOf(offeringId, id)).component.params).toEqual({
        amount: "999999999999.999999",
      });
    });

    // I1.3
    it("edit, same type: before/after equal the pre/post reads; one pop_usage_rate row", async () => {
      const offeringId = await createDraft("edit same type");
      const id = await insert(offeringId, USAGE_PLAIN);
      const pre = await cardOf(offeringId, id);
      const edited = {
        ...USAGE_PLAIN,
        params: { ratePerUnit: "7.250", rateCardLookUp: null },
      } as PersistablePricingComponent;
      const result = await db.transaction((tx) =>
        repo.updatePrice(tx, id, writeDataOf(edited), PASS),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || !("before" in result)) return;
      const post = await cardOf(offeringId, id);
      expect(result.before.component).toEqual(pre.component);
      expect(result.after.component).toEqual(post.component);
      expect(post.component.params).toEqual({
        ratePerUnit: "7.25",
        rateCardLookUp: null,
      });
      expect(await countRows("pop_usage_rate", id)).toBe(1);
    });

    // I1.4
    it("edit, type change usage_rate → flat_fee oneTime, in one transaction", async () => {
      const offeringId = await createDraft("edit type change");
      const id = await insert(offeringId, USAGE_PLAIN);
      const result = await db.transaction((tx) =>
        repo.updatePrice(tx, id, writeDataOf(FLAT_ONE_TIME), PASS),
      );
      expect(result.ok).toBe(true);
      expect(await countRows("pop_usage_rate", id)).toBe(0);
      expect(await countRows("pop_flat_fee", id)).toBe(1);
      const [header] = await sql<
        { component_type: string; price_type: string }[]
      >`SELECT component_type, price_type FROM product.product_offering_price
         WHERE product_offering_price_id = ${id}`;
      expect(header).toEqual({
        component_type: "flat_fee",
        price_type: "oneTime",
      });
      expect((await cardOf(offeringId, id)).component).toEqual(
        canonical(FLAT_ONE_TIME),
      );
    });

    // I1.5
    it("steps are replaced, not merged: five bands → three", async () => {
      const offeringId = await createDraft("steps replaced");
      const id = await insert(offeringId, MOTIVATION_FIVE);
      await db.transaction((tx) =>
        repo.updatePrice(tx, id, writeDataOf(MOTIVATION_THREE), PASS),
      );
      const rows = await sql<{ above_quantity: string }[]>`
        SELECT s.above_quantity::text AS above_quantity
          FROM product.pop_motivation_step s
         WHERE s.product_offering_price_id = ${id}
         ORDER BY s.above_quantity`;
      expect(rows.map((r) => r.above_quantity)).toEqual([
        "50.000000",
        "150.000000",
        "750.000000",
      ]);
    });

    // I1.6
    it("delete: before equals the card; no steps, no header remain", async () => {
      const offeringId = await createDraft("delete");
      const id = await insert(offeringId, MOTIVATION_FIVE);
      const card = await cardOf(offeringId, id);
      const result = await db.transaction((tx) =>
        repo.deletePrice(tx, id, PASS),
      );
      expect(result.ok).toBe(true);
      if (!result.ok || !("before" in result)) return;
      expect(result.before.component).toEqual(card.component);
      expect(await countRows("pop_motivation_step", id)).toBe(0);
      expect(await countRows("product_offering_price", id)).toBe(0);
    });

    // I1.7
    it("findByOfferingIdWithDerivedEnd is ONE statement for four prices of four types (§1.61)", async () => {
      const offeringId = await createDraft("one query");
      await insert(offeringId, USAGE_WITH_CARD);
      await insert(offeringId, FLAT_RECURRING);
      await insert(offeringId, COMMITMENT);
      await insert(offeringId, MOTIVATION_FIVE);
      const statements: string[] = [];
      const result = await repo.findByOfferingIdWithDerivedEnd(
        countingDb(sql, statements),
        offeringId,
      );
      expect(result).toHaveLength(4);
      expect(statements).toHaveLength(1);
    });

    // I1.8
    it("derived end is per column lane: a usage_rate successor ends only its lane; oneTime never ends recurring", async () => {
      const offeringId = await createDraft("derived end");
      const usage1 = await insert(offeringId, USAGE_WITH_CARD, START);
      const usage2 = await insert(offeringId, USAGE_WITH_CARD, LATER);
      const commitment = await insert(offeringId, COMMITMENT, START);
      const recurring = await insert(offeringId, FLAT_RECURRING, START);
      const oneTime = await insert(offeringId, FLAT_ONE_TIME, START);
      const byId = new Map(
        (await cards(offeringId)).map((c) => [c.productOfferingPriceId, c]),
      );
      expect(byId.get(usage1)!.endDateTime).toEqual(LATER);
      expect(byId.get(usage2)!.endDateTime).toBeNull();
      expect(byId.get(commitment)!.endDateTime).toBeNull();
      expect(byId.get(recurring)!.endDateTime).toBeNull();
      expect(byId.get(oneTime)!.endDateTime).toBeNull();
    });

    // I1.9 — Inv. #73, price half. ACTIVE is reached with the DRAFT → seed →
    // flip fixture ([[pm36-draft-guard-trigger-fixture-ripple]]), not through
    // submitForTesting: that service reads the specification repository, which
    // is pm72's and does not run inside the G-N5 window.
    it("branch copies every pop_* row under new ids; envelopes equal; source untouched", async () => {
      const sourceId = await createDraft("branch source");
      await insert(sourceId, USAGE_WITH_CARD);
      await insert(sourceId, FLAT_RECURRING);
      await insert(sourceId, COMMITMENT);
      await insert(sourceId, MOTIVATION_FIVE);
      await sql`UPDATE product.product_offering SET lifecycle_status = 'ACTIVE'
                 WHERE product_offering_id = ${sourceId}`;

      const snapshotSource = async () =>
        sql<{ t: string; r: string }[]>`
          SELECT 'h' AS t, h::text AS r FROM product.product_offering_price h
           WHERE h.product_offering_id = ${sourceId}
          UNION ALL SELECT 'u', c::text FROM product.pop_usage_rate c
            JOIN product.product_offering_price h USING (product_offering_price_id)
           WHERE h.product_offering_id = ${sourceId}
          UNION ALL SELECT 'f', c::text FROM product.pop_flat_fee c
            JOIN product.product_offering_price h USING (product_offering_price_id)
           WHERE h.product_offering_id = ${sourceId}
          UNION ALL SELECT 'c', c::text FROM product.pop_capacity_commitment c
            JOIN product.product_offering_price h USING (product_offering_price_id)
           WHERE h.product_offering_id = ${sourceId}
          UNION ALL SELECT 's', c::text FROM product.pop_motivation_step c
            JOIN product.product_offering_price h USING (product_offering_price_id)
           WHERE h.product_offering_id = ${sourceId}
          ORDER BY 1, 2`;
      const sourceBefore = await snapshotSource();
      const sourceCards = await cards(sourceId);

      const result = await insertPriceService(
        sourceId,
        {
          componentType: "flat_fee",
          priceType: "oneTime",
          name: "Forces a branch",
          currency: "USD",
          glCode: null,
          params: { amount: "1" },
          startDateTime: START,
        },
        actorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.branched).toBe(true);
      const branchId = result.offeringId;

      const branchCards = (await cards(branchId)).filter(
        (c) => c.productOfferingPriceId !== result.productOfferingPriceId,
      );
      const project = (cs: typeof sourceCards) =>
        cs.map((c) => ({
          name: c.name,
          componentType: c.componentType,
          component: c.component,
          unitOfMeasure: c.unitOfMeasure,
          startDateTime: c.startDateTime,
          createdAt: c.createdAt,
        }));
      expect(project(branchCards)).toEqual(project(sourceCards));
      for (const c of branchCards) {
        expect(sourceCards.map((s) => s.productOfferingPriceId)).not.toContain(
          c.productOfferingPriceId,
        );
      }

      const countUnder = async (table: string, offeringId: string) => {
        const [row] = await sql<{ n: number }[]>`
          SELECT count(*)::int AS n FROM ${sql("product")}.${sql(table)} c
            JOIN product.product_offering_price h USING (product_offering_price_id)
           WHERE h.product_offering_id = ${offeringId}`;
        return row!.n;
      };
      for (const table of [
        "pop_usage_rate",
        "pop_capacity_commitment",
        "pop_motivation_step",
      ]) {
        expect(await countUnder(table, branchId), table).toBe(
          await countUnder(table, sourceId),
        );
      }
      // The flat fee table also holds the price that forced the branch.
      expect(await countUnder("pop_flat_fee", branchId)).toBe(
        (await countUnder("pop_flat_fee", sourceId)) + 1,
      );

      expect(await snapshotSource()).toEqual(sourceBefore);
    });

    // I1.10 — §1.63.
    it('PRODUCT_PRICE_ADDED: "12.50" is "12.5" in the event and on the card; key order unchanged', async () => {
      const offeringId = await createDraft("audit");
      auditCalls.length = 0;
      const result = await insertPriceService(
        offeringId,
        {
          componentType: "flat_fee",
          priceType: "oneTime",
          name: "Audit fee",
          currency: "USD",
          glCode: null,
          params: { amount: "12.50" },
          startDateTime: START,
        },
        actorId,
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      const event = auditCalls.find(
        (e) => e.eventType === "PRODUCT_PRICE_ADDED",
      );
      const afterData = event!.afterData as Record<string, unknown> & {
        component: { params: { amount: string } };
      };
      expect(afterData.component.params.amount).toBe("12.5");
      const card = await cardOf(offeringId, result.productOfferingPriceId);
      expect(afterData.component).toEqual(card.component);
      // HEAD's order: `offeringId`, then `...priceData` in toPriceWriteData's
      // key order (its row columns spread as unit, period length, period
      // type), then `backdated`; `component` keeps its spread position.
      expect(Object.keys(afterData)).toEqual([
        "offeringId",
        "name",
        "componentType",
        "component",
        "currency",
        "glCode",
        "unitOfMeasure",
        "recurringChargePeriodLength",
        "recurringChargePeriodType",
        "startDateTime",
        "backdated",
      ]);

      const [stored] = await sql<{ amount: string }[]>`
        SELECT after_data -> 'component' -> 'params' ->> 'amount' AS amount
          FROM core.audit_log
         WHERE target_id = ${result.productOfferingPriceId}
           AND event_type = 'PRODUCT_PRICE_ADDED'`;
      expect(stored!.amount).toBe("12.5");
    });
  },
);
