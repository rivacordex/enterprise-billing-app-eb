import { afterAll, beforeAll, describe, expect, it } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";

// bm54-spec §Tests row 2 (Inv #41, guardrail 46 DB half). The REAL posting
// transaction (`postAccount` → `resolveVersionsForPosting` → `stampPosted`)
// writes the four invoice-template version stamps in the SAME UPDATE as the
// finalization latch `ref_inv_document_id`, and the finalization guard (0033)
// then refuses any later stamp with SQLSTATE 23001.
//
// "Same statement" is proven without pg_stat_statements: a test-only BEFORE
// UPDATE row trigger (named to fire before `customer_bill_finalization_guard`)
// records every UPDATE's OLD latch + NEW five columns into a test table. One
// audit row whose OLD latch is NULL and whose NEW row carries all five means
// one UPDATE set them together. Both are dropped with the schema.
//
// The post-commit render is the production one; without a blob store it fails
// and is swallowed (D10) — this suite asserts only the posted row.
const databaseUrl = process.env.DATABASE_URL;

const RUN = "BRN-BM54-STAMPS";

interface StampRow {
  ref_bill_format_id: string | null;
  ref_bill_template_version_id: string | null;
  ref_invoice_profile_version: number | null;
  ref_csv_template_version_id: string | null;
  ref_inv_document_id: string | null;
}

describe.skipIf(!databaseUrl)(
  "customer_bill posting stamps — one UPDATE, then frozen (bm54)",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;

    async function readStamps(customerBillId: string): Promise<StampRow> {
      const [row] = await sql<StampRow[]>`
        SELECT ref_bill_format_id, ref_bill_template_version_id,
               ref_invoice_profile_version, ref_csv_template_version_id,
               ref_inv_document_id
        FROM billing.customer_bill WHERE customer_bill_id = ${customerBillId}`;
      return row!;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      fx = await setupInvoiceRenderFixtures(sql, "BM54ST");
      await fx.seedPostingGl();
      await fx.newRun(RUN);

      await sql.unsafe(`
        CREATE TABLE billing.bm54_update_audit (
          customer_bill_id text NOT NULL,
          old_inv_document_id text,
          new_inv_document_id text,
          new_bill_format_id text,
          new_bill_template_version_id text,
          new_invoice_profile_version integer,
          new_csv_template_version_id text
        )`);
      await sql.unsafe(`
        CREATE FUNCTION billing.bm54_update_audit_fn() RETURNS trigger
        LANGUAGE plpgsql AS $$
        BEGIN
          INSERT INTO billing.bm54_update_audit VALUES (
            NEW.customer_bill_id, OLD.ref_inv_document_id, NEW.ref_inv_document_id,
            NEW.ref_bill_format_id, NEW.ref_bill_template_version_id,
            NEW.ref_invoice_profile_version, NEW.ref_csv_template_version_id);
          RETURN NEW;
        END $$`);
      // "a_" sorts before "customer_bill_finalization_guard" — row triggers
      // fire alphabetically, so the audit row is written before the guard
      // decides (and is rolled back with a refused statement).
      await sql.unsafe(`
        CREATE TRIGGER a_bm54_update_audit
          BEFORE UPDATE ON billing.customer_bill
          FOR EACH ROW EXECUTE FUNCTION billing.bm54_update_audit_fn()`);
    }, 180_000);

    afterAll(async () => {
      if (sql) {
        await fx?.dropAll();
        await sql.end();
      }
    }, 60_000);

    it("posting with no ACTIVE profile stamps INVOICE + the default generated/CSV ids + a NULL profile version, in the same UPDATE as ref_inv_document_id", async () => {
      const { banId, customerBillId } = await fx.postableBill({
        label: "NOPROF",
        runId: RUN,
      });

      const result = await fx.post(RUN, banId);
      expect(result.status).toBe("invoiced");
      if (result.status !== "invoiced") return;

      expect(await readStamps(customerBillId)).toEqual({
        ref_bill_format_id: "INVOICE",
        ref_bill_template_version_id: "BTV00000002",
        ref_invoice_profile_version: null, // G15 A
        ref_csv_template_version_id: "BTV00000003",
        ref_inv_document_id: result.invoiceId,
      });

      const audit = await sql`
        SELECT * FROM billing.bm54_update_audit
        WHERE customer_bill_id = ${customerBillId}`;
      // Exactly one UPDATE touched the bill during posting, and it took the
      // latch from NULL to set AND carried all four stamps.
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        old_inv_document_id: null,
        new_inv_document_id: result.invoiceId,
        new_bill_format_id: "INVOICE",
        new_bill_template_version_id: "BTV00000002",
        new_invoice_profile_version: null,
        new_csv_template_version_id: "BTV00000003",
      });
    }, 120_000);

    it("posting under an ACTIVE company profile stamps its config_version", async () => {
      await sql`
        INSERT INTO core.system_config
          (config_group, config_version, config_key, config_value, is_secret, status)
        VALUES ('invoice.profile', 1, 'company_name', 'Stamp Co', false, 'ACTIVE')`;
      const { banId, customerBillId } = await fx.postableBill({
        label: "PROF",
        runId: RUN,
      });

      const result = await fx.post(RUN, banId);
      expect(result.status).toBe("invoiced");

      const stamps = await readStamps(customerBillId);
      expect(stamps.ref_invoice_profile_version).toBe(1);
      expect(stamps.ref_bill_template_version_id).toBe("BTV00000002");
      expect(stamps.ref_inv_document_id).not.toBeNull();
    }, 120_000);

    it("[CRITICAL] a later stamp attempt on a posted bill is refused by 0033 with SQLSTATE 23001 — stamps can never be added or corrected", async () => {
      const [posted] = await sql<{ customer_bill_id: string }[]>`
        SELECT customer_bill_id FROM billing.customer_bill
        WHERE ref_bill_run_id = ${RUN} AND ref_inv_document_id IS NOT NULL
        LIMIT 1`;
      const id = posted!.customer_bill_id;
      const before = await readStamps(id);

      for (const statement of [
        sql`UPDATE billing.customer_bill SET ref_bill_template_version_id = 'BTV00000099' WHERE customer_bill_id = ${id}`,
        sql`UPDATE billing.customer_bill SET ref_invoice_profile_version = 7 WHERE customer_bill_id = ${id}`,
        sql`UPDATE billing.customer_bill SET ref_csv_template_version_id = NULL WHERE customer_bill_id = ${id}`,
      ]) {
        await expect(statement).rejects.toMatchObject({ code: "23001" });
      }
      expect(await readStamps(id)).toEqual(before);
    });
  },
);
