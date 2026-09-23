import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { document } from "@/db/schema/billing/documents";
import { productOffering } from "@/db/schema/product";
import { persistablePricingComponentSchema } from "@/validation/product/pricing-component.schema";
import { billRunAccountRepository } from "@/db/repositories/billing/bill-run-account.repository";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import { seedSysAccounts } from "@/db/seeds/accounts/seed-sys-accounts";
import { seedCoa } from "@/db/seeds/accounts/seed-coa";
import { seedGlMappings } from "@/db/seeds/accounts/seed-gl-mappings";
import { seedReasonCodes } from "@/db/seeds/accounts/seed-reason-codes";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { runAggregation } from "@/tests/db/helpers/billrun-aggregate";
import { runVerification } from "@/tests/db/helpers/billrun-verify";
import type { materializeDueRuns as MaterializeDueRuns } from "@/services/billing/materialize-runs";
import type { triggerRun as TriggerRun } from "@/services/billing/trigger-run";
import type { rerunRun as RerunRun } from "@/services/billing/rerun-run";
import type { rejectRun as RejectRun } from "@/services/billing/reject-run";
import type { approveRun as ApproveRun } from "@/services/billing/approve-run";
import type { postRun as PostRun } from "@/services/billing/post-run";
import type {
  rerunDistribution as RerunDistribution,
  recordDistributionOutcome as RecordDistributionOutcome,
  recomputeDistributionStatus as RecomputeDistributionStatus,
} from "@/services/billing/distribute-run";
import type { listAccountBills as ListAccountBills } from "@/services/billing/read/list-account-bills";
import type { listExceptions as ListExceptions } from "@/services/billing/read/list-exceptions";
import type { POST as StageCompletePost } from "@/app/api/billrun/[runId]/stage/[stage]/complete/route";

// bm35-spec §Implementation §3 — the phase-3 full-journey E2E: the ONE journey
// no single unit owns, driving materialise → trigger → the REAL correlation +
// claim → REAL two-source Aggregation (USAGE + RECURRING) into
// `customer_bill_line` → tax → REAL Verification (reconciliation) → PROCESSED →
// review the lines + the exception surface → reject → re-rate/reprocess →
// approve (four-eyes) → post (INV per account; a line-content `charge_checksum`)
// → INVOICED → distribute (a forced failure → DISTRIBUTION_FAILED → rerun) →
// COMPLETED. It also asserts the D33 tiered-price account SKIPPED and an
// unresolvable orphan surfaced on the exception surface.
//
// **Flow-doubled, not the real Kestra (the module's established phase-3
// pattern).** The real `bill_run_processing`/`bill_run_distribution` flows are
// external; there is no live Kestra, blob store, or SFTP endpoint in this
// environment. So — exactly as `billing-e2e-happy-path` (bm13/bm21) and every
// bm27–bm34 DB-gated suite do — this journey drives the SHARED flow-doubles
// (`tests/db/helpers/billrun-aggregate.ts` `runAggregation`, `.../billrun-verify.ts`
// `runVerification`: the SAME `billrun_runtime` SQL the deployed flow runs),
// issued write-then-signal before each M2M stage signal, plus the real app
// services for the operator legs (reject/rerun/approve/post/distribute). What
// this adds over the stub-aggregation `billing-e2e-happy-path` is the REAL
// two-source aggregation + reconciliation + the D33/orphan phase-3 surfaces;
// the fragile render-pending/D10 distribution dance it reuses verbatim from that
// proven suite. The against-real-infra run (real Postgres/Kestra/blob/SFTP,
// bm22's stood-up environment) is the deferred live smoke, not this CI double.
const databaseUrl = process.env.DATABASE_URL;
const CURRENCY = "MYR";
const SERVICE_TOKEN = "bm35-phase3-journey-service-token-".padEnd(40, "x");

