import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "billing module tables + views integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await migrate(drizzle(sql), {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      const [user] = await sql<{ id: string }[]>`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES ('test-user-ac02', 'Test User', 'test-user-ac02@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("Test appuser insert returned no row.");
      appuserId = user.id;
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "billing" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function insertOrganization(name: string): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, last_modified_by)
        VALUES (${name}, 'COMPANY', ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!row) throw new Error("Organization insert returned no row.");
      return row.id;
    }

    async function insertPartyRole(organizationId: string): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${organizationId}, 'ACTIVE', ${appuserId})
        RETURNING party_role_id AS id
      `;
      if (!row) throw new Error("Party role insert returned no row.");
      return row.id;
    }

    async function insertBillCycle(name: string): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.bill_cycle (name, last_edited_by)
        VALUES (${name}, ${appuserId})
        RETURNING bill_cycle_id AS id
      `;
      if (!row) throw new Error("Bill cycle insert returned no row.");
      return row.id;
    }

    async function insertReasonCode(reasonCode: string): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.reason_code (reason_code, name, doc_type, posting_nature, last_edited_by)
        VALUES (${reasonCode}, 'Test Reason', 'PAY', 'cash', ${appuserId})
        RETURNING reason_code AS id
      `;
      if (!row) throw new Error("Reason code insert returned no row.");
      return row.id;
    }

    async function insertFinancialAccount(
      partyRoleId: string,
      name = "Test FA",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
        VALUES (${name}, ${partyRoleId}, 'MYR', ${appuserId})
        RETURNING financial_account_id AS id
      `;
      if (!row) throw new Error("Financial account insert returned no row.");
      return row.id;
    }

    async function insertBillingAccount(
      partyRoleId: string,
      financialAccountId: string,
      billCycleId: string,
      name = "Test BAN",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
        VALUES (${name}, ${partyRoleId}, ${financialAccountId}, 'MYR', ${billCycleId}, ${appuserId})
        RETURNING billing_account_id AS id
      `;
      if (!row) throw new Error("Billing account insert returned no row.");
      return row.id;
    }

    test("the billing schema, its 10 module tables (+3 pgledger tables), and its 3 composition views (+3 pgledger views) exist", async () => {
      const schemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'billing'
      `;
      expect(schemas).toHaveLength(1);

      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'billing' AND table_type = 'BASE TABLE'
      `;
      expect(tables.map((t) => t.table_name).sort()).toEqual(
        [
          "financial_account",
          "billing_account",
          "bill_cycle",
          "reason_code",
          "document",
          "document_line",
          "ledger_binding",
          "gl_account",
          "gl_mapping",
          "accounting_period",
          "pgledger_accounts",
          "pgledger_transfers",
          "pgledger_entries",
        ].sort(),
      );

      const views = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.views WHERE table_schema = 'billing'
      `;
      expect(views.map((v) => v.table_name).sort()).toEqual(
        [
          "account_view",
          "gl_resolution_view",
          "gl_journal_view",
          "pgledger_accounts_view",
          "pgledger_transfers_view",
          "pgledger_entries_view",
        ].sort(),
      );
    });

    test("inserted FA/BAN/bill_cycle/gl_mapping/ledger_binding/document_line rows get the documented prefix-format ids", async () => {
      const organizationId = await insertOrganization("ID Format Org");
      const partyRoleId = await insertPartyRole(organizationId);
      const billCycleId = await insertBillCycle("ID Format Cycle");
      expect(billCycleId).toMatch(/^BCY\d{6}$/);

      const financialAccountId = await insertFinancialAccount(partyRoleId);
      expect(financialAccountId).toMatch(/^FIN\d{6}$/);

      const billingAccountId = await insertBillingAccount(
        partyRoleId,
        financialAccountId,
        billCycleId,
      );
      expect(billingAccountId).toMatch(/^BAN\d{6}$/);

      const [glAccountRow] = await sql<{ gl_code: string }[]>`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, last_edited_by)
        VALUES ('1000', 'Cash', 'asset', 'debit', ${appuserId})
        RETURNING gl_code
      `;
      expect(glAccountRow?.gl_code).toBe("1000");

      const [glMappingRow] = await sql<{ id: string }[]>`
        INSERT INTO billing.gl_mapping (selector_type, selector, ref_gl_code, last_edited_by)
        VALUES ('system_account', 'sys.cash.MYR', '1000', ${appuserId})
        RETURNING gl_mapping_id AS id
      `;
      expect(glMappingRow?.id).toMatch(/^GLM\d{6}$/);

      const [pgAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('id-format.test', 'MYR')
      `;
      const [ledgerBindingRow] = await sql<{ id: string }[]>`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('financial_account', ${financialAccountId}, 'unapplied_cash', ${pgAccount!.id}, ${appuserId})
        RETURNING ledger_binding_id AS id
      `;
      expect(ledgerBindingRow?.id).toMatch(/^LBD\d{6}$/);

      const reasonCodeId = await insertReasonCode("RC_ID_FORMAT");
      const [documentIdRow] = await sql<{ nextval: string }[]>`
        SELECT nextval('billing.document_pay_seq')::text AS nextval
      `;
      const documentId = "PAY" + documentIdRow!.nextval.padStart(8, "0");
      await sql`
        INSERT INTO billing.document
          (document_id, doc_type, ref_financial_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
        VALUES (${documentId}, 'PAY', ${financialAccountId}, ${reasonCodeId}, 'MYR', '10.00', 'ref-1', now(), ${appuserId}, ${appuserId})
      `;
      expect(documentId).toMatch(/^PAY\d{8}$/);

      const [documentLineRow] = await sql<{ id: string }[]>`
        INSERT INTO billing.document_line (ref_document_id, line_no, line_kind, amount, last_edited_by)
        VALUES (${documentId}, 1, 'capture', '10.00', ${appuserId})
        RETURNING document_line_id AS id
      `;
      expect(documentLineRow?.id).toMatch(/^DLN\d{8}$/);
    });

    test("a document insert per doc_type yields the right prefix from its own per-type sequence", async () => {
      const organizationId = await insertOrganization("Doc Type Org");
      const partyRoleId = await insertPartyRole(organizationId);
      const financialAccountId = await insertFinancialAccount(
        partyRoleId,
        "Doc Type FA",
      );
      const reasonCodeId = await insertReasonCode("RC_DOC_TYPE");

      const cases: Array<{ docType: string; seq: string; prefix: string }> = [
        { docType: "PAY", seq: "document_pay_seq", prefix: "PAY" },
        { docType: "DEP", seq: "document_dep_seq", prefix: "DEP" },
        { docType: "CRN", seq: "document_crn_seq", prefix: "CRN" },
        { docType: "DBN", seq: "document_dbn_seq", prefix: "DBN" },
        { docType: "ADJ", seq: "document_adj_seq", prefix: "ADJ" },
      ];

      for (const { docType, seq, prefix } of cases) {
        const [nextvalRow] = await sql.unsafe<{ nextval: string }[]>(
          `SELECT nextval('billing.${seq}')::text AS nextval`,
        );
        const documentId = prefix + nextvalRow!.nextval.padStart(8, "0");
        await sql`
          INSERT INTO billing.document
            (document_id, doc_type, ref_financial_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
          VALUES (${documentId}, ${docType}, ${financialAccountId}, ${reasonCodeId}, 'MYR', '5.00', 'ref', now(), ${appuserId}, ${appuserId})
        `;
        expect(documentId).toMatch(new RegExp(`^${prefix}\\d{8}$`));
      }
    });

    test("account_view fixture (headline): FA+BAN return with correct account_type and a composed relatedParty[]", async () => {
      const organizationId = await insertOrganization("Account View Org");
      const partyRoleId = await insertPartyRole(organizationId);
      const billCycleId = await insertBillCycle("Account View Cycle");
      const financialAccountId = await insertFinancialAccount(
        partyRoleId,
        "Account View FA",
      );
      const billingAccountId = await insertBillingAccount(
        partyRoleId,
        financialAccountId,
        billCycleId,
        "Account View BAN",
      );

      const rows = await sql<
        {
          account_id: string;
          account_type: string;
          name: string;
          related_party: Array<{
            id: string;
            role: string;
            name: string;
            "@referredType": string;
          }>;
        }[]
      >`
        SELECT account_id, account_type, name, related_party
        FROM billing.account_view
        WHERE account_id IN (${financialAccountId}, ${billingAccountId})
        ORDER BY account_type
      `;
      expect(rows).toHaveLength(2);

      const fa = rows.find((r) => r.account_id === financialAccountId);
      const ban = rows.find((r) => r.account_id === billingAccountId);
      expect(fa?.account_type).toBe("FinancialAccount");
      expect(ban?.account_type).toBe("BillingAccount");

      for (const row of [fa, ban]) {
        expect(row?.related_party).toHaveLength(1);
        const party = row!.related_party[0]!;
        expect(party.id).toBe(partyRoleId);
        expect(party.role).toBe("customer");
        expect(party.name).toBe("Account View Org");
        expect(party["@referredType"]).toBe("Customer");
      }
    });

    test("an invalid financial_account.state is rejected by the CHECK constraint (23514)", async () => {
      const organizationId = await insertOrganization("Check Violation Org");
      const partyRoleId = await insertPartyRole(organizationId);

      await expect(
        sql`
          INSERT INTO billing.financial_account (name, state, ref_party_role_id, currency, last_edited_by)
          VALUES ('Bad State FA', 'BOGUS', ${partyRoleId}, 'MYR', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23514" });
    });

    test("a second ledger_binding row for the same owner+role is rejected (23505); a different role for the same owner succeeds", async () => {
      const organizationId = await insertOrganization("Binding Dup Org");
      const partyRoleId = await insertPartyRole(organizationId);
      const financialAccountId = await insertFinancialAccount(
        partyRoleId,
        "Binding Dup FA",
      );

      const [firstAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('binding-dup.first', 'MYR')
      `;
      await sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('financial_account', ${financialAccountId}, 'unapplied_cash', ${firstAccount!.id}, ${appuserId})
      `;

      const [secondAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('binding-dup.second', 'MYR')
      `;
      await expect(
        sql`
          INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
          VALUES ('financial_account', ${financialAccountId}, 'unapplied_cash', ${secondAccount!.id}, ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23505" });

      const [thirdAccount] = await sql<{ id: string }[]>`
        SELECT id FROM billing.pgledger_create_account('binding-dup.third', 'MYR')
      `;
      await expect(
        sql`
          INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
          VALUES ('financial_account', ${financialAccountId}, 'deposits', ${thirdAccount!.id}, ${appuserId})
        `,
      ).resolves.toBeTruthy();
    });

    test("a duplicate document_line.pgledger_transfer_id is rejected (23505)", async () => {
      const organizationId = await insertOrganization("Transfer Dup Org");
      const partyRoleId = await insertPartyRole(organizationId);
      const financialAccountId = await insertFinancialAccount(
        partyRoleId,
        "Transfer Dup FA",
      );
      const reasonCodeId = await insertReasonCode("RC_TRANSFER_DUP");

      const [nextvalA] = await sql<{ nextval: string }[]>`
        SELECT nextval('billing.document_pay_seq')::text AS nextval
      `;
      const documentIdA = "PAY" + nextvalA!.nextval.padStart(8, "0");
      await sql`
        INSERT INTO billing.document
          (document_id, doc_type, ref_financial_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
        VALUES (${documentIdA}, 'PAY', ${financialAccountId}, ${reasonCodeId}, 'MYR', '10.00', 'ref-a', now(), ${appuserId}, ${appuserId})
      `;
      await sql`
        INSERT INTO billing.document_line (ref_document_id, line_no, line_kind, amount, pgledger_transfer_id, last_edited_by)
        VALUES (${documentIdA}, 1, 'capture', '10.00', 'pglt_dup_test', ${appuserId})
      `;

      const [nextvalB] = await sql<{ nextval: string }[]>`
        SELECT nextval('billing.document_pay_seq')::text AS nextval
      `;
      const documentIdB = "PAY" + nextvalB!.nextval.padStart(8, "0");
      await sql`
        INSERT INTO billing.document
          (document_id, doc_type, ref_financial_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
        VALUES (${documentIdB}, 'PAY', ${financialAccountId}, ${reasonCodeId}, 'MYR', '10.00', 'ref-b', now(), ${appuserId}, ${appuserId})
      `;
      await expect(
        sql`
          INSERT INTO billing.document_line (ref_document_id, line_no, line_kind, amount, pgledger_transfer_id, last_edited_by)
          VALUES (${documentIdB}, 1, 'capture', '10.00', 'pglt_dup_test', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23505" });
    });

    test("cross-schema FKs to a nonexistent customer.party_role and core.appuser are rejected", async () => {
      await expect(
        sql`
          INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
          VALUES ('Bad Party FA', 'PTRL99999999', 'MYR', ${appuserId})
        `,
      ).rejects.toThrow();

      const organizationId = await insertOrganization("Bad Appuser Org");
      const partyRoleId = await insertPartyRole(organizationId);
      await expect(
        sql`
          INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
          VALUES ('Bad Appuser FA', ${partyRoleId}, 'MYR', 'nonexistent-user-id')
        `,
      ).rejects.toThrow();
    });
  },
);
