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
import { createCapacityPricingFixtures } from "@/tests/db/helpers/billrun-capacity-pricing-fixtures";
import {
  invoiceRenderInputRepository,
  type RawInvoiceRenderInput,
} from "@/db/repositories/billing/invoice-render-input";
import { bind } from "@/services/billing/invoice-template/bind";
import { InvoiceRenderError } from "@/types/billing";
import {
  SEEDED_FOOTNOTE,
  SEEDED_TEMPLATE_STAMP,
} from "@/tests/helpers/seeded-invoice-template";

// bm70-spec §6 — guardrail item 62: the page-1 capacity summary, computed in
// SQL by `invoiceRenderInputRepository.read`, on bills built by the extracted
// `bill_run_processing` aggregation SQL (the bm42 `ci` capacity fixtures: base
// RM100/Mbps, target 1,000, step above 1,000 at RM50). It asserts:
//   * Utilised + Unutilised = Σ net_amount per type (summed in SQL, not JS);
//   * Σ Utilised + Σ Unutilised + Other charges + Adjustments = subtotal;
//   * the four anchors, including 2,000 Mbps → Utilised 150000.00;
//   * a capacity line with discount_amount > rated_amount (only reachable with
//     `capacity_rate_matching` OFF), inserted by SQL, trips
//     INVOICE_NEGATIVE_UTILISED at bind;
//   * the recipient name read (blank → null).
//
// Superuser DATABASE_URL connection (the bm42 flow-double precedent): this
// exercises the read logic, not the runtime grants.
const databaseUrl = process.env.DATABASE_URL;

const TZ = "Asia/Kuala_Lumpur";
const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const GL_EVENT_AT = "2026-06-01";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";

const BIND_CTX = {
  isDraft: true,
  locale: "en-MY",
  timezone: TZ,
  template: SEEDED_TEMPLATE_STAMP,
  profile: null,
  footnote: [...SEEDED_FOOTNOTE],
};

