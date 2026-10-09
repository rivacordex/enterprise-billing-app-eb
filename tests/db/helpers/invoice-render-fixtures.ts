import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import type postgresjs from "postgres";

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { ledgerRepository } from "@/db/repositories/accounts/ledger.repository";
import { ledgerBindingRepository } from "@/db/repositories/accounts/ledger-binding.repository";
import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { billingAccount } from "@/db/schema/billing/accounts";
import { billRun } from "@/db/schema/billing/bill-run";
import { billCycle } from "@/db/schema/billing/catalogs";
import { seedCoa } from "@/db/seeds/accounts/seed-coa";
import { seedGlMappings } from "@/db/seeds/accounts/seed-gl-mappings";
import { seedReasonCodes } from "@/db/seeds/accounts/seed-reason-codes";
import { seedSysAccounts } from "@/db/seeds/accounts/seed-sys-accounts";
import { blobStore } from "@/services/billing/blob-store";
import type { PostAccountResult } from "@/services/billing/post-run";
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
//
// bm54 — `postableBill` + `post` drive the REAL posting transaction instead
// (`postAccount`, so `resolveVersionsForPosting` + `stampPosted` write the
// stamps): `seedPostingGl` loads the app's own Accounts seeds and
// `postableBill` adds the per-FA/BAN ledger bindings onboarding would create
// (the e2e happy-path suite's GL stack, unchanged).

export const FIXTURE_PERIOD_START = "2026-06-01";
export const FIXTURE_PERIOD_END = "2026-06-30";
export const FIXTURE_PARTITION = "2026-06-01";

const SEEDED_GENERATED_V1_DIR = resolve(
  process.cwd(),
  "db/seeds/invoice-templates/generated/INVOICE/v1",
);
export const GENERATED_FIXTURE_FILES = [
  "invoice.hbs",
  "footer.hbs",
  "structure.json",
  "checksums.json",
] as const;

// bm54 — inserts a non-default ACTIVE generated version and uploads its files:
// byte-copies of the seeded default v1 with `data-tpl="PIN-MARK-V<n>"` on the
// title element and "Template v{{template.version}}" in the footer (so the
// rendered HTML shows which version ran), plus its own checksums.json index
// whose SHA-256 is the row's checksum. Upload is write-once under a unique
// `dirTag`; the caller deletes `<dir><file>` for each GENERATED_FIXTURE_FILES
// afterwards. Retire any other non-default ACTIVE first (one-ACTIVE index).
export async function insertGeneratedTemplateFixture(
  sql: postgresjs.Sql,
  args: { id: string; versionNo: number; dirTag: string },
): Promise<{ dir: string }> {
  const dir = `generated/INVOICE/${args.dirTag}-v${args.versionNo}/`;
  const invoice = readFileSync(
    resolve(SEEDED_GENERATED_V1_DIR, "invoice.hbs"),
    "utf8",
  );
  const footer = readFileSync(
    resolve(SEEDED_GENERATED_V1_DIR, "footer.hbs"),
    "utf8",
  );
  const footerMarker = "<span>This is a computer-generated invoice.</span>";
  if (!invoice.includes("<h1>") || !footer.includes(footerMarker)) {
    throw new Error("seeded v1 template changed — update the bm54 fixture");
  }
  const files: Record<string, Buffer> = {
    "invoice.hbs": Buffer.from(
      invoice.replace("<h1>", `<h1 data-tpl="PIN-MARK-V${args.versionNo}">`),
    ),
    "footer.hbs": Buffer.from(
      footer.replace(
        footerMarker,
        "<span>This is a computer-generated invoice. Template v{{template.version}}</span>",
      ),
    ),
    "structure.json": readFileSync(
      resolve(SEEDED_GENERATED_V1_DIR, "structure.json"),
    ),
  };
  const digests: Record<string, string> = {};
  for (const [name, bytes] of Object.entries(files)) {
    digests[name] = createHash("sha256").update(bytes).digest("hex");
  }
  const index = Buffer.from(
    `${JSON.stringify({ algorithm: "sha256", files: digests }, null, 2)}\n`,
  );
  files["checksums.json"] = index;
  for (const [name, bytes] of Object.entries(files)) {
    await blobStore.putObject(
      "invoice-templates",
      `${dir}${name}`,
      bytes,
      name.endsWith(".json")
        ? "application/json"
        : "text/x-handlebars-template; charset=utf-8",
      { writeOnce: true, checksumAlgorithm: "sha256" },
    );
  }
  await sql`
    INSERT INTO billing.bill_template_version
      (bill_template_version_id, ref_bill_format_id, kind, version_no, status, is_default,
       ref_layout_version_id, structure, blob_ref, checksum, checksum_algorithm,
       change_note, activated_datetime)
    SELECT ${args.id}, 'INVOICE', 'generated', ${args.versionNo}, 'ACTIVE', false,
           'BTV00000001', structure, ${`invoice-templates/${dir}`},
           ${createHash("sha256").update(index).digest("hex")}, 'sha256',
           ${`bm54 fixture generated v${args.versionNo}`}, now()
    FROM billing.bill_template_version WHERE bill_template_version_id = 'BTV00000002'`;
  return { dir };
}

