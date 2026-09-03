import { readFileSync } from "node:fs";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { organization, partyRole } from "@/db/schema/customer";
import { billCycle } from "@/db/schema/billing/catalogs";
import { financialAccount, billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { billRunAccount } from "@/db/schema/billing/bill-run-account";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm14-spec §Implementation §5 + Verification checklist. The grant surface is
// the deliverable, so every assertion runs against a LIVE database, via a LIVE
// CONNECTION PER ROLE — the same posture as rm03's
// `tests/rating/grants.integration.test.ts`, which this suite mirrors.
//
// DATABASE_URL must be a SUPERUSER/OWNER connection: the suite creates login
// roles, a second (`kestra`) database, sets passwords, runs all four
// bootstrap SQL files, and opens per-role connections.
const databaseUrl = process.env.DATABASE_URL;

const ROLE_PW = "bm14-test-only-pw";

const BOOTSTRAP_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/bootstrap-db-roles.sql",
);
const RATING_ROLES_SQL = join(process.cwd(), "db/bootstrap/rating-db-roles.sql");
const BILLRUN_ROLES_SQL = join(
  process.cwd(),
  "db/bootstrap/billrun-db-roles.sql",
);
const KESTRA_ROLES_SQL = join(process.cwd(), "db/bootstrap/kestra-db-roles.sql");

// The six columns app_runtime/billrun_runtime may UPDATE on udr_rated
// (bm14-spec Step 7 — the same set rating rm03 granted app_runtime).
const CLAIM_UPDATABLE = [
  "status",
  "billrun_ref_id",
  "billrun_ban_id",
  "billrun_attempt",
  "billrun_checksum",
  "upsert_datetime",
].sort();

function roleUrl(base: string, user: string, password: string): string {
  const url = new URL(base);
  url.username = user;
  url.password = password;
  return url.toString();
}

function withDatabase(base: string, database: string): string {
  const url = new URL(base);
  url.pathname = `/${database}`;
  return url.toString();
}

function statements(path: string): string[] {
  return readFileSync(path, "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

async function runSqlFile(client: postgresjs.Sql, path: string): Promise<void> {
  for (const statement of statements(path)) {
    await client.unsafe(statement);
  }
}

// kestra-db-roles.sql's statements split across TWO connections (the billing
// database for Steps 1-3, `kestra` itself for Step 4) — mirrors
// db/bootstrap/kestra-db-roles.ts's readStatementGroups/main.
const KESTRA_DB_MARKER_LINE = /^--> statement-breakpoint-kestra-db$/m;
const PG_DUPLICATE_DATABASE = "42P04";

function isDuplicateDatabaseError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    (err as { code?: string }).code === PG_DUPLICATE_DATABASE
  );
}

async function runKestraBootstrap(bootstrapUrl: string): Promise<void> {
  const text = readFileSync(KESTRA_ROLES_SQL, "utf8");
  const match = KESTRA_DB_MARKER_LINE.exec(text);
  const billingText = match ? text.slice(0, match.index) : text;
  const kestraText = match ? text.slice(match.index + match[0].length) : "";
  const billingStatements = billingText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  const kestraStatements = kestraText
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);

  const sql = postgres(bootstrapUrl, { max: 1 });
  try {
    for (const statement of billingStatements) {
      try {
        await sql.unsafe(statement);
      } catch (err) {
        if (isDuplicateDatabaseError(err)) continue;
        throw err;
      }
    }
  } finally {
    await sql.end();
  }

  if (kestraStatements.length > 0) {
    const kestraSql = postgres(withDatabase(bootstrapUrl, "kestra"), {
      max: 1,
    });
    try {
      for (const statement of kestraStatements) {
        await kestraSql.unsafe(statement);
      }
    } finally {
      await kestraSql.end();
    }
  }
}

