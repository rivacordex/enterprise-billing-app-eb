import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { seedEventCatalog } from "@/db/seeds/rating-event-catalog.data";
import { getOrCreateAppUser } from "@/db/seeds/lib/get-or-create-appuser";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  productOffering,
  productOfferingPrice,
  productSpecifications,
  ratecardRanUsageLkp,
  ratecardVersion,
} from "@/db/schema/product";
import { orderItemPriceOverride } from "@/db/schema/ordering";
import { productInventory } from "@/db/schema/inventory";
import type {
  UsageRateComponent,
  FlatFeeComponent,
  CapacityMotivationComponent,
} from "@/validation/product/pricing-component.schema";
import { productSpecCharacteristicsSchema } from "@/validation/product/product-spec-characteristics.schema";
import {
  insertRanBillCycle,
  insertRanBillingAccount,
  insertRanCustomer,
  insertRanRatecard,
  insertRanSubscription,
  SAMPLE_5G_COMMERCIAL_UNIT,
  SAMPLE_5G_LKP_ROWS,
  SAMPLE_5G_START_DATE,
  type RanLkpRow,
} from "@/db/seeds/sample/sample-5g-fixture";
import {
  createRatingPipeline,
  dropModuleSchemas,
  pythonRuntimeReady,
  RATING_WORKER_DIR,
  ratingPython3,
  readManifest,
  runSqlFile,
  seedSample5gRatingGraph,
  type RatingPipeline,
  type UdrRow,
} from "@/tests/helpers/rating-ran-harness";

// rm08-spec §Verification checklist + code-standards §10 test #13 (OWNED by rm08):
//   #13 Price snapshot reproducibility — a record rated, then re-rated after the
//       underlying price row AND override changed, reproduces the ORIGINAL amount
//       from its snapshotted inputs, never by re-resolving.
// Plus as-of correctness (#2 pinned version, #3 [start,end) boundary), override
// (#4), currency (#5), PER_UNIT = rate × quantity + raw/rounded (#6, rm19),
// rounding modes (#7), no money.ts / Decimal (#8), snapshot columns populated
// (#9), version stamps (#10), LOOKUP_MISS (#11), rate-type derivation incl. the
// card-driven refusal (#12, rm19), one query per chunk (#13/#14).
//
// The static describe (no DATABASE_URL) checks the flow-YAML contract rm08 adds
// (the real rp task invoking runtime.rp, the outputs.prp.vars.uri -> outputs.rp.vars.uri
// handoff, the rounding_mode flow variable). The DB-gated describe shells out to
// the REAL `python3 -m runtime.prp` then `python3 -m runtime.rp` exactly as the
// flow's two tasks invoke them — a black-box test of the actual processors, not
// a TS reimplementation — through the shared `rating-ran-harness`: the
// production rm21 7-column `.udr` profile, the
// `rating-input-file-YYYYMMDDHHMI[_vN].udr` file-key rule, and offerings that
// carry the udrType/productCardLookUp specs + an ACTIVE ratecard. Since rm21 the
// subscriber is resolved by PRP (MNO -> party_role -> RAN_USAGE subscription ->
// product_inventory_id), one subscription per MNO, so each subscription below
// has its own MNO and ratecard cells; an unresolvable MNO is a PRP whole-batch
// hard-stop (UNKNOWN_SUBSCRIBER, rm07's suite), so RP's LOOKUP_MISS is driven by
// a resolvable subscriber whose record has no effective usage price. Requires the
// harness's absolute python3 (`RATING_PYTHON3` or the fixed system path) with
// the worker's requirements (psycopg + polars); skipped loudly, like the
// DATABASE_URL gate, when unavailable — same posture as the rm06/rm07 suites
// (see ratemgmt-progress-tracker.md: not run in a session without a live test
// Postgres + the worker deps).
const databaseUrl = process.env.DATABASE_URL;
const pythonReady = pythonRuntimeReady();

const ROLE_PW = "rm08-test-only-pw";
const RATING_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/rating-db-roles.sql",
);
const ENGINE_VERSION = "rm08-test-engine@sha256:deadbeef";
// A fixed reference instant so OUT_OF_RANGE never depends on wall-clock time.
const NOW = "2026-08-20T00:00:00Z";
const CURRENCY = "MYR";
const FLOW_REVISION = 42;

// rm17 shared golden parity fixtures — rm19 loads the SAME file the Zod
// udr-rate-detail schema test consumes, so RP's PER_UNIT emission cannot drift
// from the Zod contract (rm17 handoff note; checklist #4).
const UDR_RATE_DETAIL_GOLDEN = JSON.parse(
  readFileSync(
    join(process.cwd(), "tests", "fixtures", "udr-rate-detail-golden.json"),
    "utf8",
  ),
) as { valid: Record<string, string>[] };

// pm51-spec D6/I3 — component-envelope builder replacing the pre-reshape flat
// usage price-row literal (same shape `db/seeds/demo/product-demo.ts`'s
// `buildPriceEnvelope` builds in production).
function usageRateEnvelope(
  ratePerUnit: string,
  unitOfMeasure: "Mbps",
): UsageRateComponent {
  return {
    "@type": "usage_rate",
    specVersion: 1,
    plaSpecId: null,
    priceType: "usage",
    appliesAt: "rating",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { ratePerUnit, rateCardLookUp: null },
  };
}

// rm19 — a card-driven usage_rate: a non-null rateCardLookUp forces
// plaSpecId "PLA_USAGE_RATE" (pricing-component.schema.ts D4). RP has no
// rate-card resolution (Inv. #42), so this must raise CARD_DRIVEN_RATING_UNSUPPORTED.
function cardDrivenUsageRateEnvelope(
  ratePerUnit: string,
  unitOfMeasure: "Mbps",
  cardName: string,
): UsageRateComponent {
  return {
    "@type": "usage_rate",
    specVersion: 1,
    plaSpecId: "PLA_USAGE_RATE",
    priceType: "usage",
    appliesAt: "rating",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { ratePerUnit, rateCardLookUp: cardName },
  };
}