const PERIOD_START = "2026-06-01";
const PERIOD_END = "2026-06-30";
const IN_WINDOW = "2026-06-10T00:00:00.000Z";
const GL_EVENT_AT = "2026-07-01";
const USAGE_PRICE = "10.00";
const RECURRING_AMOUNT = "20.00";
const ORPHAN_SUBSCRIBER_REF = "PRDINV-BM35-ORPHAN-UNRESOLVABLE";

describe.skipIf(!databaseUrl)(
  "bm35 phase-3 full journey (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let materializeDueRuns: typeof MaterializeDueRuns;
    let triggerRun: typeof TriggerRun;
    let rerunRun: typeof RerunRun;
    let rejectRun: typeof RejectRun;
    let approveRun: typeof ApproveRun;
    let postRun: typeof PostRun;
    let rerunDistribution: typeof RerunDistribution;
    let recordDistributionOutcome: typeof RecordDistributionOutcome;
    let recomputeDistributionStatus: typeof RecomputeDistributionStatus;
    let REPORT_ARTIFACT_REF: string;
    let listAccountBills: typeof ListAccountBills;
    let listExceptions: typeof ListExceptions;
    let stageCompletePost: typeof StageCompletePost;

    let triggerActorId: string;
    let approveActorId: string;
    let cycleId: string;
    let seq = 0;

    const dropAll = async (client: postgresjs.Sql) => {
      await client.unsafe('DROP SCHEMA IF EXISTS "inventory" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "ordering" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "rating" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await client.unsafe('DROP SCHEMA IF EXISTS "partman" CASCADE');
    };

    async function newAppUser(name: string): Promise<string> {
      const [row] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: name,
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      return row!.id;
    }

    // A fully ledger-wired active billing account on the run's cycle (the
    // `billing-e2e-happy-path` idiom: posting resolves the FA's
    // unapplied_cash/deposits + the BAN's receivables bindings, so an INV post
    // parks without them).
    async function newBillingAccount(name: string): Promise<string> {
      const [org] = await db
        .insert(organization)
        .values({
          name: `BM35-${name}-Customer`,
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: triggerActorId,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: triggerActorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: `BM35-${name}-FA`,
          refPartyRoleId: role!.partyRoleId,
          currency: CURRENCY,
          lastEditedBy: triggerActorId,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM35-${name}-BAN`,
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: CURRENCY,
          refBillCycleId: cycleId,
          lastEditedBy: triggerActorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });

      const uc = await ledgerRepository.createAccount(
        db,
        `fa.${fa!.financialAccountId}.unapplied_cash`,
        CURRENCY,
      );
      const dep = await ledgerRepository.createAccount(
        db,
        `fa.${fa!.financialAccountId}.deposits`,
        CURRENCY,
      );
      const rec = await ledgerRepository.createAccount(
        db,
        `ban.${ban!.billingAccountId}.receivables`,
        CURRENCY,
      );
      await ledgerBindingRepository.insert(db, {
        ownerType: "financial_account",
        ownerId: fa!.financialAccountId,
        ledgerRole: "unapplied_cash",
        pgledgerAccountId: uc.id,
        lastEditedBy: triggerActorId,
      });
      await ledgerBindingRepository.insert(db, {
        ownerType: "financial_account",
        ownerId: fa!.financialAccountId,
        ledgerRole: "deposits",
        pgledgerAccountId: dep.id,
        lastEditedBy: triggerActorId,
      });
      await ledgerBindingRepository.insert(db, {
        ownerType: "billing_account",
        ownerId: ban!.billingAccountId,
        ledgerRole: "receivables",
        pgledgerAccountId: rec.id,
        lastEditedBy: triggerActorId,
      });
      return ban!.billingAccountId;
    }

    async function newOffering(name: string): Promise<string> {
      const [off] = await db
        .insert(productOffering)
        .values({
          name,
          isBundle: false,
          isSellable: true,
          billingOnly: false,
        })
        .returning({ productOfferingId: productOffering.productOfferingId });
      return off!.productOfferingId;
    }

    // pm52-spec D2: component_type='flat_fee' + envelope priceType='recurring',
    // amount read from price_component#>>'{params,amount}'.
    async function newRecurringPrice(
      offeringId: string,
      amount: string,
      startIso = "2026-01-01T00:00:00Z",
    ): Promise<void> {
      const envelope = {
        "@type": "flat_fee",
        specVersion: 1,
        plaSpecId: null,
        priceType: "recurring",
        appliesAt: "billing",
        basis: "flat",
        boundTo: null,
        params: { amount },
      };
      await sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_component,
           recurring_charge_period_length, recurring_charge_period_type,
           currency, start_date_time)
        VALUES
          (${offeringId}, 'BM35 Recurring', 'flat_fee', ${JSON.stringify(persistablePricingComponentSchema.parse(envelope))}::jsonb,
           1, 'months', ${CURRENCY}, ${startIso}::timestamptz)
      `;
    }

    // pm52-spec D3/D4: a `oneTime` flat_fee dated after a `recurring` one shares
    // its uniqueness lane (both flat_fee, unit_of_measure NULL) and supersedes
    // it in the as-of window — the offering's CURRENT flat fee becomes a
    // one-time charge, which the flat resolver cannot rate as recurring
    // (RECURRING_PRICE_UNSUPPORTED). This is the structural successor of the
    // old `pricing_model = 'tiered'` case this test used to exercise.
    async function newOneTimePrice(
      offeringId: string,
      amount: string,
      startIso: string,
    ): Promise<void> {
      const envelope = {
        "@type": "flat_fee",
        specVersion: 1,
        plaSpecId: null,
        priceType: "oneTime",
        appliesAt: "billing",
        basis: "flat",
        boundTo: null,
        params: { amount },
      };
      await sql`
        INSERT INTO product.product_offering_price
          (product_offering_id, name, component_type, price_component, currency, start_date_time)
        VALUES
          (${offeringId}, 'BM35 One-time', 'flat_fee', ${JSON.stringify(persistablePricingComponentSchema.parse(envelope))}::jsonb,
           ${CURRENCY}, ${startIso}::timestamptz)
      `;
    }

    async function newInventory(
      piId: string,
      ban: string,
      offeringId: string,
    ): Promise<void> {
      await sql.begin(async (tx) => {
        await tx`SET LOCAL session_replication_role = replica`;
        await tx`
          INSERT INTO inventory.product_inventory
            (product_inventory_id, product_order_item_id, customer_party_role_id,
             billing_account_id, product_offering_id, quantity, status, start_date)
          VALUES
            (${piId}, ${`_bm35-poi-${piId}`}, ${`_bm35-party-${piId}`},
             ${ban}, ${offeringId}, 1, 'ACTIVE', '2026-01-01')
        `;
      });
    }

    // One UNCLAIMED RAN_USAGE row — the shape the sample seed / a real load
    // leaves before Collection: status RATED, all four billrun_* columns NULL,
    // `udr_subscriber_ref_id` a real product_inventory_id (so Collection can
    // correlate it). Pass an unresolvable ref to build the orphan.
    async function insertUnclaimedUsage(subRef: string): Promise<void> {
      seq += 1;
      await sql`
        INSERT INTO rating.udr_rated
          (partition_period, udr_type, start_datetime, end_datetime, status,
           udr_subscriber_ref_id, udr_key, udr_usage_quantity, udr_usage_unit,
           udr_rate_type, udr_rated_price, udr_rated_price_raw,
           udr_rounding_mode, udr_currency, udr_ref_batch_id, udr_source_file,
           rating_engine_version, rating_flow_revision,
           billrun_ref_id, billrun_ban_id, billrun_attempt, billrun_checksum,
           upsert_datetime)
        VALUES
          (rating.period_of(${IN_WINDOW}::timestamptz), 'RAN_USAGE',
           ${IN_WINDOW}::timestamptz, ${IN_WINDOW}::timestamptz, 'RATED',
           ${subRef}, ${`_bm35-key-${seq}`}, '1.000000', 'EA', 'FLAT',
           ${USAGE_PRICE}, ${USAGE_PRICE}, 'HALF_UP', ${CURRENCY}, '_BM35_BATCH',
           '_BM35', '_BM35', 0,
           NULL, NULL, NULL, NULL, now())
      `;
    }

    // Collection's correlation-based claim: resolve an unclaimed RATED usage row
    // to its account through inventory.product_inventory and stamp the six claim
    // columns (RATED → BILL_DRAFT). The unresolvable orphan never matches, so it
    // is left behind (Inv #25). Idempotent per (run, ban, attempt).
    async function claimUsage(
      runId: string,
      ban: string,
      attempt: number,
    ): Promise<number> {
      const claimed = await sql<{ udr_id: string }[]>`
        UPDATE rating.udr_rated ur
        SET    status = 'BILL_DRAFT',
               billrun_ref_id = ${runId},
               billrun_ban_id = ${ban},
               billrun_attempt = ${attempt},
               billrun_checksum = 'bm35-claim',
               upsert_datetime = now()
        FROM   inventory.product_inventory pi
        WHERE  pi.product_inventory_id = ur.udr_subscriber_ref_id
          AND  pi.billing_account_id = ${ban}
          AND  ur.status = 'RATED'
          AND  ur.billrun_ban_id IS NULL
        RETURNING ur.udr_id
      `;
      return claimed.length;
    }

    // Taxation follows the correct lines (bm30 §3): recompute tax_total from the
    // aggregated subtotal in SQL (8% GST), never JS float.
    async function simulateTaxation(runId: string, ban: string): Promise<void> {
      const [bill] = await sql<
        { customer_bill_id: string; period_partition: string }[]
      >`
        SELECT customer_bill_id, period_partition
        FROM   billing.customer_bill
        WHERE  ref_bill_run_id = ${runId} AND ref_billing_account_id = ${ban}
      `;
      if (!bill) throw new Error(`no customer_bill for ${ban}`);
      await sql`
        INSERT INTO billing.customer_bill_tax_item
          (ref_customer_bill_id, period_partition, tax_category, tax_rate, tax_amount)
        SELECT cb.customer_bill_id, cb.period_partition, 'GST', '8.00',
               round(cb.subtotal * 0.08, 2)
        FROM   billing.customer_bill cb
        WHERE  cb.customer_bill_id = ${bill.customer_bill_id}
          AND  cb.period_partition = ${bill.period_partition}
      `;
      await sql`
        UPDATE billing.customer_bill cb
        SET    tax_total = round(cb.subtotal * 0.08, 2),
               total_amount = cb.subtotal + round(cb.subtotal * 0.08, 2)
        WHERE  cb.customer_bill_id = ${bill.customer_bill_id}
          AND  cb.period_partition = ${bill.period_partition}
      `;
    }

    async function stageSignal(
      runId: string,
      stage: string,
      body: {
        ban_id: string;
        attempt: number;
        status: string;
        error_class?: string;
        error_code?: string;
        error_detail?: string;
      },
    ): Promise<{ status: number; data: unknown }> {
      const request = new Request(
        `http://localhost/api/billrun/${runId}/stage/${stage}/complete`,
        {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${SERVICE_TOKEN}`,
          },
          body: JSON.stringify(body),
        },
      );
      const response = await stageCompletePost(request, {
        params: Promise.resolve({ runId, stage }),
      });
      const data = (await response.json()) as unknown;
      return { status: response.status, data };
    }

    // Drive the BILLED account through all six stages at `attempt`: the real
    // correlation claim + two-source aggregation + reconciliation, write-then-
    // signal before each M2M stage signal. Returns the reached account status.
    async function processBilledAccount(
      runId: string,
      ban: string,
      attempt: number,
    ): Promise<string> {
      for (const stage of ["validation"]) {
        const { status } = await stageSignal(runId, stage, {
          ban_id: ban,
          attempt,
          status: "DONE",
        });
        expect(status).toBe(200);
      }
      // Collection: claim, then signal DONE.
      const claimed = await claimUsage(runId, ban, attempt);
      expect(claimed).toBeGreaterThan(0);
      expect(
        (
          await stageSignal(runId, "collection", {
            ban_id: ban,
            attempt,
            status: "DONE",
          })
        ).status,
      ).toBe(200);
      // Aggregation: the real two-source flow-double writes customer_bill +
      // lines, then signal DONE.
      await runAggregation(sql, {
        runId,
        ban,
        attempt,
        periodStart: PERIOD_START,
        periodEnd: PERIOD_END,
        glEventAt: GL_EVENT_AT,
      });
      expect(
        (
          await stageSignal(runId, "aggregation", {
            ban_id: ban,
            attempt,
            status: "DONE",
          })
        ).status,
      ).toBe(200);
      // Taxation.
      await simulateTaxation(runId, ban);
      expect(
        (
          await stageSignal(runId, "taxation", {
            ban_id: ban,
            attempt,
            status: "DONE",
          })
        ).status,
      ).toBe(200);
      // Verification: the real reconciliation double must pass (USAGE lines
      // reconcile to their claimed rows), then signal DONE → PROCESSED.
      const verdict = await runVerification(sql, { runId, ban, attempt });
      expect(verdict.stageStatus).toBe("DONE");
      const verify = await stageSignal(runId, "verification", {
        ban_id: ban,
        attempt,
        status: "DONE",
      });
      expect(verify.status).toBe(200);
      return (verify.data as { data: { accountStatus: string } }).data
        .accountStatus;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      process.env.BILLRUN_APP_TOKEN = SERVICE_TOKEN;

      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // `billrun_delete_trial_bill` is created by db/bootstrap/billrun-db-roles.sql
      // (not a migration); create it here verbatim for the aggregation flow-double
      // (the bm28/bm29 precedent).
      await sql.unsafe(`
        CREATE OR REPLACE FUNCTION "billing".billrun_delete_trial_bill(p_run text, p_ban text)
        RETURNS integer LANGUAGE sql SECURITY DEFINER SET search_path = billing AS $$
          WITH d AS (
            DELETE FROM billing.customer_bill
             WHERE ref_bill_run_id = p_run
               AND ref_billing_account_id = p_ban
               AND ref_inv_document_id IS NULL
            RETURNING 1
          )
          SELECT count(*)::integer FROM d;
        $$;
      `);

      await seedSysAccounts(db);
      await seedCoa(db);
      await seedGlMappings(db);
      await seedReasonCodes(db);

      ({ materializeDueRuns } =
        await import("@/services/billing/materialize-runs"));
      ({ triggerRun } = await import("@/services/billing/trigger-run"));
      ({ rerunRun } = await import("@/services/billing/rerun-run"));
      ({ rejectRun } = await import("@/services/billing/reject-run"));
      ({ approveRun } = await import("@/services/billing/approve-run"));
      ({ postRun } = await import("@/services/billing/post-run"));
      ({
        rerunDistribution,
        recordDistributionOutcome,
        recomputeDistributionStatus,
        REPORT_ARTIFACT_REF,
      } = await import("@/services/billing/distribute-run"));
      ({ listAccountBills } =
        await import("@/services/billing/read/list-account-bills"));
      ({ listExceptions } =
        await import("@/services/billing/read/list-exceptions"));
      ({ POST: stageCompletePost } =
        await import("@/app/api/billrun/[runId]/stage/[stage]/complete/route"));

      triggerActorId = await newAppUser("BM35-trigger-operator");
      approveActorId = await newAppUser("BM35-approve-operator");
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM35 Phase-3 Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll(sql);
        await sql.end();
      }
    }, 60_000);

    it(
      "materialise → trigger → claim → real USAGE+RECURRING aggregation → " +
        "verify → PROCESSED → review (lines + orphan on the exception surface) → " +
        "reject → rerun → reprocess → approve (four-eyes) → post (content " +
        "checksum) → distribute (fail → rerun) → COMPLETED; D33 unsupported " +
        "(one-time-supersedes-recurring) account SKIPPED",
      async () => {
        // ---- Fixtures. ----------------------------------------------------
        // The BILLED account: a recurring-priced offering + 2 unclaimed usage
        // rows (so aggregation produces a RECURRING line AND a USAGE line).
        const banBilled = await newBillingAccount("Billed");
        const billedOffering = await newOffering("BM35 Billed Offering");
        await newRecurringPrice(billedOffering, RECURRING_AMOUNT);
        const billedInventory = "PRDINV-BM35-BILLED-0";
        await newInventory(billedInventory, banBilled, billedOffering);
        await insertUnclaimedUsage(billedInventory);
        await insertUnclaimedUsage(billedInventory);

        // The D33 account: a `oneTime` flat_fee dated after a `recurring` one on
        // the same offering — seen, not masked, by the as-of window (pm52-spec
        // D3) — so the flat resolver cannot rate the offering's current price as
        // recurring → aggregation HARD-fails → PROCESSING_FAILED → SKIPPED at
        // approve.
        const banTiered = await newBillingAccount("Tiered");
        const tieredOffering = await newOffering("BM35 Tiered Offering");
        await newRecurringPrice(
          tieredOffering,
          "10.00",
          "2026-01-01T00:00:00Z",
        );
        await newOneTimePrice(tieredOffering, "500.00", "2026-02-01T00:00:00Z");
        await newInventory("PRDINV-BM35-TIERED-0", banTiered, tieredOffering);

        // An unresolvable orphan: an unclaimed live RATED usage row whose
        // subscriber ref matches no product_inventory (Inv #25) — it must survive
        // the run unclaimed and surface on the exception surface.
        await insertUnclaimedUsage(ORPHAN_SUBSCRIBER_REF);

        // ---- Materialise + trigger. ---------------------------------------
        await materializeDueRuns("2026-07-01");
        const [run] = await db
          .select({ billRunId: billRun.billRunId, status: billRun.status })
          .from(billRun)
          .where(
            and(
              eq(billRun.refBillCycleId, cycleId),
              eq(billRun.periodStart, PERIOD_START),
            ),
          );
        expect(run?.status).toBe("SCHEDULED");
        const runId = run!.billRunId;

        const triggered = await triggerRun(runId, triggerActorId, "2026-07-01");
        expect(triggered.ok).toBe(true);
        if (!triggered.ok) return;
        // Both accounts snapshotted (full-period; the orphan is not an account).
        expect(triggered.value.banCount).toBe(2);

        // ---- Drive the BILLED account through the real pipeline (attempt 1). -
        const billedStatus = await processBilledAccount(runId, banBilled, 1);
        expect(billedStatus).toBe("PROCESSED");

        // ---- Drive the D33 account: aggregation HARD-fails (unsupported). ---
        for (const stage of ["validation", "collection"]) {
          expect(
            (
              await stageSignal(runId, stage, {
                ban_id: banTiered,
                attempt: 1,
                status: "DONE",
              })
            ).status,
          ).toBe(200);
        }
        await expect(
          runAggregation(sql, {
            runId,
            ban: banTiered,
            attempt: 1,
            periodStart: PERIOD_START,
            periodEnd: PERIOD_END,
            glEventAt: GL_EVENT_AT,
          }),
        ).rejects.toThrow(/RECURRING_PRICE_UNSUPPORTED/);
        const tieredFail = await stageSignal(runId, "aggregation", {
          ban_id: banTiered,
          attempt: 1,
          status: "FAILED",
          error_class: "HARD",
          error_code: "RECURRING_PRICE_UNSUPPORTED",
          error_detail:
            "the offering's current flat fee is a one-time charge (D33)",
        });
        expect(tieredFail.status).toBe(200);
        expect(
          (tieredFail.data as { data: { accountStatus: string } }).data
            .accountStatus,
        ).toBe("PROCESSING_FAILED");

        // ---- Run recomputed to PROCESSED (every account terminal). ----------
        const [processedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(processedRun?.status).toBe("PROCESSED");

        // ---- Review: the BILLED bill has exactly 2 lines (USAGE + RECURRING),
        // subtotal spanning both; the orphan is on the exception surface. -----
        const bills = await listAccountBills(runId);
        expect(bills).toHaveLength(1);
        expect(bills[0]?.billingAccountId).toBe(banBilled);
        // USAGE 2 × 10.00 = 20.00 + RECURRING 1 × 20.00 = 20.00 → subtotal 40.00.
        const [billedBillRow] = await db
          .select({ subtotal: customerBill.subtotal })
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banBilled));
        expect(billedBillRow?.subtotal).toBe("40.00");

        const exceptions = await listExceptions(runId);
        const orphan = exceptions.find(
          (e) => e.subscriberRef === ORPHAN_SUBSCRIBER_REF,
        );
        expect(orphan).toBeDefined();
        expect(orphan?.kind).toBe("ORPHAN");
        expect(orphan?.accountName).toBeNull();

        // ---- Reject the BILLED account (blocks approval until reprocessed). --
        const rejected = await rejectRun(
          {
            billRunId: runId,
            scope: "selected",
            banIds: [banBilled],
            reason: "bm35 phase-3 journey reject demonstration.",
          },
          approveActorId,
        );
        expect(rejected.ok).toBe(true);
        if (!rejected.ok) return;

        const blockedApproval = await approveRun(runId, approveActorId);
        expect(blockedApproval.ok).toBe(false);
        if (blockedApproval.ok) return;
        expect(blockedApproval.code).toBe("CHECKS_FAILED");

        // ---- Rerun the rejected account → re-rate (release + re-claim) →
        // reprocess at attempt 2. --------------------------------------------
        const rerun = await rerunRun(
          {
            billRunId: runId,
            accountIds: [banBilled],
            fromStage: "validation",
            reason: "bm35 phase-3 journey rerun-rejected demonstration.",
          },
          triggerActorId,
        );
        expect(rerun.ok).toBe(true);
        if (!rerun.ok) return;
        expect(rerun.value.attempt).toBe(2);

        // Re-rate at attempt 2 with NO manual release: the real `rejectRun`
        // already RELEASED banBilled's claim to `RATED` with all four billrun_*
        // columns NULLed (`udrStatusRepository.markRejected`), and `rerunRun`'s
        // own `release` is the belt on that suspenders (Inv #19 / D21 — release
        // BEFORE re-trigger). So `processBilledAccount`'s attempt-2 `claimUsage`
        // — which requires `status='RATED' AND billrun_ban_id IS NULL` and
        // asserts `claimed > 0` — only passes BECAUSE the real services drained
        // the prior claim. That assertion IS the D21 proof; a manual release
        // here would mask a regression in it.
        const reprocessed = await processBilledAccount(runId, banBilled, 2);
        expect(reprocessed).toBe("PROCESSED");

        const [reprocessedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(reprocessedRun?.status).toBe("PROCESSED");

        // ---- Approve (four-eyes: approver ≠ trigger actor). -----------------
        const approved = await approveRun(runId, approveActorId);
        expect(approved.ok).toBe(true);
        if (!approved.ok) return;
        // The D33 tiered account is SKIPPED at approval (PROCESSING_FAILED).
        expect(approved.value.skippedCount).toBe(1);

        const skippedTiered = await billRunAccountRepository.findStatus(
          db,
          runId,
          banTiered,
        );
        expect(skippedTiered?.status).toBe("SKIPPED");

        // ---- Post: one INV for the sole billed account; a real content-derived
        // charge_checksum (bm31 — not the md5('') empty-bill sentinel). --------
        const posted = await postRun(runId, approveActorId);
        expect(posted.ok).toBe(true);
        if (!posted.ok) return;
        expect(posted.value.results).toHaveLength(1);
        expect(posted.value.results[0]?.billingAccountId).toBe(banBilled);

        const [finalizedBill] = await db
          .select()
          .from(customerBill)
          .where(eq(customerBill.refBillingAccountId, banBilled));
        expect(finalizedBill?.chargeChecksum).toMatch(/^[0-9a-f]{32}$/);
        expect(finalizedBill?.chargeChecksum).not.toBe(
          "d41d8cd98f00b204e9800998ecf8427e",
        );

        // Exactly one posted INV for the billed account; the tiered account
        // consumed no invoice number.
        const billedDocs = await db
          .select()
          .from(document)
          .where(
            and(
              eq(document.refBillingAccountId, banBilled),
              eq(document.docType, "INV"),
            ),
          );
        expect(billedDocs).toHaveLength(1);
        const tieredDocs = await db
          .select()
          .from(document)
          .where(eq(document.refBillingAccountId, banTiered));
        expect(tieredDocs).toHaveLength(0);

        // ---- posting stops at INVOICED, then triggerDistribution fires
        // (post-commit) → DISTRIBUTING (the bm20/bm21 tail, reused verbatim). --
        const [invoicedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(invoicedRun?.status).toBe("DISTRIBUTING");
        expect(invoicedRun?.invoicedAt).not.toBeNull();

        // Force banBilled render-pending (bm19/bm21 D10 net): remove any stored
        // invoice row so the posted account has no deliverable PDF. Migration
        // 0036's immutability trigger blocks even a superuser DELETE, so disable
        // user triggers for this one teardown write (txn-scoped).
        await sql.begin(async (tx) => {
          await tx`SET LOCAL session_replication_role = replica`;
          await tx`DELETE FROM billing.bill_run_invoices WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banBilled}`;
        });

        // Deliver the per-run report (the only mandatory artifact that CAN be
        // delivered) → recompute → DISTRIBUTION_FAILED (the posted-but-unrendered
        // account is a mandatory artifact that was never even deliverable).
        const distributionAttempt = invoicedRun!.distributionAttempt ?? 1;
        const reportOutcome = await recordDistributionOutcome({
          runId,
          target: "loopback",
          artifactRef: REPORT_ARTIFACT_REF,
          artifactType: "report_csv",
          isMandatory: true,
          outcome: "DELIVERED",
          attempt: distributionAttempt,
        });
        expect(reportOutcome.replayed).toBe(false);
        await db.transaction((tx) =>
          recomputeDistributionStatus(tx, { billRunId: runId }),
        );
        const [failedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(failedRun?.status).toBe("DISTRIBUTION_FAILED");

        // Retry-render (simulated, as billing-e2e-happy-path does): insert the
        // stored invoice row `retryRenderInvoice` would have produced, then rerun
        // distribution → deliver it → COMPLETED.
        const [syntheticInvoice] = await sql<{ bill_run_invoice_id: string }[]>`
          INSERT INTO billing.bill_run_invoices
            (ref_bill_run_id, ref_billing_account_id, ref_customer_bill_id,
             ref_inv_document_id, blob_ref, checksum, period_partition)
          VALUES
            (${runId}, ${banBilled}, ${finalizedBill!.customerBillId},
             ${finalizedBill!.refInvDocumentId}, 'invoices/test/bm35-synthetic.pdf',
             'bm35-synthetic-checksum', ${finalizedBill!.periodPartition})
          RETURNING bill_run_invoice_id
        `;
        expect(syntheticInvoice?.bill_run_invoice_id).toBeTruthy();

        const rerunDist = await rerunDistribution(runId, approveActorId);
        expect(rerunDist.ok).toBe(true);
        if (!rerunDist.ok) return;
        expect(rerunDist.value.attempt).toBe(2);

        const invoiceOutcome = await recordDistributionOutcome({
          runId,
          target: "loopback",
          artifactRef: syntheticInvoice!.bill_run_invoice_id,
          artifactType: "invoice_pdf",
          isMandatory: true,
          outcome: "DELIVERED",
          attempt: 2,
        });
        expect(invoiceOutcome.replayed).toBe(false);
        await db.transaction((tx) =>
          recomputeDistributionStatus(tx, { billRunId: runId }),
        );

        const [completedRun] = await db
          .select()
          .from(billRun)
          .where(eq(billRun.billRunId, runId));
        expect(completedRun?.status).toBe("COMPLETED");
        expect(completedRun?.completedAt).not.toBeNull();
      },
      180_000,
    );
  },
);
