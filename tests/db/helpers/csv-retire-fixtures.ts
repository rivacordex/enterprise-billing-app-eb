import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import type { BlobServiceClient } from "@azure/storage-blob";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";
import {
  dropAllSchemas,
  purgeInvoiceBlobs,
} from "@/tests/e2e/helpers/fresh-database";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm88 — shared setup for the two `0055` suites (retire-invoice-csv,
// pdf-unchanged-after-csv-retire): a database at 0054 with the seeded
// templates in blob, the CSV stamps pre-bm88 posting left behind, and the
// real-folder migrate that applies `0055`.

export const MIGRATIONS_FOLDER = "./db/migrations";
export const BM88_MIGRATION_TAG = "0055_retire_invoice_csv_template";
export const CSV_ROW = "BTV00000003";
export const STANDARD = "BTF00000001";

// A temp copy of db/migrations whose journal stops before 0055 (filtered on
// `when`, the cm17/bm74 precedent).
function migrationsBefore0055(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "bm88-pre-0055-"));
  cpSync(MIGRATIONS_FOLDER, dir, { recursive: true });
  const journalPath = path.join(dir, "meta", "_journal.json");
  const journal = JSON.parse(readFileSync(journalPath, "utf8")) as {
    entries: { tag: string; when: number }[];
  };
  const bm88 = journal.entries.find((e) => e.tag === BM88_MIGRATION_TAG);
  if (!bm88) {
    throw new Error(`${BM88_MIGRATION_TAG} is missing from the journal.`);
  }
  journal.entries = journal.entries.filter((e) => e.when < bm88.when);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

export interface Pre0055Database {
  sql: postgresjs.Sql;
  fx: InvoiceRenderFixtures;
}

// Guards the throwaway stores, then builds a database at 0054 with the posting
// GL and the seeded templates. The caller sets its `guarded` flag once this
// returns (the cleanup deletes invoice and template blobs).
export async function setupPre0055Database(opts: {
  databaseUrl: string;
  blobConnection: string;
  service: BlobServiceClient;
  prefix: string;
}): Promise<Pre0055Database> {
  assertTestDatabaseUrl(opts.databaseUrl);
  assertTestBlobConnection(opts.blobConnection);
  // `dropAll` resets `document_inv_seq`, so these suites re-post INV00000001;
  // `putInvoice` is write-once and would adopt an earlier suite's PDF.
  await purgeInvoiceBlobs(opts.service);
  const sql = postgres(opts.databaseUrl, { max: 5, onnotice: () => {} });
  try {
    await dropAllSchemas(sql);
    const pre = migrationsBefore0055();
    try {
      await migrate(drizzle(sql), {
        migrationsFolder: pre,
        migrationsSchema: "drizzle",
      });
    } finally {
      rmSync(pre, { recursive: true, force: true });
    }
    const fx = await setupInvoiceRenderFixtures(sql, opts.prefix, {
      reset: false,
    });
    await fx.seedPostingGl();
    await seedInvoiceTemplates(fx.db);
    clearLoadedTemplateMemo();
    return { sql, fx };
  } catch (err) {
    await sql.end();
    throw err;
  }
}

// The CSV stamp on a run row, as pre-bm88 capture left it.
export async function stampCsvOnRunAccount(
  sql: postgresjs.Sql,
  runId: string,
  banId: string,
): Promise<void> {
  await sql`
    UPDATE billing.bill_run_account SET ref_csv_template_version_id = ${CSV_ROW}
    WHERE ref_bill_run_id = ${runId} AND ref_billing_account_id = ${banId}`;
}

// The CSV stamp on a bill — written while it is still a trial bill (before
// the 0033 latch), as pre-bm88 posting left it.
export async function stampCsvOnBill(
  sql: postgresjs.Sql,
  customerBillId: string,
): Promise<void> {
  await sql`
    UPDATE billing.customer_bill SET ref_csv_template_version_id = ${CSV_ROW}
    WHERE customer_bill_id = ${customerBillId}`;
}

// Apply the real folder: 0055 only.
export async function applyRealMigrations(sql: postgresjs.Sql): Promise<void> {
  await migrate(drizzle(sql), {
    migrationsFolder: MIGRATIONS_FOLDER,
    migrationsSchema: "drizzle",
  });
  clearLoadedTemplateMemo();
}

export async function teardownCsvRetireDatabase(
  sql: postgresjs.Sql | undefined,
  service: BlobServiceClient | null,
  guarded: boolean,
): Promise<void> {
  clearLoadedTemplateMemo();
  if (guarded && service) await purgeInvoiceBlobs(service);
  if (sql) {
    await dropAllSchemas(sql);
    await sql.end();
  }
}