describe.skipIf(!databaseUrl)(
  "bm70 invoice page-1 capacity summary (guardrail 62, requires DATABASE_URL)",
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
        labelPrefix: "BM70",
      });
    }

    const capacityFixtures = createCapacityPricingFixtures({
      getSql: () => sql,
      newOffering: (name) => fixtures().newOffering(name),
      newProductSpec: (offeringId, name, defaultValue) =>
        fixtures().newProductSpec(offeringId, name, defaultValue),
      newAccount: (label) => fixtures().newAccount(label),
      newRun: (runId) => fixtures().newRun(runId),
      newInventory: (args) => fixtures().newInventory(args),
      claimAt: IN_WINDOW,
      labelPrefix: "BM70",
    });

    // The binder's read needs the run's `bill_run_account` row (attempt).
    async function markProcessed(runId: string, ban: string): Promise<void> {
      await db.insert(billRunAccount).values({
        refBillRunId: runId,
        refBillingAccountId: ban,
        periodPartition: PERIOD_START,
        status: "PROCESSED",
        attemptCount: 1,
      });
    }

    // The `ci` capacity offering, one account, one capacity-volume row of
    // `ea` Mbps (none for 0), aggregated by the extracted flow SQL.
    async function capacityBill(
      label: string,
      ea: number,
    ): Promise<{ runId: string; ban: string; offeringId: string }> {
      const { ban, offeringId, usageRatePriceId, runId, piId } =
        await capacityFixtures.setupSingleAccountCapacity(
          label,
          `Capacity Offering ${label}`,
          {
            baseRate: "100",
            committedQuantity: 1000,
            steps: [{ aboveQuantity: 1000, ratePerUnit: "50" }],
            udrType: "RAN_USAGE",
          },
        );
      if (ea > 0) {
        await capacityFixtures.insertCapacityVolumeRow({
          subRef: piId,
          runId,
          ban,
          attempt: 1,
          quantityEa: ea,
          rate: "100.000000",
          priceRef: usageRatePriceId,
        });
      }
      await runAggregation(sql, {
        runId,
        ban,
        attempt: 1,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
      await markProcessed(runId, ban);
      return { runId, ban, offeringId };
    }

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

    // Postgres numeric addition, so the identity is checked without JS money
    // arithmetic (General rule 6).
    async function sqlSum(...amounts: string[]): Promise<string> {
      const [row] = await sql<{ total: string }[]>`
        SELECT COALESCE(SUM(a::numeric), 0)::numeric(18,2)::text AS total
        FROM unnest(${sql.array(amounts)}::text[]) AS a
      `;
      return row!.total;
    }

    async function assertIdentities(raw: RawInvoiceRenderInput): Promise<void> {
      for (const t of raw.serviceTypes) {
        expect(await sqlSum(t.utilised, t.unutilised)).toBe(t.total);
        const [net] = await sql<{ net: string }[]>`
          SELECT SUM(net_amount)::numeric(18,2)::text AS net
          FROM billing.customer_bill_line
          WHERE ref_customer_bill_id = ${raw.bill.customerBillId}
            AND ref_product_offering_id = ${t.offeringId}
            AND grouping_key LIKE '%:CAPACITY:%'
        `;
        expect(t.total).toBe(net!.net);
      }
      expect(
        await sqlSum(
          ...raw.serviceTypes.flatMap((t) => [t.utilised, t.unutilised]),
          raw.bill.otherChargesSubTotal,
          raw.bill.adjustments,
        ),
      ).toBe(raw.bill.subtotal);
      expect(raw.bill.summaryBlocksSum).toBe(raw.bill.linesNetSum);
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      ({ db, actorId, cycleId } = await bootstrapFlowDoubleDatabase(
        sql,
        "BM70",
      ));
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropFlowDoubleSchemas(sql);
        await sql.end();
      }
    }, 60_000);

    it(
      "[CRITICAL] the four anchors: Utilised + Unutilised = Total per type, the " +
        "blocks add up to the subtotal, and 2,000 Mbps prints Utilised 150000.00",
      async () => {
        const anchors = [
          {
            label: "A800",
            ea: 800,
            utilised: "80000.00",
            unutilised: "20000.00",
            total: "100000.00",
          },
          {
            label: "A1000",
            ea: 1000,
            utilised: "100000.00",
            unutilised: "0.00",
            total: "100000.00",
          },
          {
            label: "A2000",
            ea: 2000,
            utilised: "150000.00",
            unutilised: "0.00",
            total: "150000.00",
          },
          {
            label: "A0",
            ea: 0,
            utilised: "0.00",
            unutilised: "100000.00",
            total: "100000.00",
          },
        ];
        for (const a of anchors) {
          const { runId, ban, offeringId } = await capacityBill(a.label, a.ea);
          const raw = await read(runId, ban);

          expect(raw.serviceTypes).toHaveLength(1);
          const t = raw.serviceTypes[0]!;
          expect(t.offeringId).toBe(offeringId);
          expect(t).toMatchObject({
            utilised: a.utilised,
            unutilised: a.unutilised,
            total: a.total,
            missingRated: false,
            negativeUtilised: false,
          });
          expect(raw.otherCharges).toEqual([]);
          expect(raw.bill.otherChargesSubTotal).toBe("0.00");
          expect(raw.bill.adjustments).toBe("0.00");
          await assertIdentities(raw);

          const bound = bind(raw, BIND_CTX);
          expect(bound.serviceTypes[0]).toMatchObject({
            utilised: a.utilised,
            unutilised: a.unutilised,
            total: a.total,
          });
          expect(bound.totals.totalCharges).toBe(a.total);
          expect(bound.totals.amountDue).toBe(a.total);
          // bm72 (D22) — the last page's Total Amount is the SQL Σ Utilised
          // (2,000 Mbps → 150000.00), never the bill total.
          expect(raw.bill.utilisedTotal).toBe(a.utilised);
          expect(bound.totals.totalAmount).toBe(a.utilised);
        }
      },
      240_000,
    );

    it(
      "a non-capacity charge line is an Other charges row, and the blocks still " +
        "add up to the subtotal",
      async () => {
        const { runId, ban } = await capacityBill("Mixed", 2000);
        const [bill] = await sql<{ id: string }[]>`
          SELECT customer_bill_id AS id FROM billing.customer_bill
          WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${ban}
        `;
        await sql`
          INSERT INTO billing.customer_bill_line
            (ref_customer_bill_id, period_partition, line_no, source, line_type,
             description, ref_product_offering_id, gross_amount, discount_amount,
             net_amount, grouping_key, currency)
          VALUES
            (${bill!.id}, ${PERIOD_START}, 99, 'RECURRING', 'charge',
             'Enterprise Fibre 1Gbps', 'POF-BM70-FIBRE', 10000.00, 0.00,
             10000.00, 'POF-BM70-FIBRE:RECURRING', 'MYR')
        `;
        await sql`
          UPDATE billing.customer_bill
             SET subtotal = 160000.00, total_amount = 160000.00
           WHERE customer_bill_id = ${bill!.id}
        `;

        const raw = await read(runId, ban);
        expect(raw.serviceTypes.map((t) => t.utilised)).toEqual(["150000.00"]);
        expect(raw.otherCharges).toEqual([
          { description: "Enterprise Fibre 1Gbps", amount: "10000.00" },
        ]);
        expect(raw.bill.otherChargesSubTotal).toBe("10000.00");
        await assertIdentities(raw);
        expect(bind(raw, BIND_CTX).totals.totalCharges).toBe("160000.00");
        // bm72 (D22) — Total Amount excludes the Other charges row.
        expect(raw.bill.utilisedTotal).toBe("150000.00");
      },
      120_000,
    );

    it(
      "[CRITICAL] discount_amount > rated_amount (rate matching OFF) makes " +
        "Utilised negative → INVOICE_NEGATIVE_UTILISED, never printed",
      async () => {
        const fx = fixtures();
        const ban = await fx.newAccount("Negative");
        const runId = "BRN-BM70-NEGATIVE";
        await fx.newRun(runId);
        await markProcessed(runId, ban);
        // gross 100,000, rated 10,000, discount 20,000 → net 80,000;
        // Unutilised = 90,000, Utilised = 80,000 − 90,000 = −10,000.
        const [bill] = await sql<{ id: string }[]>`
          INSERT INTO billing.customer_bill
            (ref_bill_run_id, ref_billing_account_id, period_partition, category,
             state, billing_period_start, billing_period_end, subtotal, tax_total,
             total_amount, payment_due_date)
          VALUES
            (${runId}, ${ban}, ${PERIOD_START}, 'trial', 'new', ${PERIOD_START},
             ${PERIOD_END}, 80000.00, 0.00, 80000.00, '2026-07-15')
          RETURNING customer_bill_id AS id
        `;
        await sql`
          INSERT INTO billing.customer_bill_line
            (ref_customer_bill_id, period_partition, line_no, source, line_type,
             description, ref_product_offering_id, udr_type, gross_amount,
             discount_amount, net_amount, rated_amount, grouping_key, currency)
          VALUES
            (${bill!.id}, ${PERIOD_START}, 1, 'USAGE', 'charge',
             'Negative Capacity', 'POF-BM70-NEG', 'RAN_USAGE', 100000.00,
             20000.00, 80000.00, 10000.00, 'POF-BM70-NEG:CAPACITY:EA', 'MYR')
        `;

        const raw = await read(runId, ban);
        expect(raw.serviceTypes[0]).toMatchObject({
          utilised: "-10000.00",
          unutilised: "90000.00",
          total: "80000.00",
          negativeUtilised: true,
        });

        let caught: unknown;
        try {
          bind(raw, BIND_CTX);
        } catch (err) {
          caught = err;
        }
        expect(caught).toBeInstanceOf(InvoiceRenderError);
        const err = caught as InvoiceRenderError;
        expect(err.code).toBe("INVOICE_NEGATIVE_UTILISED");
        expect(err.detail).toEqual({
          banId: ban,
          offeringId: "POF-BM70-NEG",
          utilised: "-10000.00",
        });
      },
      120_000,
    );

    it("reads the recipient name from the contact (trimmed), and a blank name as null", async () => {
      const { runId, ban } = await capacityBill("Recipient", 1000);
      const [acct] = await sql<{ role: string }[]>`
        SELECT ref_party_role_id AS role FROM billing.billing_account
        WHERE billing_account_id = ${ban}
      `;
      const [contact] = await sql<{ id: string }[]>`
        INSERT INTO customer.contact_medium
          (ref_party_role, contact_name, last_modified_by)
        VALUES (${acct!.role}, '  Aisha Rahman  ', ${actorId})
        RETURNING contact_medium_id AS id
      `;
      expect((await read(runId, ban)).customer.recipientName).toBe(
        "Aisha Rahman",
      );

      await sql`
        UPDATE customer.contact_medium SET contact_name = '   '
        WHERE contact_medium_id = ${contact!.id}
      `;
      expect((await read(runId, ban)).customer.recipientName).toBeNull();
    }, 120_000);
  },
);
