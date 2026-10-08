import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { billCycle } from "@/db/schema/billing/catalogs";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { customerBillLine } from "@/db/schema/billing/customer-bill-line";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";
import { ratedLinesRepository } from "@/db/repositories/billing/rated-lines.repository";
import { invoiceRenderInputRepository } from "@/db/repositories/billing/invoice-render-input";
import { bind } from "@/services/billing/invoice-template/bind";
import { INVOICE_USAGE_ROW_LIMIT, InvoiceRenderError } from "@/types/billing";

// bm49-spec §Implementation §5 (test plan) — the DB-gated usage-annex
// regression, run against a real Postgres (the genuinely DB-specific code the
// DB-free unit tests cannot cover): the `AT TIME ZONE` date cast, the
// `substring(... 'polygon_id=([^|]*)')` cell extraction, and the
// `GROUPING SETS` subtotal aggregate in `listBilledUsageForInvoice`, plus the
// full `invoiceRenderInputRepository.read` → `bind` path with D6 reconciliation.
const databaseUrl = process.env.DATABASE_URL;

const TZ = "Asia/Kuala_Lumpur";
const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const PARTITION = "2026-06-01";
const MNO = "MNO-BM49";
const CU = "CU-BM49";

function polyKey(polygonId: string): string {
  return (
    `commercial_unit=${CU.toLowerCase()}` +
    `|mno_public_id=${MNO.toLowerCase()}` +
    `|polygon_id=${polygonId.toLowerCase()}`
  );
}