// A valid udr_rated row (rating rm01 DDL): partition_period must equal
// period_of(start_datetime) = date_trunc('month', start AT TIME ZONE UTC).
function ratedRow(overrides: Record<string, unknown> = {}) {
  return {
    partition_period: "2026-08-01",
    udr_type: "USAGE",
    start_datetime: "2026-08-14T10:00:00Z",
    end_datetime: "2026-08-14T11:00:00Z",
    udr_subscriber_ref_id: "SUB-1",
    udr_key: `KEY-${crypto.randomUUID()}`,
    udr_usage_quantity: "1.000000",
    udr_usage_unit: "CALL",
    udr_rate_type: "FLAT",
    udr_rated_price: "1.00",
    udr_rated_price_raw: "1.000000",
    udr_rounding_mode: "HALF_UP",
    udr_currency: "USD",
    udr_ref_batch_id: "UDRBAT-TEST",
    udr_source_file: "test.csv",
    rating_engine_version: "v1",
    rating_flow_revision: 1,
    status: "RATED",
    ...overrides,
  };
}

describe.skipIf(!databaseUrl)(
  "billrun_runtime role grants (bm14-spec, requires a superuser DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql; // superuser/owner
    let billrunRuntime: postgresjs.Sql;
    let appRuntime: postgresjs.Sql;
    let db: Database;

    let cycleId: string;
    let runId: string;
    let banId: string;
    let periodPartition: string;
    let actorId: string;
    let partyRoleId: string;
    let financialAccountId: string;
    let banSeq = 0;

    // A fresh billing_account per call — customer_bill's UNIQUE(ref_bill_run_id,
    // ref_billing_account_id, period_partition) means every test that inserts
    // its own trial bill against the shared `runId`/`periodPartition` needs its
    // own account, or the second test's insert collides with the first's.
    async function newBan(): Promise<string> {
      banSeq += 1;
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: `BM14-Fixture-BAN-${banSeq}`,
          state: "active",
          refPartyRoleId: partyRoleId,
          refFinancialAccountId: financialAccountId,
          currency: "USD",
          refBillCycleId: cycleId,
          lastEditedBy: actorId,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      return ban!.billingAccountId;
    }

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

    async function insertRatedRow(
      overrides: Record<string, unknown> = {},
    ): Promise<{ period: string; id: string }> {
      const [row] = await sql<{ partition_period: string; udr_id: string }[]>`
        INSERT INTO rating.udr_rated ${sql(ratedRow(overrides))}
        RETURNING partition_period, udr_id
      `;
      return { period: row!.partition_period, id: row!.udr_id };
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await dropAll(sql);
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      // Provisioning order (infra/docs/db-role-verification.md): platform ->
      // rating -> billrun -> kestra. billrun's Step 0 requires rating's Step 2
      // REVOKE CONNECT ... FROM PUBLIC to have already run.
      await runSqlFile(sql, BOOTSTRAP_ROLES_SQL);
      await runSqlFile(sql, RATING_ROLES_SQL);
      await runSqlFile(sql, BILLRUN_ROLES_SQL);
      await runKestraBootstrap(databaseUrl as string);

      await sql.unsafe(`ALTER ROLE app_runtime      WITH PASSWORD '${ROLE_PW}'`);
      await sql.unsafe(`ALTER ROLE rating_runtime   WITH PASSWORD '${ROLE_PW}'`);
      await sql.unsafe(`ALTER ROLE billrun_runtime  WITH PASSWORD '${ROLE_PW}'`);

      billrunRuntime = postgres(
        roleUrl(databaseUrl as string, "billrun_runtime", ROLE_PW),
        { max: 1 },
      );
      appRuntime = postgres(
        roleUrl(databaseUrl as string, "app_runtime", ROLE_PW),
        { max: 1 },
      );

      // Fixture chain: appuser -> org/party -> financial_account ->
      // billing_account -> bill_cycle -> bill_run -> bill_run_account.
      const [actor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "BM14-fixture-operator",
          userEmail: `${crypto.randomUUID()}@example.invalid`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      actorId = actor!.id;
      const [org] = await db
        .insert(organization)
        .values({
          name: "BM14-Fixture-Customer",
          organizationType: "COMPANY",
          status: "ACTIVE",
          lastModifiedBy: actor!.id,
        })
        .returning({ organizationId: organization.organizationId });
      const [role] = await db
        .insert(partyRole)
        .values({
          engagedParty: org!.organizationId,
          status: "ACTIVE",
          lastModifiedBy: actor!.id,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      partyRoleId = role!.partyRoleId;
      const [fa] = await db
        .insert(financialAccount)
        .values({
          name: "BM14-Fixture-FA",
          refPartyRoleId: role!.partyRoleId,
          currency: "USD",
          lastEditedBy: actor!.id,
        })
        .returning({ financialAccountId: financialAccount.financialAccountId });
      financialAccountId = fa!.financialAccountId;
      const [cycle] = await db
        .insert(billCycle)
        .values({ name: "BM14 Fixture Cycle", lastEditedBy: null })
        .returning({ billCycleId: billCycle.billCycleId });
      cycleId = cycle!.billCycleId;
      const [ban] = await db
        .insert(billingAccount)
        .values({
          name: "BM14-Fixture-BAN",
          state: "active",
          refPartyRoleId: role!.partyRoleId,
          refFinancialAccountId: fa!.financialAccountId,
          currency: "USD",
          refBillCycleId: cycleId,
          lastEditedBy: actor!.id,
        })
        .returning({ billingAccountId: billingAccount.billingAccountId });
      banId = ban!.billingAccountId;
      periodPartition = "2026-08-01";
      const [run] = await db
        .insert(billRun)
        .values({
          refBillCycleId: cycleId,
          periodStart: "2026-08-01",
          periodEnd: "2026-08-31",
          scheduledRunDate: "2026-09-01",
          status: "PROCESSING",
        })
        .returning({ billRunId: billRun.billRunId });
      runId = run!.billRunId;
      await db.insert(billRunAccount).values({
        refBillRunId: runId,
        refBillingAccountId: banId,
        periodPartition,
        status: "PROCESSING",
      });
    }, 180_000);

    afterAll(async () => {
      await billrunRuntime?.end();
      await appRuntime?.end();
      if (sql) {
        await dropAll(sql);
        await sql.unsafe('DROP DATABASE IF EXISTS "kestra" WITH (FORCE)');
        await sql.end();
      }
    });

    // ---- customer_bill: column boundary (Step 5) ---------------------------
    describe("customer_bill — column boundary (Step 5)", () => {
      async function insertTrialBill(ban: string): Promise<string> {
        const [row] = await billrunRuntime<{ customer_bill_id: string }[]>`
          INSERT INTO billing.customer_bill ${billrunRuntime({
            ref_bill_run_id: runId,
            ref_billing_account_id: ban,
            period_partition: periodPartition,
            category: "trial",
            state: "new",
            billing_period_start: "2026-08-01",
            billing_period_end: "2026-08-31",
            subtotal: "100.00",
            tax_total: "0.00",
            total_amount: "100.00",
            payment_due_date: "2026-09-15",
          })}
          RETURNING customer_bill_id
        `;
        return row!.customer_bill_id;
      }

      it("1. billrun_runtime INSERTs a trial bill on the allowed columns", async () => {
        await expect(insertTrialBill(await newBan())).resolves.toBeTruthy();
      });

      it("2. billrun_runtime UPDATEs an allowed column (state) and SELECTs it back", async () => {
        const id = await insertTrialBill(await newBan());
        await expect(
          billrunRuntime`UPDATE billing.customer_bill SET state = 'validated' WHERE customer_bill_id = ${id}`,
        ).resolves.toBeDefined();
        const [row] = await billrunRuntime<{ state: string }[]>`
          SELECT state FROM billing.customer_bill WHERE customer_bill_id = ${id}
        `;
        expect(row?.state).toBe("validated");
      });

      it("3. UPDATE of a posting-stamp column is refused per column", async () => {
        const id = await insertTrialBill(await newBan());
        for (const assignment of [
          "ref_inv_document_id = 'INV00000001'",
          "posted_attempt = 1",
          "charge_checksum = 'x'",
        ]) {
          await expect(
            billrunRuntime.unsafe(
              `UPDATE billing.customer_bill SET ${assignment} WHERE customer_bill_id = $1`,
              [id],
            ),
          ).rejects.toThrow(/permission denied for table customer_bill/);
        }
      });

      it("4. INSERT that pre-sets a posting-stamp column is refused (closes the finalization-latch hole, D bullet 4)", async () => {
        const ban = await newBan();
        await expect(
          billrunRuntime`
            INSERT INTO billing.customer_bill ${billrunRuntime({
              ref_bill_run_id: runId,
              ref_billing_account_id: ban,
              period_partition: periodPartition,
              category: "trial",
              state: "new",
              billing_period_start: "2026-08-01",
              billing_period_end: "2026-08-31",
              subtotal: "100.00",
              tax_total: "0.00",
              total_amount: "100.00",
              payment_due_date: "2026-09-15",
              posted_attempt: 1,
            })}
          `,
        ).rejects.toThrow(/permission denied for table customer_bill/);
      });

      it("5. a direct DELETE on customer_bill is refused — no table grant (T10)", async () => {
        await expect(
          billrunRuntime`DELETE FROM billing.customer_bill WHERE false`,
        ).rejects.toThrow(/permission denied for table customer_bill/);
      });

      it("6. billing.billrun_delete_trial_bill(run, ban) deletes only that account's non-finalized bill in that run", async () => {
        const ban = await newBan();
        const id = await insertTrialBill(ban);
        const [result] = await billrunRuntime<
          { billrun_delete_trial_bill: number }[]
        >`SELECT billing.billrun_delete_trial_bill(${runId}, ${ban})`;
        expect(result!.billrun_delete_trial_bill).toBe(1);
        const remaining = await sql<{ customer_bill_id: string }[]>`
          SELECT customer_bill_id FROM billing.customer_bill WHERE customer_bill_id = ${id}
        `;
        expect(remaining).toHaveLength(0);
      });

      it("7. billrun_delete_trial_bill never touches a finalized row (ref_inv_document_id set)", async () => {
        const ban = await newBan();
        const id = await insertTrialBill(ban);
        await sql`
          UPDATE billing.customer_bill SET ref_inv_document_id = 'INV00000002' WHERE customer_bill_id = ${id}
        `;
        const [result] = await billrunRuntime<
          { billrun_delete_trial_bill: number }[]
        >`SELECT billing.billrun_delete_trial_bill(${runId}, ${ban})`;
        expect(result!.billrun_delete_trial_bill).toBe(0);
        const remaining = await sql<{ customer_bill_id: string }[]>`
          SELECT customer_bill_id FROM billing.customer_bill WHERE customer_bill_id = ${id}
        `;
        expect(remaining).toHaveLength(1);
        // clean up the finalized row directly (superuser bypasses the ACL).
        await sql`DELETE FROM billing.customer_bill WHERE customer_bill_id = ${id}`;
      });
    });

    // ---- customer_bill_tax_item: worker-owned (Step 6/6a) ------------------
    describe("customer_bill_tax_item — worker-owned (Step 6/6a)", () => {
      it("8. billrun_runtime INSERTs/UPDATEs/DELETEs/SELECTs a tax item", async () => {
        const ban = await newBan();
        const [bill] = await sql<{ customer_bill_id: string }[]>`
          INSERT INTO billing.customer_bill ${sql({
            ref_bill_run_id: runId,
            ref_billing_account_id: ban,
            period_partition: periodPartition,
            category: "trial",
            state: "new",
            billing_period_start: "2026-08-01",
            billing_period_end: "2026-08-31",
            subtotal: "100.00",
            tax_total: "0.00",
            total_amount: "100.00",
            payment_due_date: "2026-09-15",
          })}
          RETURNING customer_bill_id
        `;
        const billId = bill!.customer_bill_id;

        const [item] = await billrunRuntime<
          { customer_bill_tax_item_id: string }[]
        >`
          INSERT INTO billing.customer_bill_tax_item ${billrunRuntime({
            ref_customer_bill_id: billId,
            period_partition: periodPartition,
            tax_category: "GST",
            tax_rate: "8.00",
            tax_amount: "8.00",
          })}
          RETURNING customer_bill_tax_item_id
        `;
        const itemId = item!.customer_bill_tax_item_id;

        await expect(
          billrunRuntime`SELECT 1 FROM billing.customer_bill_tax_item WHERE customer_bill_tax_item_id = ${itemId}`,
        ).resolves.toBeDefined();
        await expect(
          billrunRuntime`UPDATE billing.customer_bill_tax_item SET tax_amount = '9.00' WHERE customer_bill_tax_item_id = ${itemId}`,
        ).resolves.toBeDefined();
        await expect(
          billrunRuntime`DELETE FROM billing.customer_bill_tax_item WHERE customer_bill_tax_item_id = ${itemId}`,
        ).resolves.toBeDefined();
      });

      it("9. app_runtime writing customer_bill_tax_item is refused — SELECT only (Step 6a)", async () => {
        await expect(
          appRuntime`SELECT 1 FROM billing.customer_bill_tax_item WHERE false`,
        ).resolves.toBeDefined();
        await expect(
          appRuntime`INSERT INTO billing.customer_bill_tax_item ${appRuntime({
            ref_customer_bill_id: "CBL00000000",
            period_partition: periodPartition,
            tax_category: "GST",
            tax_rate: "8.00",
            tax_amount: "1.00",
          })}`,
        ).rejects.toThrow(/permission denied for table customer_bill_tax_item/);
      });
    });

    // ---- udr_rated claim: column boundary + value guard (Step 7/7b) --------
    describe("udr_rated claim — column boundary + value guard (Step 7/7b)", () => {
      it("10. the pg_attribute enumeration returns exactly the six billrun_runtime-updatable columns", async () => {
        const rows = await sql<{ attname: string; upd: boolean }[]>`
          SELECT a.attname,
                 has_column_privilege('billrun_runtime','rating.udr_rated', a.attname, 'UPDATE') AS upd
          FROM pg_attribute a
          WHERE a.attrelid = 'rating.udr_rated'::regclass
            AND a.attnum > 0 AND NOT a.attisdropped
        `;
        const updatable = rows
          .filter((r) => r.upd)
          .map((r) => r.attname)
          .sort();
        expect(updatable).toEqual(CLAIM_UPDATABLE);
      });

      it("11. billrun_runtime updates each of the six claimed columns individually", async () => {
        const { period, id } = await insertRatedRow();
        const sets: string[] = [
          "billrun_ref_id = 'BR-1'",
          "billrun_ban_id = 'BAN-1'",
          "billrun_attempt = 1",
          "billrun_checksum = 'CHK'",
          "upsert_datetime = now()",
          "status = 'BILL_DRAFT'",
        ];
        for (const assignment of sets) {
          await expect(
            billrunRuntime.unsafe(
              `UPDATE rating.udr_rated SET ${assignment} WHERE partition_period = $1 AND udr_id = $2`,
              [period, id],
            ),
          ).resolves.toBeDefined();
        }
      });

      it("12. updating a column outside the six is refused per column", async () => {
        const { period, id } = await insertRatedRow();
        for (const col of ["udr_rated_price", "udr_currency", "udr_key"]) {
          await expect(
            billrunRuntime.unsafe(
              `UPDATE rating.udr_rated SET ${col} = NULL WHERE partition_period = $1 AND udr_id = $2`,
              [period, id],
            ),
          ).rejects.toThrow(/permission denied for table udr_rated/);
        }
      });

      it("13. INSERT into udr_rated by billrun_runtime is refused — rating owns inserts", async () => {
        await expect(
          billrunRuntime`INSERT INTO rating.udr_rated ${billrunRuntime(ratedRow({ udr_key: `KEY-${crypto.randomUUID()}` }))}`,
        ).rejects.toThrow(/permission denied/);
      });

      it("14. RATED -> BILL_DRAFT succeeds; RATED -> BILL_APPROVED/REJECTED is refused by the trigger (Step 7b)", async () => {
        const ok = await insertRatedRow();
        await expect(
          billrunRuntime.unsafe(
            `UPDATE rating.udr_rated SET status = 'BILL_DRAFT' WHERE partition_period = $1 AND udr_id = $2`,
            [ok.period, ok.id],
          ),
        ).resolves.toBeDefined();

        for (const target of ["BILL_APPROVED", "REJECTED"]) {
          const bad = await insertRatedRow();
          await expect(
            billrunRuntime.unsafe(
              `UPDATE rating.udr_rated SET status = '${target}' WHERE partition_period = $1 AND udr_id = $2`,
              [bad.period, bad.id],
            ),
          ).rejects.toThrow(
            /billrun_runtime may only transition udr_rated RATED -> BILL_DRAFT/,
          );
        }
      });

      it("15. the trigger does not constrain app_runtime's own transitions", async () => {
        const { period, id } = await insertRatedRow({ status: "BILL_DRAFT" });
        await expect(
          appRuntime.unsafe(
            `UPDATE rating.udr_rated SET status = 'BILL_APPROVED' WHERE partition_period = $1 AND udr_id = $2`,
            [period, id],
          ),
        ).resolves.toBeDefined();
      });
    });

    // ---- read-only run context + run-state REVOKE (Step 8/9) ---------------
    describe("read-only run context + run-state REVOKE (Step 8/9)", () => {
      it("16. billrun_runtime SELECTs bill_run, bill_run_account, billing_account, bill_cycle", async () => {
        await expect(
          billrunRuntime`SELECT 1 FROM billing.bill_run WHERE bill_run_id = ${runId}`,
        ).resolves.toBeDefined();
        await expect(
          billrunRuntime`SELECT 1 FROM billing.bill_run_account WHERE ref_bill_run_id = ${runId}`,
        ).resolves.toBeDefined();
        await expect(
          billrunRuntime`SELECT 1 FROM billing.billing_account WHERE billing_account_id = ${banId}`,
        ).resolves.toBeDefined();
        await expect(
          billrunRuntime`SELECT 1 FROM billing.bill_cycle WHERE bill_cycle_id = ${cycleId}`,
        ).resolves.toBeDefined();
      });

      it("17. any write on bill_run/bill_run_account/bill_run_account_stage/document is refused", async () => {
        await expect(
          billrunRuntime`UPDATE billing.bill_run SET bill_run_id = bill_run_id WHERE false`,
        ).rejects.toThrow(/permission denied for table bill_run/);
        await expect(
          billrunRuntime`DELETE FROM billing.bill_run_account WHERE false`,
        ).rejects.toThrow(/permission denied for table bill_run_account/);
        await expect(
          billrunRuntime`UPDATE billing.bill_run_account_stage SET status = 'DONE' WHERE false`,
        ).rejects.toThrow(/permission denied for table bill_run_account_stage/);
        await expect(
          billrunRuntime`INSERT INTO billing.document DEFAULT VALUES`,
        ).rejects.toThrow(/permission denied for table document/);
      });
    });

    // ---- pgledger SECURITY DEFINER REVOKE (Step 10) -------------------------
    describe("pgledger SECURITY DEFINER REVOKE (Step 10)", () => {
      it("18. billrun_runtime calling pgledger_create_transfer(...) is refused", async () => {
        await expect(
          billrunRuntime`SELECT billing.pgledger_create_transfer('a', 'b', 1::numeric, now(), '{}'::jsonb)`,
        ).rejects.toThrow(/permission denied for function/);
      });
    });

    // ---- database boundary (kestra, Step 11) --------------------------------
    describe("database boundary (Step 11)", () => {
      it("19. billrun_runtime is refused CONNECT to the kestra database", async () => {
        const probe = postgres(
          roleUrl(withDatabase(databaseUrl as string, "kestra"), "billrun_runtime", ROLE_PW),
          { max: 1 },
        );
        try {
          await expect(probe`SELECT 1`).rejects.toThrow(
            /permission denied for database/,
          );
        } finally {
          await probe.end();
        }
      });

      it("20. billrun_runtime holds CONNECT on the billing database only via its explicit grant", async () => {
        const [row] = await sql<{ pub: boolean; own: boolean }[]>`
          SELECT has_database_privilege('public', current_database(), 'CONNECT') AS pub,
                 has_database_privilege('billrun_runtime', current_database(), 'CONNECT') AS own
        `;
        expect(row?.pub).toBe(false);
        expect(row?.own).toBe(true);
      });

      it("21. rolconnlimit on billrun_runtime equals the configured 20", async () => {
        const [row] = await sql<{ rolconnlimit: number }[]>`
          SELECT rolconnlimit FROM pg_roles WHERE rolname = 'billrun_runtime'
        `;
        expect(row?.rolconnlimit).toBe(20);
      });
    });

    // ---- deploy-ordering guard (Step 0) + idempotency -----------------------
    describe("deploy-ordering guard (Step 0) + idempotency", () => {
      it("22. running Step 0 while PUBLIC still holds CONNECT fails with ORDERING:", async () => {
        await sql.unsafe(
          `DO $$ BEGIN EXECUTE format('GRANT CONNECT ON DATABASE %I TO PUBLIC', current_database()); END $$;`,
        );
        try {
          await expect(
            sql.unsafe(statements(BILLRUN_ROLES_SQL)[0]!),
          ).rejects.toThrow(/ORDERING:/);
        } finally {
          await sql.unsafe(
            `DO $$ BEGIN EXECUTE format('REVOKE CONNECT ON DATABASE %I FROM PUBLIC', current_database()); END $$;`,
          );
        }
      });

      it("23. re-running billrun-db-roles.sql converges — no error, connlimit still 20", async () => {
        await expect(runSqlFile(sql, BILLRUN_ROLES_SQL)).resolves.toBeUndefined();
        const [row] = await sql<{ rolconnlimit: number }[]>`
          SELECT rolconnlimit FROM pg_roles WHERE rolname = 'billrun_runtime'
        `;
        expect(row?.rolconnlimit).toBe(20);
      });

      it("24. re-running against an ELEVATED billrun_runtime strips SUPERUSER/CREATEROLE/CREATEDB/REPLICATION/BYPASSRLS", async () => {
        await sql.unsafe(
          "ALTER ROLE billrun_runtime WITH SUPERUSER CREATEROLE CREATEDB REPLICATION BYPASSRLS",
        );
        await runSqlFile(sql, BILLRUN_ROLES_SQL);
        const [row] = await sql<
          {
            rolsuper: boolean;
            rolcreaterole: boolean;
            rolcreatedb: boolean;
            rolreplication: boolean;
            rolbypassrls: boolean;
            rolcanlogin: boolean;
            rolconnlimit: number;
          }[]
        >`
          SELECT rolsuper, rolcreaterole, rolcreatedb, rolreplication,
                 rolbypassrls, rolcanlogin, rolconnlimit
          FROM pg_roles WHERE rolname = 'billrun_runtime'
        `;
        expect(row?.rolsuper).toBe(false);
        expect(row?.rolcreaterole).toBe(false);
        expect(row?.rolcreatedb).toBe(false);
        expect(row?.rolreplication).toBe(false);
        expect(row?.rolbypassrls).toBe(false);
        expect(row?.rolcanlogin).toBe(true);
        expect(row?.rolconnlimit).toBe(20);
      });
    });
  },
);
