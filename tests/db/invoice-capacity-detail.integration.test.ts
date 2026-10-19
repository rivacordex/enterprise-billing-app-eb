import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import type postgresjs from "postgres";

import type * as schema from "@/db/schema";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { runAggregation } from "@/tests/db/helpers/extract-flow-sql";
import {
  bootstrapFlowDoubleDatabase,
  createFlowDoubleFixtures,
  dropFlowDoubleSchemas,
} from "@/tests/db/helpers/billrun-flow-double-fixtures";
import {
  createCapacityPolygonFixtures,
  polygonResource as resource,
} from "@/tests/db/helpers/capacity-polygon-fixtures";
import {
  invoiceRenderInputRepository,
  type RawInvoiceRenderInput,
} from "@/db/repositories/billing/invoice-render-input";
import { bind } from "@/services/billing/invoice-template/bind";
import {
  INVOICE_USAGE_ROW_LIMIT,
  InvoiceRenderError,
  type InvoiceRenderInput,
} from "@/types/billing";
import {
  SEEDED_FOOTNOTE,
  SEEDED_TEMPLATE_STAMP,
} from "@/tests/helpers/seeded-invoice-template";

// bm71-spec §6 — guardrail item 63 [CRITICAL] (Inv #56): the per-polygon,
// per-type capacity detail read (`ratedLinesRepository
// .listCapacityDetailForInvoice`, through `invoiceRenderInputRepository.read`)
// and the binder's four detail guards, on bills built by the extracted
// `bill_run_processing` aggregation SQL. The `udr_rated` rows are
// rating-shaped (rating Phase H): the rm26 raw `udr_key` (`name=value` joined
// by `|`, value untouched) and the rm25 `udr_resource`
// (`state|district|YYYY-MM-DD`). Cases:
//   1. one row per polygon per type; the same polygon under two types;
//   2. D21 ordering and labels (STATE - DISTRICT / one part / "Unassigned
//      region", sorted last);
//   3. scope: BILL_NOTUSED excluded; a rerun attempt reads only its own rows;
//   4. 10,001 rows → INVOICE_USAGE_OVER_LIMIT;
//   5. a tampered `udr_rated_price` → INVOICE_RECONCILIATION_FAILED;
//   6. no `polygon_id=` segment, a NULL or a malformed `udr_resource` →
//      INVOICE_POLYGON_DATA_MISSING, on both draft and final.
//
// Superuser DATABASE_URL connection (the bm42 flow-double precedent): this
// exercises the read logic, not the runtime grants.
const databaseUrl = process.env.DATABASE_URL;

const TZ = "Asia/Kuala_Lumpur";
const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";

const DRAFT_CTX = {
  isDraft: true,
  locale: "en-MY",
  timezone: TZ,
  template: SEEDED_TEMPLATE_STAMP,
  profile: null,
  footnote: [...SEEDED_FOOTNOTE],
};