describe.skipIf(!databaseUrl)(
  "bm49 usage annex — billed udr_rated rows by state → district (requires DATABASE_URL)",
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
        labelPrefix: "BM49",
      });
    }

    // A claimed `udr_rated` row with bm48 geo. `udr_rated` has no FK to any
    // billing table, so the repository-level block needs no bill_run/account —
    // just the rows the read filters on.
    async function insertUdr(args: {
      runId: string;
      ban: string;
      attempt: number;
      status: "BILL_DRAFT" | "BILL_APPROVED" | "BILL_NOTUSED";
      startIso: string;
      udrKey: string;
      qty: string;
      unit: string;
      price: string;
      state: string | null;
      district: string | null;
    }): Promise<void> {
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw, udr_rounding_mode,
           udr_currency, udr_ref_batch_id, udr_source_file, rating_engine_version,
           rating_flow_revision, billrun_ref_id, billrun_ban_id, billrun_attempt,
           billrun_checksum, upsert_datetime, state, district)
        VALUES
          (rating.period_of(${args.startIso}::timestamptz), 'RAN_USAGE',
           ${args.startIso}::timestamptz, ${args.startIso}::timestamptz, ${args.status},
           ${"_bm49-sub"}, ${args.udrKey}, ${args.qty}, ${args.unit},
           'PER_UNIT', ${args.price}, ${args.price}, 'HALF_UP', 'MYR', '_BM49_BATCH',
           '_BM49', '_BM49', 0, ${args.runId}, ${args.ban}, ${args.attempt},
           'bm49-claim', now(), ${args.state}, ${args.district})
      `;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await fixtures().dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "BM49-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM49 Fixture Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await fixtures().dropAll(sql);
        await sql.end();
      }
    }, 60_000);

    it(
      "D2/D5 — reads every billed row (both statuses), groups state → district with " +
        "SQL subtotals, extracts the polygon cell, converts the date to the app TZ, " +
        "and excludes BILL_NOTUSED / other-attempt rows",
      async () => {
        const runId = "BRN-BM49-GROUP";
        const ban = "BAN-BM49-GROUP";

        // Selangor: Petaling (2 rows), Klang (1 row). Johor: Johor Bahru (1).
        // Unassigned: a non-polygon key, and a TZ-edge start.
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-03T10:00:00Z",
          udrKey: polyKey("P-PT-1"),
          qty: "300.000000",
          unit: "EA",
          price: "30000.00",
          state: "Selangor",
          district: "Petaling",
        });
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_APPROVED",
          startIso: "2026-06-04T10:00:00Z",
          udrKey: polyKey("P-PT-2"),
          qty: "200.000000",
          unit: "EA",
          price: "20000.00",
          state: "Selangor",
          district: "Petaling",
        });
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-05T10:00:00Z",
          udrKey: polyKey("P-KL-1"),
          qty: "250.000000",
          unit: "EA",
          price: "25000.00",
          state: "Selangor",
          district: "Klang",
        });
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-07T10:00:00Z",
          udrKey: polyKey("P-JB-1"),
          qty: "700.000000",
          unit: "EA",
          price: "70000.00",
          state: "Johor",
          district: "Johor Bahru",
        });
        // Unassigned: raw (non-polygon) key → cell falls back to the whole key;
        // start 2026-06-11T18:00Z is 2026-06-12 02:00 in Asia/KL (date must be
        // the MYT day, not the UTC one).
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-11T18:00:00Z",
          udrKey: "imsi=502130000000001",
          qty: "50.000000",
          unit: "EA",
          price: "5000.00",
          state: null,
          district: null,
        });

        // Excluded: a BILL_NOTUSED row and a second-attempt row (distinct keys
        // so the live-row unique constraint never collides).
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_NOTUSED",
          startIso: "2026-06-06T10:00:00Z",
          udrKey: polyKey("P-NOTUSED"),
          qty: "999.000000",
          unit: "EA",
          price: "99999.00",
          state: "Selangor",
          district: "Petaling",
        });
        await insertUdr({
          runId,
          ban,
          attempt: 2,
          status: "BILL_DRAFT",
          startIso: "2026-06-08T10:00:00Z",
          udrKey: polyKey("P-ATTEMPT2"),
          qty: "888.000000",
          unit: "EA",
          price: "88888.00",
          state: "Johor",
          district: "Kluang",
        });

        const result = await ratedLinesRepository.listBilledUsageForInvoice(
          db,
          {
            runId,
            banId: ban,
            attempt: 1,
            timezone: TZ,
            limit: INVOICE_USAGE_ROW_LIMIT,
          },
        );
        expect(result.overLimit).toBe(false);
        if (result.overLimit) return;

        // 5 rows (BILL_NOTUSED + attempt-2 excluded), ordered state/district
        // ASC NULLS LAST then start.
        expect(result.rows).toHaveLength(5);
        expect(result.rows.map((r) => [r.state, r.district])).toEqual([
          ["Johor", "Johor Bahru"],
          ["Selangor", "Klang"],
          ["Selangor", "Petaling"],
          ["Selangor", "Petaling"],
          [null, null],
        ]);

        // Polygon cell extracted (lower-cased in the key), raw key otherwise.
        expect(result.rows[0]!.cell).toBe("p-jb-1");
        const unassigned = result.rows[4]!;
        expect(unassigned.cell).toBe("imsi=502130000000001");
        // AT TIME ZONE: 2026-06-11T18:00Z → 2026-06-12 in Asia/KL.
        expect(unassigned.startDate).toBe("2026-06-12");
        expect(result.rows[1]!.startDate).toBe("2026-06-05");

        // GROUPING SETS subtotals.
        const grand = result.groups.find((g) => g.gState === 1)!;
        expect(grand).toMatchObject({
          rowCount: 5,
          amount: "150000.00",
          quantity: "1500.000000",
          unit: "EA",
        });

        const selangor = result.groups.find(
          (g) => g.gState === 0 && g.gDistrict === 1 && g.state === "Selangor",
        )!;
        expect(selangor).toMatchObject({
          rowCount: 3,
          amount: "75000.00",
          quantity: "750.000000",
          unit: "EA",
        });
        const johor = result.groups.find(
          (g) => g.gState === 0 && g.gDistrict === 1 && g.state === "Johor",
        )!;
        expect(johor).toMatchObject({ rowCount: 1, amount: "70000.00" });
        const unassignedState = result.groups.find(
          (g) => g.gState === 0 && g.gDistrict === 1 && g.state === null,
        )!;
        expect(unassignedState).toMatchObject({
          rowCount: 1,
          amount: "5000.00",
        });

        const petaling = result.groups.find(
          (g) =>
            g.gState === 0 &&
            g.gDistrict === 0 &&
            g.state === "Selangor" &&
            g.district === "Petaling",
        )!;
        expect(petaling).toMatchObject({
          rowCount: 2,
          amount: "50000.00",
          quantity: "500.000000",
          unit: "EA",
        });
        const klang = result.groups.find(
          (g) =>
            g.gState === 0 &&
            g.gDistrict === 0 &&
            g.state === "Selangor" &&
            g.district === "Klang",
        )!;
        expect(klang).toMatchObject({ rowCount: 1, amount: "25000.00" });
      },
    );

    it("D5 — a group mixing units reports no quantity subtotal (volume never summed across units)", async () => {
      const runId = "BRN-BM49-MIXED";
      const ban = "BAN-BM49-MIXED";
      await insertUdr({
        runId,
        ban,
        attempt: 1,
        status: "BILL_DRAFT",
        startIso: "2026-06-03T10:00:00Z",
        udrKey: polyKey("M-1"),
        qty: "10.000000",
        unit: "EA",
        price: "100.00",
        state: "Perak",
        district: "Ipoh",
      });
      await insertUdr({
        runId,
        ban,
        attempt: 1,
        status: "BILL_DRAFT",
        startIso: "2026-06-04T10:00:00Z",
        udrKey: polyKey("M-2"),
        qty: "20.000000",
        unit: "GB",
        price: "200.00",
        state: "Perak",
        district: "Ipoh",
      });

      const result = await ratedLinesRepository.listBilledUsageForInvoice(db, {
        runId,
        banId: ban,
        attempt: 1,
        timezone: TZ,
        limit: INVOICE_USAGE_ROW_LIMIT,
      });
      if (result.overLimit) throw new Error("unexpected overLimit");

      const ipoh = result.groups.find(
        (g) => g.gState === 0 && g.gDistrict === 0,
      )!;
      expect(ipoh.amount).toBe("300.00");
      expect(ipoh.quantity).toBeNull();
      expect(ipoh.unit).toBeNull();
      const grand = result.groups.find((g) => g.gState === 1)!;
      expect(grand.quantity).toBeNull();
      expect(grand.unit).toBeNull();
    });

    it("D3 — over 10,000 rows returns the over-limit marker and selects nothing", async () => {
      const runId = "BRN-BM49-OVER";
      const ban = "BAN-BM49-OVER";
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscription_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw, udr_rounding_mode,
           udr_currency, udr_ref_batch_id, udr_source_file, rating_engine_version,
           rating_flow_revision, billrun_ref_id, billrun_ban_id, billrun_attempt,
           billrun_checksum, upsert_datetime, state, district)
        SELECT
          rating.period_of('2026-06-10T00:00:00Z'::timestamptz), 'RAN_USAGE',
          '2026-06-10T00:00:00Z'::timestamptz, '2026-06-10T00:00:00Z'::timestamptz, 'BILL_DRAFT',
          '_bm49-sub',
          'commercial_unit=' || lower(${CU}) || '|mno_public_id=' || lower(${MNO}) || '|polygon_id=over-' || g.i,
          '1.000000', 'EA', 'PER_UNIT', '1.00', '1.00', 'HALF_UP', 'MYR', '_BM49_BATCH',
          '_BM49', '_BM49', 0, ${runId}, ${ban}, 1, 'bm49-over', now(), 'Selangor', 'Petaling'
        FROM generate_series(1, 10001) AS g(i)
      `;

      const result = await ratedLinesRepository.listBilledUsageForInvoice(db, {
        runId,
        banId: ban,
        attempt: 1,
        timezone: TZ,
        limit: INVOICE_USAGE_ROW_LIMIT,
      });
      expect(result).toEqual({ overLimit: true, rowCount: 10001 });
    }, 60_000);

    it(
      "end-to-end — invoiceRenderInputRepository.read → bind builds the annex and " +
        "D6 reconciles the grand total against the USAGE line's rated_amount",
      async () => {
        const fx = fixtures();
        const ban = await fx.newAccount("E2E");
        const runId = "BRN-BM49-E2E";
        await fx.newRun(runId);
        await db.insert(billRunAccount).values({
          refBillRunId: runId,
          refBillingAccountId: ban,
          periodPartition: PARTITION,
          status: "PROCESSED",
          attemptCount: 1,
        });

        // USAGE line: rated_amount = Σ udr_rated_price = 90000; net = gross =
        // rated (no discount), so subtotal = net = rated.
        const [bill] = await db
          .insert(customerBill)
          .values({
            refBillRunId: runId,
            refBillingAccountId: ban,
            periodPartition: PARTITION,
            category: "trial",
            state: "new",
            billingPeriodStart: PERIOD_START,
            billingPeriodEnd: PERIOD_END,
            subtotal: "90000.00",
            taxTotal: "0.00",
            totalAmount: "90000.00",
            paymentDueDate: "2026-07-15",
          })
          .returning({ customerBillId: customerBill.customerBillId });
        await db.insert(customerBillLine).values({
          refCustomerBillId: bill!.customerBillId,
          periodPartition: PARTITION,
          lineNo: 1,
          source: "USAGE",
          refProductOfferingId: "POF-BM49",
          udrType: "RAN_USAGE",
          grossAmount: "90000.00",
          discountAmount: "0.00",
          netAmount: "90000.00",
          groupingKey: "POF-BM49:RAN_USAGE",
          currency: "MYR",
          ratedAmount: "90000.00",
        });

        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-03T10:00:00Z",
          udrKey: polyKey("E-1"),
          qty: "300.000000",
          unit: "EA",
          price: "30000.00",
          state: "Selangor",
          district: "Petaling",
        });
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-05T10:00:00Z",
          udrKey: polyKey("E-2"),
          qty: "400.000000",
          unit: "EA",
          price: "40000.00",
          state: "Johor",
          district: "Johor Bahru",
        });
        await insertUdr({
          runId,
          ban,
          attempt: 1,
          status: "BILL_DRAFT",
          startIso: "2026-06-07T10:00:00Z",
          udrKey: "no-polygon-key",
          qty: "200.000000",
          unit: "EA",
          price: "20000.00",
          state: null,
          district: null,
        });

        const raw = await invoiceRenderInputRepository.read(db, {
          runId,
          banId: ban,
          timezone: TZ,
          includeUsage: true,
        });
        expect(raw).not.toBeNull();
        expect(raw!.bill.usageRatedTotal).toBe("90000.00");

        const bound = bind(raw!, {
          isDraft: true,
          locale: "en-MY",
          timezone: TZ,
          includeUsage: true,
        });
        expect(bound.usage).not.toBeNull();
        expect(bound.usage!.totalAmount).toBe("90000.00");
        expect(bound.usage!.rowCount).toBe(3);
        expect(bound.usage!.states.map((s) => s.label)).toEqual([
          "Johor",
          "Selangor",
          "Unassigned region",
        ]);
        expect(bound.usage!.states[2]!.districts[0]!.label).toBe("—");

        // D6 — tamper one rated row so the annex total no longer equals the
        // line's rated_amount: the next bind must fail reconciliation.
        await sql`
          UPDATE rating.udr_rated SET udr_rated_price = '31000.00'
          WHERE billrun_ref_id = ${runId} AND billrun_ban_id = ${ban}
            AND udr_key = ${polyKey("E-1")}
        `;
        const tampered = await invoiceRenderInputRepository.read(db, {
          runId,
          banId: ban,
          timezone: TZ,
          includeUsage: true,
        });
        let caught: unknown;
        try {
          bind(tampered!, {
            isDraft: true,
            locale: "en-MY",
            timezone: TZ,
            includeUsage: true,
          });
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(InvoiceRenderError);
        const err = caught as InvoiceRenderError;
        expect(err.code).toBe("INVOICE_RECONCILIATION_FAILED");
        expect(err.detail).toMatchObject({ detail: "usage" });
      },
      60_000,
    );
  },
);