function flatFeeEnvelope(amount: string): FlatFeeComponent {
  return {
    "@type": "flat_fee",
    specVersion: 1,
    plaSpecId: null,
    priceType: "recurring",
    appliesAt: "billing",
    basis: "flat",
    boundTo: null,
    params: { amount },
  };
}

function capacityMotivationEnvelope(
  unitOfMeasure: "Mbps",
): CapacityMotivationComponent {
  return {
    "@type": "capacity_motivation",
    specVersion: 1,
    plaSpecId: "PLA_CAPACITY_MOTIVATION",
    priceType: "discount",
    appliesAt: "post_aggregation",
    basis: "quantity",
    boundTo: { unitOfMeasure },
    params: { steps: [{ aboveQuantity: 1000, ratePerUnit: "0.01" }] },
  };
}

function firstLine(lines: readonly string[]): string {
  const line = lines.at(0);
  if (line === undefined) throw new Error("expected at least one log line");
  return line;
}

// ---------------------------------------------------------------------
// Static structural checks — no DATABASE_URL, no engine. rm08 D1/D5/D7/D11.
// ---------------------------------------------------------------------
describe("rp flow wiring (rm08-spec D1/D5/D7/D11 — static)", () => {
  const template = readFileSync(
    join(
      process.cwd(),
      "workflow-management",
      "flows",
      "rating-engine",
      "rating-engine-ran-usage.yaml",
    ),
    "utf8",
  );

  it("the rp task invokes the real runtime.rp module and hands prp -> rp -> rl by file URI", () => {
    expect(template).toMatch(/python3 -m runtime\.rp/);
    expect(template).toMatch(/--manifest "\{\{ outputs\.prp\.vars\.uri \}\}"/);
    // rp emits its own URI, consumed by the rl stub.
    expect(template).toMatch(/outputs\.rp\.vars\.uri/);
    // The rp section is a module invocation, not inline python, and carries no
    // rate maths / DB insert (that is rl's, Inv #8).
    const rpBlock = template.slice(
      template.indexOf("id: rp"),
      template.indexOf("id: rl"),
    );
    expect(rpBlock).toMatch(/python3 -m runtime\.rp/);
    expect(rpBlock).not.toMatch(/python3 -c/);
    expect(rpBlock).not.toMatch(/INSERT INTO/i);
  });

  it("rm08's output-affecting config (rounding mode) lives in a flow variable; the subscriber ref column is a literal since rm21 (D7/D3, architecture §3)", () => {
    const vars = template.slice(
      template.indexOf("variables:"),
      template.indexOf("concurrency:"),
    );
    expect(vars).toMatch(/rounding_mode:\s*HALF_UP/);
    // rm21 §6 retired the `subscriber_ref_column` flow variable: PRP stamps the
    // real `product_inventory_id` onto each chunk row, so rp reads that column
    // verbatim and the flow passes it as a literal (rp.py still requires the arg).
    expect(vars).not.toMatch(/subscriber_ref_column:/);
    // The rp task passes the rounding mode through and the literal column.
    expect(template).toMatch(/--rounding-mode "\{\{ vars\.rounding_mode \}\}"/);
    expect(template).toMatch(/--subscriber-ref-column product_inventory_id/);
    // Version stamp (D10/Inv #12): rp carries the flow revision; the engine
    // version comes from the container env (RATING_ENGINE_VERSION, not templated).
    expect(template).toMatch(/--flow-revision "\{\{ flow\.revision \}\}"/);
  });

  it("the rl task consumes rp's URI, invokes runtime.rl, and documents supersession + non-PROCESSING no-op", () => {
    // Updated by rm09 (cross-unit-test precedent): rl is now the REAL loader, not
    // a stub. It still consumes outputs.rp.vars.uri and no-ops on a non-PROCESSING
    // status. Updated again by rm10 (same precedent): the supersede-hook inside
    // its transaction is now real too — the `# STUB: rm10` marker is gone.
    const rlBlock = template.slice(template.indexOf("id: rl"));
    expect(rlBlock).toMatch(/outputs\.rp\.vars\.uri/);
    expect(rlBlock).toMatch(/python3 -m runtime\.rl/);
    expect(rlBlock).not.toMatch(/# STUB: rm10/);
    expect(rlBlock).toMatch(/supersede/i);
    expect(rlBlock).toMatch(/non-PROCESSING/);
  });
});

// ---------------------------------------------------------------------
// Black-box resolve + snapshot + PER_UNIT — live DB + the real prp/rp modules.
// ---------------------------------------------------------------------
type PriceRow = Omit<
  typeof productOfferingPrice.$inferInsert,
  "productOfferingId" | "currency"
>;

// The three Sample-5G cells and the subscription MNOs this suite rates.
const [CELL_0, CELL_1, CELL_2] = SAMPLE_5G_LKP_ROWS as [
  RanLkpRow,
  RanLkpRow,
  RanLkpRow,
];
const MNO_A = "MNO-RM08-A"; // OFF1, no usage override
const MNO_B = "MNO-RM08-B"; // OFF1, with a usage override
const MNO_C = "MNO-RM08-C"; // OFF3 (flat_fee + capacity_motivation, no usage_rate)
const MNO_D = "MNO-RM08-D"; // OFF4 (usage_rate 100 — the PER_UNIT R1 canonical)
const MNO_E = "MNO-RM08-E"; // OFF5 (card-driven usage_rate)
const OFF1_NAME = "rm08-OFF1";
const OFF1_CARD = "RATECARD_RM08_OFF1";

describe.skipIf(!databaseUrl || !pythonReady)(
  "rp price resolution and snapshot (rm08-spec D1-D11, requires DATABASE_URL and python3+runtime)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    let actorId: string;

    // Fixture ids resolved at seed time (never hardcoded).
    let invA: string; // pinned to OFF1, no usage override
    let invB: string; // pinned to OFF1, with a usage override
    let off1Id: string;
    let priceP1Id: string; // OFF1 usage @ 2026-02-01, amount 0.0035
    let priceP2Id: string; // OFF1 usage @ 2026-08-01, amount 0.0050

    // One pipeline per pinned offering (PRP pins ONE subscription_product_name).
    let p1: RatingPipeline; // OFF1 — MNO A + MNO B
    let p3: RatingPipeline; // OFF3 — MNO C
    let p4: RatingPipeline; // OFF4 — MNO D
    let p5: RatingPipeline; // OFF5 — MNO E

    // A RAN_USAGE offering carrying the rm21 specs (udrType, single-sub,
    // productCardLookUp) and the given price rows: inserted DRAFT, priced, then
    // flipped to ACTIVE (pm36's DRAFT-guard trigger refuses a price write once
    // the parent offering leaves DRAFT — the same insert-then-activate pattern
    // the Sample-5G fixture builder uses).
    async function insertOffering(
      name: string,
      cardName: string,
      prices: readonly PriceRow[],
    ): Promise<{ offeringId: string; priceIds: string[] }> {
      const [offering] = await db
        .insert(productOffering)
        .values({
          name,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
          lifecycleStatus: "DRAFT",
          lastEditedBy: actorId,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      const offeringId = offering!.productOfferingId;
      const characteristics = productSpecCharacteristicsSchema.parse({});
      await db.insert(productSpecifications).values(
        [
          ["udrType", "RAN_USAGE", true],
          ["singleSubInstPerCust", "true", false],
          ["productCardLookUp", cardName, false],
        ].map(([specName, defaultValue, isDefault]) => ({
          refProductOfferingId: offeringId,
          name: specName as string,
          isMandatory: true,
          isDefault: isDefault as boolean,
          defaultValue: defaultValue as string,
          productSpecCharacteristics: characteristics,
        })),
      );
      const priceIds: string[] = [];
      for (const price of prices) {
        const [row] = await db
          .insert(productOfferingPrice)
          .values({
            ...price,
            productOfferingId: offeringId,
            currency: CURRENCY,
          })
          .returning({
            productOfferingPriceId: productOfferingPrice.productOfferingPriceId,
          });
        priceIds.push(row!.productOfferingPriceId);
      }
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "ACTIVE" })
        .where(eq(productOffering.productOfferingId, offeringId));
      return { offeringId, priceIds };
    }

    // A customer whose party_role carries `mno`, its MYR billing account and one
    // RAN_USAGE subscription pinned to `offeringId` (+ an optional usage
    // override on the order item), via the shared Sample-5G builders.
    async function insertSubscriber(
      tag: string,
      mno: string,
      offeringId: string,
      usageOverride: string | null = null,
    ): Promise<{ partyRoleId: string; inventoryId: string }> {
      const partyRoleId = await insertRanCustomer(db, {
        organizationName: `rm08-${tag}-org`,
        registrationNumber: `_SAMPLE_-RM08-${tag.toUpperCase()}`,
        partyRoleSpecification: { mnoPublicKey1: mno },
        actorId,
      });
      const billCycleId = await insertRanBillCycle(db, {
        name: `rm08-${tag}-cycle`,
        description: `rm08 ${tag} fixture bill cycle`,
        actorId,
      });
      const billingAccountId = await insertRanBillingAccount(db, {
        financialAccountName: `rm08-${tag}-fa`,
        billingAccountName: `rm08-${tag}-ban`,
        partyRoleId,
        billCycleId,
        actorId,
        currency: CURRENCY,
      });
      const inventoryId = await insertRanSubscription(db, {
        partyRoleId,
        billingAccountId,
        offeringId,
        actorId,
        reason: `rm08 ${tag} fixture`,
      });
      if (usageOverride !== null) {
        const [inv] = await db
          .select({ itemId: productInventory.productOrderItemId })
          .from(productInventory)
          .where(eq(productInventory.productInventoryId, inventoryId));
        await db.insert(orderItemPriceOverride).values({
          productOrderItemId: inv!.itemId,
          priceType: "usage",
          amount: usageOverride,
          currency: CURRENCY,
        });
      }
      return { partyRoleId, inventoryId };
    }

    // Adds `mno`'s cells (subscriber ref `partyRoleId`) to an existing ACTIVE
    // ratecard — a card may carry several MNOs' cells.
    async function addRatecardCells(
      cardName: string,
      mno: string,
      partyRoleId: string,
      cells: readonly RanLkpRow[],
    ): Promise<void> {
      const [version] = await db
        .select({ id: ratecardVersion.ratecardVersionId })
        .from(ratecardVersion)
        .where(eq(ratecardVersion.cardName, cardName));
      await db.insert(ratecardRanUsageLkp).values(
        cells.map((cell) => ({
          ratecardVersionId: version!.id,
          mnoPublicKey: mno,
          commercialUnitPublicKey: SAMPLE_5G_COMMERCIAL_UNIT,
          polygonId: cell.polygonId,
          polygonStartDate: SAMPLE_5G_START_DATE,
          polygonEndDate: null,
          lkpSubscriberRefId: partyRoleId,
          serviceCode: cell.serviceCode,
          ratePerUnit: null,
        })),
      );
      await sql`UPDATE product.ratecard_version SET row_count = row_count + ${cells.length}
                 WHERE ratecard_version_id = ${version!.id}`;
    }

    const pipeline = (
      tag: string,
      mno: string,
      productName: string,
      cells: readonly RanLkpRow[] = [CELL_0],
    ) =>
      createRatingPipeline({
        databaseUrl: databaseUrl as string,
        rolePassword: ROLE_PW,
        engineVersion: ENGINE_VERSION,
        mno,
        productName,
        now: NOW,
        tmpPrefix: `rm08-${tag}-`,
        cells,
        flowRevision: FLOW_REVISION,
      });

    // Build the product/ordering/inventory graph rm08 resolves against: two
    // subscriptions pinned to OFF1 (a DATED usage-price chain P1 -> P2), one of
    // them with a usage OVERRIDE, plus a decoy OFF2 (a different offering with a
    // very different usage price) to prove a record pinned to OFF1 never gets
    // OFF2's price (#2). Inserted as the superuser test connection; prp/rp read
    // them as rating_runtime.
    async function seedProductGraph(): Promise<void> {
      actorId = await getOrCreateAppUser(
        db,
        "rm08-fixture-user",
        "rm08-fixture@example.invalid",
      );

      // The PINNED offering (OFF1) with a two-row usage price chain. P1 starts
      // 2026-02-01 (one month after the subscriptions start), so a record dated
      // in January resolves its subscriber but no usage price — RP's
      // LOOKUP_MISS (D3).
      const off1 = await insertOffering(OFF1_NAME, OFF1_CARD, [
        {
          name: "OFF1 usage P1",
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope("0.0035", "Mbps"),
          unitOfMeasure: "Mbps",
          startDateTime: new Date("2026-02-01T00:00:00Z"),
        },
        {
          name: "OFF1 usage P2",
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope("0.0050", "Mbps"),
          unitOfMeasure: "Mbps",
          startDateTime: new Date("2026-08-01T00:00:00Z"),
        },
      ]);
      off1Id = off1.offeringId;
      [priceP1Id, priceP2Id] = off1.priceIds as [string, string];

      // A decoy offering (OFF2) with a very different usage price. The order
      // items are pinned to OFF1, so this must NEVER be resolved (#2).
      await insertOffering("rm08-OFF2", "RATECARD_RM08_OFF2", [
        {
          name: "OFF2 usage decoy",
          componentType: "usage_rate",
          priceComponent: usageRateEnvelope("9.9999", "Mbps"),
          unitOfMeasure: "Mbps",
          startDateTime: new Date("2026-01-01T00:00:00Z"),
        },
      ]);

      // pm51-spec D4/I3 — an offering with only a flat_fee + capacity
      // modifiers, no usage_rate at all. A usage record against it must
      // still LOOKUP_MISS: the old "unratable price" NULL-amount path is
      // gone (a usage_rate's ratePerUnit is NOT NULL by CHECK), so this
      // proves the miss now comes purely from the join finding no row.
      const { offeringId: off3Id } = await insertOffering(
        "rm08-OFF3",
        "RATECARD_RM08_OFF3",
        [
          {
            name: "OFF3 flat fee",
            componentType: "flat_fee",
            priceComponent: flatFeeEnvelope("10.00"),
            recurringChargePeriodLength: 1,
            recurringChargePeriodType: "months",
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
          {
            name: "OFF3 motivation",
            componentType: "capacity_motivation",
            priceComponent: capacityMotivationEnvelope("Mbps"),
            unitOfMeasure: "Mbps",
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      );

      // rm19 — OFF5: a card-driven usage_rate (rateCardLookUp set, plaSpecId
      // PLA_USAGE_RATE) RP must refuse with CARD_DRIVEN_RATING_UNSUPPORTED
      // (Inv. #42 — no rate-card resolution).
      const { offeringId: off5Id } = await insertOffering(
        "rm08-OFF5",
        "RATECARD_RM08_OFF5",
        [
          {
            name: "OFF5 card-driven usage",
            componentType: "usage_rate",
            priceComponent: cardDrivenUsageRateEnvelope(
              "5.00",
              "Mbps",
              "RAN_USAGE_CARD",
            ),
            unitOfMeasure: "Mbps",
            startDateTime: new Date("2026-01-01T00:00:00Z"),
          },
        ],
      );

      // Subscriptions: A/B pinned to OFF1 (no override / usage override); C
      // pinned to OFF3 (D4's no-usage_rate LOOKUP_MISS case); E pinned to OFF5
      // (card-driven refusal). The override table is numeric(12,2), so an
      // override is inherently 2 dp (unlike the sub-cent catalog amount). 0.07
      // is distinct from either catalog price (0.0035 / 0.0050), proving
      // COALESCE(override, catalog).
      const a = await insertSubscriber("a", MNO_A, off1Id);
      const b = await insertSubscriber("b", MNO_B, off1Id, "0.07");
      const c = await insertSubscriber("c", MNO_C, off3Id);
      const e = await insertSubscriber("e", MNO_E, off5Id);
      invA = a.inventoryId;
      invB = b.inventoryId;

      // OFF1's card: MNO A's three cells + MNO B's one (every cell must be in
      // the feed under HARD_STOP coverage, rm21 §5).
      await insertRanRatecard(db, {
        cardName: OFF1_CARD,
        mnoPublicKey: MNO_A,
        lkpSubscriberRefId: a.partyRoleId,
        rows: [CELL_0, CELL_1, CELL_2],
        actorId,
      });
      await addRatecardCells(OFF1_CARD, MNO_B, b.partyRoleId, [CELL_0]);
      for (const [card, mno, partyRoleId] of [
        ["RATECARD_RM08_OFF3", MNO_C, c.partyRoleId],
        ["RATECARD_RM08_OFF5", MNO_E, e.partyRoleId],
      ] as const) {
        await insertRanRatecard(db, {
          cardName: card,
          mnoPublicKey: mno,
          lkpSubscriberRefId: partyRoleId,
          rows: [CELL_0],
          actorId,
        });
      }

      // rm19 — OFF4: the Sample-5G graph, a plain scalar usage_rate at exactly
      // 100 (plaSpecId null), the PER_UNIT R1 canonical (100 × 20 = 2000).
      await seedSample5gRatingGraph(db, {
        tag: "rm08-d",
        mno: MNO_D,
        productName: "rm08-OFF4",
        priceName: "OFF4 usage @100",
        cardName: "RATECARD_RM08_OFF4",
        cells: [CELL_0],
      });

      p1 = pipeline("off1", MNO_A, OFF1_NAME);
      p3 = pipeline("off3", MNO_C, "rm08-OFF3");
      p4 = pipeline("off4", MNO_D, "rm08-OFF4");
      p5 = pipeline("off5", MNO_E, "rm08-OFF5");
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropModuleSchemas(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await seedEventCatalog(db);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await sql.unsafe(`ALTER ROLE rating_runtime WITH PASSWORD '${ROLE_PW}'`);
      await seedProductGraph();
    }, 60_000);

    afterAll(async () => {
      if (!sql) return;
      await dropModuleSchemas(sql);
      await sql.end();
    });

    // Reads a rated Parquet chunk back as rows of stringified values (safe JSON),
    // via the same python+polars the worker uses — not a TS parquet reader.
    function readParquetRows(fileUri: string): Record<string, string | null>[] {
      const out = execFileSync(
        ratingPython3(),
        [
          "-c",
          "import sys, json, polars as pl\n" +
            "df = pl.read_parquet(sys.argv[1])\n" +
            "print(json.dumps([{k:(str(v) if v is not None else None) for k,v in r.items()} for r in df.iter_rows(named=True)]))",
          fileURLToPath(fileUri),
        ],
        { cwd: RATING_WORKER_DIR, encoding: "utf8" },
      );
      return JSON.parse(out);
    }
    function ratedRows(
      manifest: Record<string, unknown>,
    ): Record<string, string | null>[] {
      return (manifest.rated_chunk_uris as string[]).flatMap((u) =>
        readParquetRows(u),
      );
    }

    function logLinesFor(
      p: RatingPipeline,
      component: string,
      execId: string,
    ): string[] {
      const path = join(p.dirs.logs, `${component}-${execId}.jsonl`);
      if (!existsSync(path)) return [];
      return readFileSync(path, "utf8")
        .split("\n")
        .filter((l) => l.trim().length > 0);
    }

    // The five-record OFF1 fixture. `.udr` datetimes are naive config-TZ
    // (Asia/Kuala_Lumpur, +08) instants; the UTC instant is in each comment.
    // Row order (PER_UNIT = rate × quantity, rm19):
    //   1 A/P2   0.0050 × 100 = 0.500000            (2026-08-14T10:00Z)
    //   2 A/P1   0.0035 ×   7 = 0.024500            (2026-03-01T00:00Z)
    //   3 A/boundary=P2 0.0050 × 1 = 0.005000       (2026-08-01T00:00Z, the
    //     rounding-mode discriminator)
    //   4 B/override    0.07   ×  55 = 3.850000     (2026-08-14T11:00Z)
    //   5 A/no price yet (before P1) -> LOOKUP_MISS (2026-01-15T00:00Z)
    // Rows 1/5 share A's cell 0 in different billing months (not a
    // DUPLICATE_IN_FILE); row 4 is MNO B's own cell 0.
    const FIXTURE_ROWS: readonly UdrRow[] = [
      { cell: CELL_0, datetime: "2026-08-14T18:00:00", volume: 100 },
      { cell: CELL_1, datetime: "2026-03-01T08:00:00", volume: 7 },
      { cell: CELL_2, datetime: "2026-08-01T08:00:00", volume: 1 },
      { cell: CELL_0, datetime: "2026-08-14T19:00:00", volume: 55, mno: MNO_B },
      { cell: CELL_0, datetime: "2026-01-15T08:00:00", volume: 9 },
    ];
    const MISS_START = "2026-01-15";

    // Rate the five-record fixture once and return the flattened rated rows +
    // the rp manifest, so multiple assertions share one run. `stamp` is the
    // file_key's YYYYMMDDHHMI (a fresh file_key per run).
    function rateFixture(
      stamp: string,
      roundingMode = "HALF_UP",
    ): {
      rows: Record<string, string | null>[];
      manifest: Record<string, unknown>;
      rpExecId: string;
    } {
      const path = p1.writeUdrRows(
        `rating-input-file-${stamp}.udr`,
        FIXTURE_ROWS,
      );
      const rpExecId = `rp-${stamp}`;
      const prpManifestUri = p1.runPrp(path, `prp-${stamp}`);
      const rpManifestUri = p1.runRp(prpManifestUri, rpExecId, roundingMode);
      const manifest = readManifest(rpManifestUri);
      return { rows: ratedRows(manifest), manifest, rpExecId };
    }
    const byKey = (
      rows: Record<string, string | null>[],
      inv: string,
      startsWith: string,
    ) =>
      rows.find(
        (r) =>
          r.udr_subscription_ref_id === inv &&
          (r.start_datetime ?? "").startsWith(startsWith),
      );

    // -----------------------------------------------------------------
    // As-of correctness (D1, D2): pinned version, [start,end) boundary, override.
    // -----------------------------------------------------------------
    it("2/4/6. resolves the pinned-version price as-of start_datetime, applies the override, multiplies quantity (PER_UNIT)", () => {
      const { rows, manifest } = rateFixture("202608140001");
      expect(manifest.status).toBe("PROCESSING");
      // 4 of 5 resolve; the record with no effective price is a LOOKUP_MISS.
      expect(manifest.rated_count).toBe(4);
      expect(manifest.lookup_miss_count).toBe(1);

      // Row 1 (A, 2026-08-14) -> P2 0.0050. PER_UNIT multiplies usage_volume=100:
      // the charge is rate × quantity = 0.0050 × 100 = 0.500000 (#6, rm19).
      const r1 = byKey(rows, invA, "2026-08-14");
      expect(r1?.udr_rate_type).toBe("PER_UNIT");
      expect(r1?.udr_usage_rate).toBe("0.005000");
      expect(r1?.udr_rated_price_raw).toBe("0.500000");
      expect(r1?.udr_rated_price).toBe("0.50"); // HALF_UP(0.50) = 0.50, NOT 0.01
      expect(r1?.udr_price_ref).toBe(priceP2Id);
      // The decoy OFF2 price (9.9999) is never resolved — the item is pinned to
      // OFF1 (#2).
      expect(r1?.udr_usage_rate).not.toBe("9.999900");

      // Row 2 (A, 2026-03-01) -> the OLD price P1 0.0035 (as-of resolution);
      // 0.0035 × 7 = 0.024500.
      const r2 = byKey(rows, invA, "2026-03-01");
      expect(r2?.udr_usage_rate).toBe("0.003500");
      expect(r2?.udr_rated_price_raw).toBe("0.024500");
      expect(r2?.udr_price_ref).toBe(priceP1Id);

      // Row 4 (B) -> the override 0.07, not the catalog amount (#4);
      // 0.07 × 55 = 3.850000.
      const r4 = byKey(rows, invB, "2026-08-14");
      expect(r4?.udr_usage_rate).toBe("0.070000");
      expect(r4?.udr_rated_price_raw).toBe("3.850000");
      expect(r4?.udr_rated_price).toBe("3.85");
      expect(r4?.udr_price_override_ref).not.toBeNull();
    }, 120_000);

    it("3. a record dead on a price boundary resolves to the NEW price ([start,end), matching isEffectiveNow)", () => {
      const { rows } = rateFixture("202608140002");
      // Row 3 is exactly 2026-08-01T00:00:00Z, P2's start_date_time -> P2 (new).
      const r3 = byKey(rows, invA, "2026-08-01");
      expect(r3?.udr_usage_rate).toBe("0.005000");
      expect(r3?.udr_price_ref).toBe(priceP2Id);
    }, 120_000);

    it("pm51-spec D5 — a capacity_motivation dated between two usage_rate rows changes nothing", async () => {
      // Insert a capacity_motivation on OFF1's same unit, dated between P1
      // (2026-02-01) and P2 (2026-08-01). If the window's PARTITION BY
      // omitted unit_of_measure, or a filter/partition gap let a
      // non-usage_rate row leak into the usage_rate lane, this could
      // truncate P1's eff_to or otherwise shift resolution — it must not.
      // OFF1 is already ACTIVE (pm36's DRAFT-guard trigger refuses a price
      // write against it), so this direct-SQL bypass flips it back to DRAFT
      // for the insert and immediately re-activates it — the same
      // "mutate the catalog directly to simulate a correction" pattern test
      // #13 below already uses.
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "DRAFT" })
        .where(eq(productOffering.productOfferingId, off1Id));
      await db.insert(productOfferingPrice).values({
        productOfferingId: off1Id,
        name: "OFF1 motivation (noise)",
        componentType: "capacity_motivation",
        priceComponent: capacityMotivationEnvelope("Mbps"),
        unitOfMeasure: "Mbps",
        currency: CURRENCY,
        startDateTime: new Date("2026-04-01T00:00:00Z"),
      });
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "ACTIVE" })
        .where(eq(productOffering.productOfferingId, off1Id));

      const { rows } = rateFixture("202608140003");
      // Same rows, same price refs as test "2/4/6" above — byte-identical.
      const r1 = byKey(rows, invA, "2026-08-14");
      expect(r1?.udr_usage_rate).toBe("0.005000");
      expect(r1?.udr_price_ref).toBe(priceP2Id);
      const r2 = byKey(rows, invA, "2026-03-01");
      expect(r2?.udr_usage_rate).toBe("0.003500");
      expect(r2?.udr_price_ref).toBe(priceP1Id);
    }, 120_000);

    it("5. udr_currency comes from the resolved price row", () => {
      const { rows } = rateFixture("202608140004");
      expect(rows.length).toBeGreaterThan(0); // guard against a vacuous pass on []
      for (const r of rows) expect(r.udr_currency).toBe(CURRENCY);
    }, 120_000);

    // -----------------------------------------------------------------
    // Money + rounding (D5, D7, D8).
    // -----------------------------------------------------------------
    it("6/8. stores BOTH raw (18,6) and rounded (18,2); a sub-cent amount survives in _raw and rounds correctly", () => {
      const { rows } = rateFixture("202608140005");
      const r2 = byKey(rows, invA, "2026-03-01"); // 0.0035 × 7 = 0.024500
      // The sub-cent product survives in _raw at full precision (numeric(18,6))
      // and rounds once to numeric(18,2): HALF_UP(0.024500) = 0.02.
      expect(r2?.udr_rated_price_raw).toBe("0.024500");
      expect(r2?.udr_rated_price).toBe("0.02");
      // No float artifacts — exact decimal strings throughout (#8/#14).
      expect(rows.length).toBeGreaterThan(0); // guard against a vacuous pass on []
      for (const r of rows) {
        expect(r.udr_rated_price_raw).toMatch(/^\d+\.\d+$/);
        expect(r.udr_rated_price).toMatch(/^\d+\.\d{2}$/);
        expect(r.udr_rounding_mode).toBe("HALF_UP");
      }
    }, 120_000);

    it("7. the per-record rounding method is applied once from the raw (HALF_UP vs HALF_EVEN vs TRUNCATE)", () => {
      // Row 3 is P2 0.0050 × 1 = 0.005000; three modes from the SAME raw:
      // HALF_UP -> 0.01, HALF_EVEN -> 0.00 (round to even), TRUNCATE -> 0.00.
      const up = byKey(
        rateFixture("202608140006", "HALF_UP").rows,
        invA,
        "2026-08-01",
      );
      const even = byKey(
        rateFixture("202608140007", "HALF_EVEN").rows,
        invA,
        "2026-08-01",
      );
      const trunc = byKey(
        rateFixture("202608140008", "TRUNCATE").rows,
        invA,
        "2026-08-01",
      );
      expect(up?.udr_rated_price).toBe("0.01");
      expect(up?.udr_rounding_mode).toBe("HALF_UP");
      expect(even?.udr_rated_price).toBe("0.00");
      expect(even?.udr_rounding_mode).toBe("HALF_EVEN");
      expect(trunc?.udr_rated_price).toBe("0.00");
      expect(trunc?.udr_rounding_mode).toBe("TRUNCATE");
      // Raw is identical and unrounded across all three (numeric(18,6)).
      expect(up?.udr_rated_price_raw).toBe("0.005000");
      expect(even?.udr_rated_price_raw).toBe("0.005000");
      expect(trunc?.udr_rated_price_raw).toBe("0.005000");
    }, 120_000);

    // -----------------------------------------------------------------
    // Snapshot, stamps, scope (D4, D6, D10, D5).
    // -----------------------------------------------------------------
    it("6/9/10/12. every rated row carries the full snapshot, the version stamps, the product unit, and a PER_UNIT rate detail", () => {
      const { rows } = rateFixture("202608140009");
      expect(rows.length).toBeGreaterThan(0); // guard against a vacuous pass on []
      for (const r of rows) {
        // Snapshot columns (D4) populated on every rated row (#9).
        expect(r.udr_usage_rate).not.toBeNull();
        expect(r.udr_price_ref).not.toBeNull();
        expect(r.udr_price_effective_date).not.toBeNull();
        expect(r.udr_rounding_mode).not.toBeNull();
        // Version stamps (D10/Inv #12) (#10).
        expect(r.rating_engine_version).toBe(ENGINE_VERSION);
        expect(r.rating_flow_revision).toBe(String(FLOW_REVISION));
        expect(r.rated_datetime).not.toBeNull();
        // rm19 §6 — udr_usage_unit is the product's catalog unit ("Mbps"); the
        // rm21 feed carries no unit at all.
        expect(r.udr_usage_unit).toBe("Mbps");
        // Rate-type derivation (#12, rm19): every fixture row is a plain-scalar
        // usage_rate -> PER_UNIT; the detail carries exactly the four PER_UNIT
        // keys and its ratePerUnit/quantity/amountRaw echo the sibling columns.
        expect(r.udr_rate_type).toBe("PER_UNIT");
        const detail = JSON.parse(r.udr_rate_detail as string);
        expect(Object.keys(detail).sort()).toEqual([
          "amountRaw",
          "quantity",
          "ratePerUnit",
          "rateType",
        ]);
        expect(detail.rateType).toBe("PER_UNIT");
        expect(detail.ratePerUnit).toBe(r.udr_usage_rate);
        expect(detail.quantity).toBe(r.udr_usage_quantity);
        expect(detail.amountRaw).toBe(r.udr_rated_price_raw);
      }
    }, 120_000);

    // -----------------------------------------------------------------
    // LOOKUP_MISS (D3) — one summarised line, record not rated.
    // -----------------------------------------------------------------
    it("11. a record whose subscriber resolves but whose price does not (before the lane's first effective price) raises LOOKUP_MISS (one summarised line) and is not rated", () => {
      const { rows, manifest, rpExecId } = rateFixture("202608140010");
      // The unpriced record is absent from the rated output (not fabricated).
      expect(
        rows.some((r) => (r.start_datetime ?? "").startsWith(MISS_START)),
      ).toBe(false);
      expect(manifest.lookup_miss_count).toBe(1);
      // Exactly ONE summarised process_log line for the miss (Inv #11), not one
      // per missed record.
      const lines = logLinesFor(p1, "RP", rpExecId);
      expect(lines).toHaveLength(1);
      const parsed = JSON.parse(firstLine(lines));
      expect(parsed.event_code).toBe("LOOKUP_MISS");
      expect(parsed.component).toBe("RP");
      // Severity is left for the sweep to resolve from event_catalog (§7.2a).
      expect(parsed.perceived_severity).toBeNull();
    }, 120_000);

    it("pm51-spec D4 — an offering with only a flat_fee + capacity modifiers (no usage_rate) yields LOOKUP_MISS", () => {
      const path = p3.writeUdr("rating-input-file-202608290000.udr", [42]);
      const prpManifestUri = p3.runPrp(path, "prp-nousagerate");
      const rpExecId = "rp-nousagerate";
      const rpManifestUri = p3.runRp(prpManifestUri, rpExecId);
      const manifest = readManifest(rpManifestUri);
      expect(manifest.rated_count).toBe(0);
      expect(manifest.lookup_miss_count).toBe(1);
      // One summarised process_log line (Inv #11), same shape as the other
      // LOOKUP_MISS cause above.
      const lines = logLinesFor(p3, "RP", rpExecId);
      expect(lines).toHaveLength(1);
      expect(JSON.parse(firstLine(lines)).event_code).toBe("LOOKUP_MISS");
    }, 120_000);

    // Rewrites P2's ratePerUnit in place, with OFF1 flipped to DRAFT for the
    // write (pm36's DRAFT-guard) and re-activated straight after.
    async function setOff1RatePerUnit(rate: string): Promise<void> {
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "DRAFT" })
        .where(eq(productOffering.productOfferingId, off1Id));
      await sql`UPDATE product.product_offering_price SET price_component = jsonb_set(price_component, '{params,ratePerUnit}', to_jsonb(${rate}::text)) WHERE product_offering_price_id = ${priceP2Id}`;
      await db
        .update(productOffering)
        .set({ lifecycleStatus: "ACTIVE" })
        .where(eq(productOffering.productOfferingId, off1Id));
    }

    // -----------------------------------------------------------------
    // #13 — price snapshot reproducibility (the headline).
    // -----------------------------------------------------------------
    it("13. re-rating after the catalog price AND the override change reproduces the original amount from the snapshot", async () => {
      const { rows } = rateFixture("202608140011");
      const r1 = byKey(rows, invA, "2026-08-14");
      const r4 = byKey(rows, invB, "2026-08-14");
      const originalRate1 = r1?.udr_usage_rate;
      const originalPrice1 = r1?.udr_rated_price;
      const originalRate4 = r4?.udr_usage_rate;

      // Change the underlying catalog price row AND the override — exactly the
      // mutation #13 guards against. (product_offering_price is insert-only in
      // the app, but the test mutates it directly to simulate the passage of
      // time / a catalog correction.) pm51-spec D6 — the envelope's
      // `params.ratePerUnit` replaces the dropped `amount` column. OFF1 is
      // ACTIVE, so pm36's DRAFT-guard trigger refuses the price write unless
      // OFF1 is flipped back to DRAFT around it (the D5 test's bypass).
      await setOff1RatePerUnit("0.9999");
      await sql`UPDATE ordering.order_item_price_override SET amount = '0.55' WHERE price_type = 'usage'`;

      // The already-rated row's snapshotted inputs are unchanged, and the amount
      // reproduces from them (PER_UNIT: round(udr_usage_rate × udr_usage_quantity)
      // == udr_rated_price) WITHOUT re-resolving against the now-changed catalog.
      expect(originalRate1).toBe("0.005000"); // NOT the new 0.999900
      expect(originalPrice1).toBe("0.50"); // 0.0050 × 100, HALF_UP
      expect(originalRate4).toBe("0.070000"); // NOT the new 0.55

      // Re-running rp now (a re-resolve) would pick up the changed catalog — this
      // is why the snapshot is mandatory (D4): the DURABLE snapshot on the row,
      // read back by RL, is what reproduces the charge, never a re-resolution.
      const { rows: reResolved } = rateFixture("202608140012");
      const again = byKey(reResolved, invA, "2026-08-14");
      expect(again?.udr_usage_rate).toBe("0.999900"); // proves a re-resolve DIVERGES
      // ...so the snapshot (0.005000), not the re-resolve (0.999900), is the record
      // of truth for the original charge.

      // Restore for any later assertions in this file.
      await setOff1RatePerUnit("0.0050");
      await sql`UPDATE ordering.order_item_price_override SET amount = '0.07' WHERE price_type = 'usage'`;
    }, 120_000);

    // -----------------------------------------------------------------
    // rm19 — PER_UNIT R1 canonical + the card-driven refusal.
    // -----------------------------------------------------------------
    it("R1 (rm19 §7) — PER_UNIT: ratePerUnit 100 × volume 20 = 2000, detail mirrors the Zod golden fixture, unit from the product", () => {
      const path = p4.writeUdr("rating-input-file-202609020000.udr", [20]);
      const prpManifestUri = p4.runPrp(path, "prp-perunit-r1");
      const rpManifestUri = p4.runRp(prpManifestUri, "rp-perunit-r1");
      const manifest = readManifest(rpManifestUri);
      expect(manifest.rated_count).toBe(1);
      const r = ratedRows(manifest).at(0);
      expect(r?.udr_rate_type).toBe("PER_UNIT");
      expect(r?.udr_rated_price_raw).toBe("2000.000000");
      expect(r?.udr_rated_price).toBe("2000.00");
      expect(r?.udr_usage_unit).toBe("Mbps"); // the product's unit
      const expectedDetail = {
        rateType: "PER_UNIT",
        ratePerUnit: "100.000000",
        quantity: "20",
        amountRaw: "2000.000000",
      };
      expect(JSON.parse(r?.udr_rate_detail as string)).toEqual(expectedDetail);
      // Python-vs-Zod parity (#4): RP emits exactly a value the SHARED golden
      // fixture (the rm17 Zod schema test's own data) declares valid.
      expect(UDR_RATE_DETAIL_GOLDEN.valid).toContainEqual(expectedDetail);
    }, 120_000);

    it("rm19 — a card-driven usage_rate (plaSpecId=PLA_USAGE_RATE) fails loudly with CARD_DRIVEN_RATING_UNSUPPORTED and rates no row", () => {
      const path = p5.writeUdr("rating-input-file-202609030000.udr", [10]);
      const prpManifestUri = p5.runPrp(path, "prp-carddriven");
      // RP must refuse (no rate-card resolution, Inv. #42): a non-zero exit with
      // the rm18 event code, no rated manifest, no rated chunk.
      let stderr = "";
      let threw = false;
      try {
        p5.runRp(prpManifestUri, "rp-carddriven");
      } catch (err) {
        threw = true;
        const e = err as { stderr?: string; message?: string };
        stderr = String(e.stderr ?? e.message ?? "");
      }
      expect(threw).toBe(true);
      expect(stderr).toContain("CARD_DRIVEN_RATING_UNSUPPORTED");
      // #6 (rm19) — the failure is also emitted as ONE structured process_log line
      // (rm18 event code, component RP) so the sweep raises it as an alarm, not just
      // a stderr print. Same shape as the LOOKUP_MISS line asserted above.
      const lines = logLinesFor(p5, "RP", "rp-carddriven");
      expect(lines).toHaveLength(1);
      expect(JSON.parse(firstLine(lines)).event_code).toBe(
        "CARD_DRIVEN_RATING_UNSUPPORTED",
      );
    }, 120_000);

    // -----------------------------------------------------------------
    // Forward contract — a non-PROCESSING PRP manifest is a no-op (rm07/rm08).
    // -----------------------------------------------------------------
    it("rp no-ops on a non-PROCESSING PRP manifest (a DISCARDED redelivery), passing the status through", () => {
      // A byte-identical redelivery of an already-claimed file -> DUPLICATE_BATCH,
      // PRP emits a DISCARDED manifest.
      p4.runPrp(
        p4.writeUdr("rating-input-file-202608300000.udr", [100]), // run 1 claims it
        "prp-dup-1",
      );
      // Redeliver the exact bytes under a varied name -> DUPLICATE_BATCH.
      const dupPath = p4.writeUdr(
        "rating-input-file-202608300000_v9.udr",
        [100],
      );
      const dupManifestUri = p4.runPrp(dupPath, "prp-dup-2");
      expect(readManifest(dupManifestUri).status).toBe("DISCARDED");
      // rp consumes it and no-ops: status passthrough, no rated chunks, exit 0.
      const rpManifestUri = p4.runRp(dupManifestUri, "rp-dup");
      const rpManifest = readManifest(rpManifestUri);
      expect(rpManifest.status).toBe("DISCARDED");
      expect(rpManifest.rated_count).toBe(0);
      expect(rpManifest.rated_chunk_uris).toEqual([]);
    }, 120_000);
  },
);