export interface InvoiceRenderFixtures {
  db: Database;
  // Posts one RECURRING-line bill for a new account on `runId` and returns its
  // ids. `refInvoiceProfileVersion` simulates a bm54 profile stamp.
  postedBill(args: {
    label: string;
    runId: string;
    invoiceNo: string;
    refInvoiceProfileVersion?: number | null;
    // bm54 — the generated-version stamp (NULL = posted before bm54).
    refBillTemplateVersionId?: string | null;
  }): Promise<{ banId: string; customerBillId: string }>;
  // An unposted (trial) bill — the draft/pro-forma shape.
  draftBill(args: {
    label: string;
    runId: string;
  }): Promise<{ banId: string; customerBillId: string }>;
  newRun(runId: string): Promise<void>;
  // bm54 — the Accounts GL seeds real posting needs (idempotent).
  seedPostingGl(): Promise<void>;
  // A PROCESSED account with a trial bill AND the ledger bindings posting
  // resolves — ready for `post`.
  postableBill(args: {
    label: string;
    runId: string;
  }): Promise<{ banId: string; customerBillId: string }>;
  // Runs the real `postAccount` for one account (approved by the fixture
  // operator). Its post-commit render is the production one.
  post(runId: string, banId: string): Promise<PostAccountResult>;
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
      refBillTemplateVersionId: string | null;
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
           payment_due_date, ref_bill_format_id, ref_invoice_profile_version,
           ref_bill_template_version_id, ref_inv_document_id)
        VALUES (${args.runId}, ${banId}, ${FIXTURE_PARTITION},
                ${args.posted ? "normal" : "trial"}, 'new',
                ${FIXTURE_PERIOD_START}, ${FIXTURE_PERIOD_END}, '150.00', '0.00', '150.00',
                '2026-07-15', ${args.posted ? "INVOICE" : null},
                ${args.posted?.refInvoiceProfileVersion ?? null},
                ${args.posted?.refBillTemplateVersionId ?? null},
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

  async function bindLedger(banId: string): Promise<void> {
    const [ban] = await db
      .select({
        faId: billingAccount.refFinancialAccountId,
        currency: billingAccount.currency,
      })
      .from(billingAccount)
      .where(eq(billingAccount.billingAccountId, banId));
    const { faId, currency } = ban!;
    const appDb = db as unknown as Database;
    for (const [ownerType, ownerId, ledgerRole, key] of [
      [
        "financial_account",
        faId,
        "unapplied_cash",
        `fa.${faId}.unapplied_cash`,
      ],
      ["financial_account", faId, "deposits", `fa.${faId}.deposits`],
      ["billing_account", banId, "receivables", `ban.${banId}.receivables`],
    ] as const) {
      const account = await ledgerRepository.createAccount(
        appDb,
        key,
        currency,
      );
      await ledgerBindingRepository.insert(appDb, {
        ownerType,
        ownerId,
        ledgerRole,
        pgledgerAccountId: account.id,
        lastEditedBy: actorId,
      });
    }
  }

  return {
    db: db as unknown as Database,
    postedBill: ({
      label,
      runId,
      invoiceNo,
      refInvoiceProfileVersion,
      refBillTemplateVersionId,
    }) =>
      bill({
        label,
        runId,
        posted: {
          invoiceNo,
          refInvoiceProfileVersion: refInvoiceProfileVersion ?? null,
          refBillTemplateVersionId: refBillTemplateVersionId ?? null,
        },
      }),
    draftBill: ({ label, runId }) => bill({ label, runId, posted: null }),
    newRun: fx.newRun,
    seedPostingGl: async () => {
      const appDb = db as unknown as Database;
      await seedSysAccounts(appDb);
      await seedCoa(appDb);
      await seedGlMappings(appDb);
      await seedReasonCodes(appDb);
    },
    postableBill: async ({ label, runId }) => {
      const created = await bill({ label, runId, posted: null });
      await bindLedger(created.banId);
      return created;
    },
    post: async (runId, banId) => {
      const { postAccount } = await import("@/services/billing/post-run");
      const [run] = await db
        .select()
        .from(billRun)
        .where(eq(billRun.billRunId, runId));
      return postAccount({ ...run!, approvedBy: actorId }, banId, actorId);
    },
    dropAll: () => fx.dropAll(sql),
  };
}