describe.skipIf(!databaseUrl)(
  "bm71 invoice capacity detail (guardrail 63, requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let actorId: string;
    let cycleId: string;

    function fixtures() {
      return createFlowDoubleFixtures({
        sql,
        db,
        getActorId: () => actorId,
        getCycleId: () => cycleId,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        labelPrefix: "BM71",
      });
    }

    // One BAN per call on its own fixture run (the shared builder, also used
    // by the Phase 3 journey's ~900-polygon BAN).
    const {
      capacityBill,
      capacityFixtures,
      offeringOpts: OFFERING_OPTS,
    } = createCapacityPolygonFixtures({
      getSql: () => sql,
      getDb: () => db,
      flowDouble: fixtures,
      labelPrefix: "BM71",
      claimAt: IN_WINDOW,
      periodStart: PERIOD_START,
      periodEnd: PERIOD_END,
      glEventAt: GL_EVENT_AT,
    });

    async function read(
      runId: string,
      ban: string,
    ): Promise<RawInvoiceRenderInput> {
      const raw = await invoiceRenderInputRepository.read(db, {
        runId,
        banId: ban,
      });
      expect(raw).not.toBeNull();
      return raw!;
    }

    function bindDraft(raw: RawInvoiceRenderInput): InvoiceRenderInput {
      return bind(raw, DRAFT_CTX);
    }

    // The final bind of the same bill: the posted document is the only
    // difference the binder sees.
    function bindFinal(raw: RawInvoiceRenderInput): InvoiceRenderInput {
      return bind(
        {
          ...raw,
          document: {
            documentId: "INV00007100",
            postingDate: new Date("2026-07-01T00:00:00Z"),
          },
        },
        { ...DRAFT_CTX, isDraft: false, invoiceNo: "INV00007100" },
      );
    }

    function renderError(fn: () => unknown): InvoiceRenderError {
      let caught: unknown;
      try {
        fn();
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvoiceRenderError);
      return caught as InvoiceRenderError;
    }

    const flat = (bound: InvoiceRenderInput, typeIndex: number) =>
      bound.serviceTypes[typeIndex]!.regions.flatMap((r) =>
        r.rows.map((row) => [r.label, row.polygonName]),
      );

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      ({ db, actorId, cycleId } = await bootstrapFlowDoubleDatabase(
        sql,
        "BM71",
      ));
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropFlowDoubleSchemas(sql);
        await sql.end();
      }
    }, 60_000);

    it("1 — one row per polygon per type, and the same polygon under two types appears under both", async () => {
      const r = resource("Selangor", "Petaling");
      const { runId, ban } = await capacityBill("ROWS", {
        "Alpha Capacity": [
          { polygonId: "PCU-001", udrResource: r, ea: 10 },
          { polygonId: "PCU-002", udrResource: r, ea: 20 },
        ],
        "Beta Capacity": [{ polygonId: "PCU-001", udrResource: r, ea: 5 }],
      });
      const bound = bindDraft(await read(runId, ban));

      expect(bound.serviceTypes.map((t) => t.label)).toEqual([
        "Alpha Capacity",
        "Beta Capacity",
      ]);
      expect(flat(bound, 0)).toEqual([
        ["Selangor - Petaling", "PCU-001"],
        ["Selangor - Petaling", "PCU-002"],
      ]);
      expect(flat(bound, 1)).toEqual([["Selangor - Petaling", "PCU-001"]]);
      expect(bound.serviceTypes[0]!.regions[0]).toEqual({
        label: "Selangor - Petaling",
        subTotal: "3000.00",
        rows: [
          {
            polygonStartDate: "2025-03-01",
            polygonName: "PCU-001",
            capacityMbps: "10.000000",
            ratePerMbps: "100.00",
            amount: "1000.00",
          },
          {
            polygonStartDate: "2025-03-01",
            polygonName: "PCU-002",
            capacityMbps: "20.000000",
            ratePerMbps: "100.00",
            amount: "2000.00",
          },
        ],
      });
      expect(bound.serviceTypes[1]!.regions[0]!.subTotal).toBe("500.00");
    }, 120_000);

    // bm72 — guardrail 62's remaining half (D30, D43): on the 2,000 Mbps
    // anchor the last page's Total Amount (Σ Utilised, after the motivation
    // discount) is 150000.00 while the detail Sub Totals (raw Mbps × base
    // rate) sum to 200000.00. The difference is asserted, not reconciled.
    it("1 — the 2,000 Mbps anchor: Total Amount 150000.00, detail Sub Totals 200000.00", async () => {
      const r = resource("Selangor", "Petaling");
      const { runId, ban } = await capacityBill("TOTAL2000", {
        "Anchor Capacity": [
          { polygonId: "PCU-A01", udrResource: r, ea: 1200 },
          { polygonId: "PCU-A02", udrResource: r, ea: 800 },
        ],
      });
      const raw = await read(runId, ban);
      const bound = bindDraft(raw);

      expect(raw.bill.utilisedTotal).toBe("150000.00");
      expect(bound.totals.totalAmount).toBe("150000.00");
      expect(bound.serviceTypes[0]!.regions.map((g) => g.subTotal)).toEqual([
        "200000.00",
      ]);
      expect(bound.totals.totalAmount).not.toBe(
        bound.serviceTypes[0]!.regions[0]!.subTotal,
      );
    }, 120_000);

    it("2 — D21 order and labels: STATE - DISTRICT, one part, Unassigned region last; polygons by id", async () => {
      const { runId, ban } = await capacityBill("ORDER", {
        "Gamma Capacity": [
          { polygonId: "PCU-Z9", udrResource: resource(null, null), ea: 1 },
          {
            polygonId: "PCU-B2",
            udrResource: resource("Wilayah", "Putrajaya"),
            ea: 1,
          },
          {
            polygonId: "PCU-B1",
            udrResource: resource("Wilayah", "Putrajaya"),
            ea: 1,
          },
          {
            polygonId: "PCU-C1",
            udrResource: resource(null, "Petaling"),
            ea: 1,
          },
          { polygonId: "PCU-A1", udrResource: resource("Johor", null), ea: 1 },
        ],
      });
      const bound = bindDraft(await read(runId, ban));

      expect(flat(bound, 0)).toEqual([
        ["Johor", "PCU-A1"],
        ["Petaling", "PCU-C1"],
        ["Wilayah - Putrajaya", "PCU-B1"],
        ["Wilayah - Putrajaya", "PCU-B2"],
        ["Unassigned region", "PCU-Z9"],
      ]);
      expect(
        bound.serviceTypes[0]!.regions.map((r) => [r.label, r.subTotal]),
      ).toEqual([
        ["Johor", "100.00"],
        ["Petaling", "100.00"],
        ["Wilayah - Putrajaya", "200.00"],
        ["Unassigned region", "100.00"],
      ]);
    }, 120_000);

    it("3 — BILL_NOTUSED rows are excluded, and a rerun attempt reads only its own rows", async () => {
      const r = resource("Selangor", "Petaling");
      const { runId, ban } = await capacityBill(
        "SCOPE",
        {
          "Delta Capacity": [
            { polygonId: "PCU-LIVE", udrResource: r, ea: 10, attempt: 2 },
            {
              polygonId: "PCU-NOTUSED",
              udrResource: r,
              ea: 7,
              attempt: 2,
              status: "BILL_NOTUSED",
            },
            { polygonId: "PCU-STALE", udrResource: r, ea: 3, attempt: 1 },
          ],
        },
        2,
      );
      const raw = await read(runId, ban);
      const bound = bindDraft(raw);

      expect(flat(bound, 0)).toEqual([["Selangor - Petaling", "PCU-LIVE"]]);
      // The detail reconciles to the attempt-2 capacity line (D37).
      expect(raw.serviceTypes[0]!.ratedTotal).toBe("1000.00");
      expect(bound.serviceTypes[0]!.regions[0]!.subTotal).toBe("1000.00");
    }, 120_000);

    it("3 — a type with a capacity line but no claimed row prints no regions", async () => {
      const { runId, ban } = await capacityBill("ZERO", {
        "Epsilon Capacity": [],
      });
      const bound = bindDraft(await read(runId, ban));
      expect(bound.serviceTypes).toHaveLength(1);
      expect(bound.serviceTypes[0]!.unutilised).toBe("100000.00");
      expect(bound.serviceTypes[0]!.regions).toEqual([]);
    }, 120_000);

    it(`4 — ${INVOICE_USAGE_ROW_LIMIT + 1} rows fail INVOICE_USAGE_OVER_LIMIT with the BAN and the row count`, async () => {
      const { ban, offeringId, usageRatePriceId, runId, piId } =
        await capacityFixtures.setupSingleAccountCapacity(
          "OVER",
          "Zeta Capacity",
          OFFERING_OPTS,
        );
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_resource, udr_usage_quantity,
           udr_usage_unit, udr_rate_type, udr_usage_rate, udr_price_ref,
           udr_rated_price, udr_rated_price_raw, udr_rounding_mode, udr_currency,
           udr_ref_batch_id, udr_source_file, rating_engine_version,
           rating_flow_revision, billrun_ref_id, billrun_ban_id, billrun_attempt,
           billrun_checksum, upsert_datetime)
        SELECT
          rating.period_of(${IN_WINDOW}::timestamptz), 'RAN_USAGE',
          ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'BILL_DRAFT',
          ${piId},
          'commercial_unit=CU-BM71-OVER|mno_public_id=MNO-BM71|polygon_id=PCU-' || g.i,
          'Selangor|Petaling|2025-03-01', '1.000000', 'EA', 'PER_UNIT',
          '100.000000', ${usageRatePriceId}, '100.00', '100.00', 'HALF_UP',
          'MYR', '_BM71_BATCH', '_BM71', '_BM71', 0, ${runId}, ${ban}, 1,
          'bm71-claim', now()
        FROM generate_series(1, ${INVOICE_USAGE_ROW_LIMIT + 1}) AS g(i)`;
      await runAggregation(sql, {
        runId,
        ban,
        attempt: 1,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
      await db.insert(billRunAccount).values({
        refBillRunId: runId,
        refBillingAccountId: ban,
        periodPartition: PERIOD_START,
        status: "PROCESSED",
        attemptCount: 1,
      });
      const raw = await read(runId, ban);
      expect(raw.serviceTypes.map((t) => t.offeringId)).toEqual([offeringId]);
      expect(raw.capacityDetail).toEqual({
        overLimit: true,
        rowCount: INVOICE_USAGE_ROW_LIMIT + 1,
      });
      const err = renderError(() => bindDraft(raw));
      expect(err.code).toBe("INVOICE_USAGE_OVER_LIMIT");
      expect(err.detail).toEqual({
        banId: ban,
        rowCount: INVOICE_USAGE_ROW_LIMIT + 1,
      });
    }, 300_000);

    it("5 — a tampered udr_rated_price fails INVOICE_RECONCILIATION_FAILED (DETAIL_DOES_NOT_MATCH_RATED_AMOUNT)", async () => {
      const r = resource("Selangor", "Petaling");
      const { runId, ban, offerings } = await capacityBill("TAMPER", {
        "Eta Capacity": [
          { polygonId: "PCU-T1", udrResource: r, ea: 10 },
          { polygonId: "PCU-T2", udrResource: r, ea: 10 },
        ],
      });
      // The untampered bill reconciles…
      const raw0 = await read(runId, ban);
      expect(() => bindDraft(raw0)).not.toThrow();
      // …then one rated row changes after aggregation.
      await sql`
        UPDATE rating.udr_rated SET udr_rated_price = udr_rated_price + 0.01
        WHERE billrun_ref_id = ${runId} AND billrun_ban_id = ${ban}
          AND udr_key LIKE '%polygon_id=PCU-T2'`;
      const raw1 = await read(runId, ban);
      const err = renderError(() => bindDraft(raw1));
      expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
      expect(err.detail).toEqual({
        banId: ban,
        offeringId: offerings[0],
        reason: "DETAIL_DOES_NOT_MATCH_RATED_AMOUNT",
      });
    }, 120_000);

    it.each([
      [
        "a key with no polygon_id= segment",
        { polygonId: null, udrResource: resource("Selangor", "Petaling") },
        "polygon_id",
      ],
      [
        "a NULL udr_resource",
        { polygonId: "PCU-M2", udrResource: null },
        "udr_resource",
      ],
      [
        "a malformed udr_resource",
        { polygonId: "PCU-M3", udrResource: "Selangor|Petaling" },
        "udr_resource",
      ],
    ] as const)(
      "6 — %s fails INVOICE_POLYGON_DATA_MISSING on both draft and final",
      async (_label, bad, missing) => {
        const tag =
          missing === "polygon_id"
            ? "MISS1"
            : bad.udrResource === null
              ? "MISS2"
              : "MISS3";
        const { runId, ban } = await capacityBill(tag, {
          "Theta Capacity": [
            {
              polygonId: "PCU-OK",
              udrResource: resource("Selangor", "Petaling"),
              ea: 1,
            },
            { ...bad, ea: 1 },
          ],
        });
        const raw = await read(runId, ban);
        const [badRow] = await sql<{ udr_id: string }[]>`
          SELECT udr_id FROM rating.udr_rated
          WHERE billrun_ref_id = ${runId} AND billrun_ban_id = ${ban}
            AND udr_key NOT LIKE '%polygon_id=PCU-OK'`;
        for (const render of [bindDraft, bindFinal]) {
          const err = renderError(() => render(raw));
          expect(err.code).toBe("INVOICE_POLYGON_DATA_MISSING");
          expect(err.detail).toEqual({
            banId: ban,
            udrRatedId: badRow!.udr_id,
            missing,
          });
        }
      },
      120_000,
    );

    it("1 — a key column whose name only ends in polygon_id is never read as the polygon", async () => {
      const { runId, ban } = await capacityBill("ANCHOR", {
        "Iota Capacity": [
          {
            polygonId: "PCU-K1",
            udrResource: resource("Selangor", "Petaling"),
            ea: 1,
          },
        ],
      });
      // rm26 sorts key names, so a `cell_polygon_id=` column precedes
      // `polygon_id=` in the raw key.
      await sql`
        UPDATE rating.udr_rated SET udr_key = 'cell_polygon_id=DECOY|' || udr_key
        WHERE billrun_ref_id = ${runId} AND billrun_ban_id = ${ban}`;
      const bound = bindDraft(await read(runId, ban));
      expect(flat(bound, 0)).toEqual([["Selangor - Petaling", "PCU-K1"]]);
    }, 120_000);
  },
);
