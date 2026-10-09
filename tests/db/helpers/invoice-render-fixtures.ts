import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgresjs from "postgres";

import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { billCycle } from "@/db/schema/billing/catalogs";
import { createFlowDoubleFixtures } from "@/tests/db/helpers/billrun-flow-double-fixtures";

// bm53 — shared fixtures for the render guardrails (45 render half, 47 first
// half): a fresh migrated DB (0046's seed rows + no admin activity) and bills in
// the shapes the render path reads — an unposted draft bill, and a POSTED bill
// (customer_bill.ref_inv_document_id + its posted INV `billing.document`).
//
// The posted shape is written directly (not through `postRun`): this
// environment has no workflow engine to produce a `ci` run's bills, and the
// render path only reads the posted rows. The document + stamp inserts run with
// `session_replication_role = replica` so the GL/ledger FKs a real posting
// would satisfy (reason code, journal) and the finalization guard do not apply
// to this read-side fixture — the e2e happy-path suite's precedent for
// test-only writes.

export const FIXTURE_PERIOD_START = "2026-06-01";
export const FIXTURE_PERIOD_END = "2026-06-30";
export const FIXTURE_PARTITION = "2026-06-01";

export interface InvoiceRenderFixtures {
  db: Database;
  // Posts one RECURRING-line bill for a new account on `runId` and returns its
  // ids. `refInvoiceProfileVersion` simulates a bm54 profile stamp.
  postedBill(args: {
    label: string;
    runId: string;
    invoiceNo: string;
    refInvoiceProfileVersion?: number | null;
  }): Promise<{ banId: string; customerBillId: string }>;
  // An unposted (trial) bill — the draft/pro-forma shape.
  draftBill(args: {
    label: string;
    runId: string;
  }): Promise<{ banId: string; customerBillId: string }>;
  newRun(runId: string): Promise<void>;
  dropAll(): Promise<void>;
}

export async function setupInvoiceRenderFixtures(
  sql: postgresjs.Sql,
  labelPrefix: string,
): Promise<InvoiceRenderFixtures> {
  const db = drizzle(sql, { schema });
  let actorId = "";
  let cycleId = "";
  const fx = createFlowDoubleFixtures({
    sql,
    db,
    getActorId: () => actorId,
    getCycleId: () => cycleId,
    periodStart: FIXTURE_PERIOD_START,
    periodEnd: FIXTURE_PERIOD_END,
    labelPrefix,
  });

  await fx.dropAll(sql);
  await migrate(db, {
    migrationsFolder: "./db/migrations",
    migrationsSchema: "drizzle",
  });

  const [actor] = await db
    .insert(appuser)
    .values({
      id: crypto.randomUUID(),
      userName: `${labelPrefix}-fixture-operator`,
      userEmail: `${crypto.randomUUID()}@example.invalid`,
      emailVerified: false,
      authMethod: "LOCAL",
      status: "ACTIVE",
    })
    .returning({ id: appuser.id });
  actorId = actor!.id;
  const [cycle] = await db
    .insert(billCycle)
    .values({ name: `${labelPrefix} Fixture Cycle`, lastEditedBy: null })
    .returning({ billCycleId: billCycle.billCycleId });
  cycleId = cycle!.billCycleId;

  async function bill(args: {
    label: string;
    runId: string;
    posted: {
      invoiceNo: string;
      refInvoiceProfileVersion: number | null;
    } | null;
  }): Promise<{ banId: string; customerBillId: string }> {
    const banId = await fx.newAccount(args.label);
    const [fa] = await sql<{ ref_financial_account_id: string }[]>`
      SELECT ref_financial_account_id FROM billing.billing_account WHERE billing_account_id = ${banId}`;
    await sql`
      INSERT INTO billing.bill_run_account
        (ref_bill_run_id, ref_billing_account_id, period_partition, status, attempt_count)
      VALUES (${args.runId}, ${banId}, ${FIXTURE_PARTITION},
              ${args.posted ? "INVOICED" : "PROCESSED"}, 1)`;

    return sql.begin(async (tx) => {
      await tx`SET LOCAL session_replication_role = replica`;
      const [cb] = await tx<{ customer_bill_id: string }[]>`
        INSERT INTO billing.customer_bill
          (ref_bill_run_id, ref_billing_account_id, period_partition, category, state,
           billing_period_start, billing_period_end, subtotal, tax_total, total_amount,
           payment_due_date, ref_bill_format_id, ref_invoice_profile_version, ref_inv_document_id)
        VALUES (${args.runId}, ${banId}, ${FIXTURE_PARTITION},
                ${args.posted ? "normal" : "trial"}, 'new',
                ${FIXTURE_PERIOD_START}, ${FIXTURE_PERIOD_END}, '150.00', '0.00', '150.00',
                '2026-07-15', ${args.posted ? "INVOICE" : null},
                ${args.posted?.refInvoiceProfileVersion ?? null},
                ${args.posted?.invoiceNo ?? null})
        RETURNING customer_bill_id`;
      const customerBillId = cb!.customer_bill_id;
      await tx`
        INSERT INTO billing.customer_bill_line
          (ref_customer_bill_id, period_partition, line_no, source, ref_product_offering_id,
           gross_amount, discount_amount, net_amount, grouping_key, currency, description,
           quantity, unit)
        VALUES (${customerBillId}, ${FIXTURE_PARTITION}, 1, 'RECURRING', 'POF-BM53',
                '150.00', '0.00', '150.00', 'POF-BM53', 'MYR', ${`${labelPrefix} Fibre`},
                '1.000000', 'EA')`;
      if (args.posted) {
        await tx`
          INSERT INTO billing.document
            (document_id, doc_type, state, ref_financial_account_id, ref_billing_account_id,
             reason_code, currency, total_amount, reference_info, event_at, posted_at,
             created_by, last_edited_by, ref_customer_bill_id, period_partition)
          VALUES (${args.posted.invoiceNo}, 'INV', 'posted', ${fa!.ref_financial_account_id},
                  ${banId}, 'STANDARD_INVOICE', 'MYR', '150.00', ${args.runId},
                  '2026-07-01T00:00:00Z', '2026-07-01T00:00:00Z', ${actorId}, ${actorId},
                  ${customerBillId}, ${FIXTURE_PARTITION})`;
      }
      return { banId, customerBillId };
    });
  }

  return {
    db: db as unknown as Database,
    postedBill: ({ label, runId, invoiceNo, refInvoiceProfileVersion }) =>
      bill({
        label,
        runId,
        posted: {
          invoiceNo,
          refInvoiceProfileVersion: refInvoiceProfileVersion ?? null,
        },
      }),
    draftBill: ({ label, runId }) => bill({ label, runId, posted: null }),
    newRun: fx.newRun,
    dropAll: () => fx.dropAll(sql),
  };
}
