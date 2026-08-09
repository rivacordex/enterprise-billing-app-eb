import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// ac02-spec §3.7. Fresh-migrates onto ac01 (the pgledger fork) and asserts
// the 10 module tables + 3 composition views this unit ships. No
// application repositories are used for the write paths this test needs
// but doesn't yet have implemented (document insert, FA/BAN insert) — those
// are ac05/ac07 seams (§2.6) — so fixture setup goes through raw SQL, same
// convention as customer-schema.integration.test.ts / product-schema.
// integration.test.ts.
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

    async function insertCustomerFixture(name: string): Promise<{
      organizationId: string;
      partyRoleId: string;
    }> {
      const organizationId = await insertOrganization(name);
      const partyRoleId = await insertPartyRole(organizationId);
      return { organizationId, partyRoleId };
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

    async function insertFinancialAccount(
      partyRoleId: string,
      currency = "MYR",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.financial_account
          (name, ref_party_role_id, currency, last_edited_by)
        VALUES ('Test FA', ${partyRoleId}, ${currency}, ${appuserId})
        RETURNING financial_account_id AS id
      `;
      if (!row) throw new Error("Financial account insert returned no row.");
      return row.id;
    }

    async function insertBillingAccount(
      partyRoleId: string,
      financialAccountId: string,
      billCycleId: string,
      currency = "MYR",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.billing_account
          (name, ref_party_role_id, ref_financial_account_id, currency, ref_bill_cycle_id, last_edited_by)
        VALUES ('Test BAN', ${partyRoleId}, ${financialAccountId}, ${currency}, ${billCycleId}, ${appuserId})
        RETURNING billing_account_id AS id
      `;
      if (!row) throw new Error("Billing account insert returned no row.");
      return row.id;
    }

    async function insertReasonCode(
      reasonCode: string,
      docType: string,
      postingNature: string,
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO billing.reason_code (reason_code, doc_type, posting_nature, last_edited_by)
        VALUES (${reasonCode}, ${docType}, ${postingNature}, ${appuserId})
        RETURNING reason_code AS id
      `;
      if (!row) throw new Error("Reason code insert returned no row.");
      return row.id;
    }

    // Mirrors the per-type sequence assembler the future insert repository
    // owns (ac02-spec §2.2/§2.6, document.repository.ts) — the DB column
    // itself has no default for exactly this reason.
    const DOC_TYPE_SEQUENCES: Record<string, string> = {
      PAY: "document_pay_seq",
      DEP: "document_dep_seq",
      CRN: "document_crn_seq",
      DBN: "document_dbn_seq",
      ADJ: "document_adj_seq",
    };

    async function nextDocumentId(docType: string): Promise<string> {
      const seqName = DOC_TYPE_SEQUENCES[docType];
      if (!seqName) throw new Error(`Unknown doc_type ${docType}`);
      const [row] = await sql<{ n: string }[]>`
        SELECT nextval(${"billing." + seqName}) AS n
      `;
      if (!row) throw new Error("nextval returned no row.");
      return `${docType}${row.n.padStart(8, "0")}`;
    }

    test("the billing schema's 10 module tables and 3 composition views exist alongside ac01's pgledger objects", async () => {
      const tables = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'billing' AND table_type = 'BASE TABLE'
      `;
      const tableNames = tables.map((t) => t.table_name);
      expect(tableNames).toEqual(
        expect.arrayContaining([
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
        ]),
      );

      const views = await sql<{ table_name: string }[]>`
        SELECT table_name FROM information_schema.views WHERE table_schema = 'billing'
      `;
      expect(views.map((v) => v.table_name)).toEqual(
        expect.arrayContaining([
          "account_view",
          "gl_resolution_view",
          "gl_journal_view",
        ]),
      );
    });

    test("inserted FA/BAN rows get FIN000001/BAN000001-format ids from their column defaults", async () => {
      const { partyRoleId } = await insertCustomerFixture("Id Format Org");
      const billCycleId = await insertBillCycle("Id Format Cycle");

      const faId = await insertFinancialAccount(partyRoleId);
      expect(faId).toMatch(/^FIN\d{8}$/);

      const banId = await insertBillingAccount(partyRoleId, faId, billCycleId);
      expect(banId).toMatch(/^BAN\d{8}$/);
    });

    test("a document insert per doc_type yields the right prefix from its per-type sequence", async () => {
      const { partyRoleId } = await insertCustomerFixture("Doc Seq Org");
      const faId = await insertFinancialAccount(partyRoleId);

      for (const docType of ["PAY", "DEP", "CRN", "DBN", "ADJ"] as const) {
        const reasonCode = `TEST_${docType}`;
        await insertReasonCode(reasonCode, docType, "revenue");
        const documentId = await nextDocumentId(docType);
        expect(documentId).toMatch(new RegExp(`^${docType}\\d{8}$`));

        const [row] = await sql<{ id: string }[]>`
          INSERT INTO billing.document
            (document_id, doc_type, ref_financial_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
          VALUES (${documentId}, ${docType}, ${faId}, ${reasonCode}, 'MYR', '10.00', 'ref', now(), ${appuserId}, ${appuserId})
          RETURNING document_id AS id
        `;
        expect(row?.id).toBe(documentId);
      }
    });

    test("account_view fixture (headline): FA + BAN rows compose the correct account_type and relatedParty[] shape", async () => {
      const { partyRoleId, organizationId } =
        await insertCustomerFixture("Account View Org");
      const [org] = await sql<{ name: string }[]>`
        SELECT name FROM customer.organization WHERE organization_id = ${organizationId}
      `;
      const billCycleId = await insertBillCycle("Account View Cycle");
      const faId = await insertFinancialAccount(partyRoleId);
      const banId = await insertBillingAccount(partyRoleId, faId, billCycleId);

      const rows = await sql<
        {
          account_id: string;
          account_type: string;
          related_party: { id: string; role: string; name: string }[];
        }[]
      >`
        SELECT account_id, account_type, related_party
        FROM billing.account_view
        WHERE account_id IN (${faId}, ${banId})
        ORDER BY account_type
      `;
      expect(rows).toHaveLength(2);

      const faRow = rows.find((r) => r.account_id === faId);
      const banRow = rows.find((r) => r.account_id === banId);
      expect(faRow?.account_type).toBe("FinancialAccount");
      expect(banRow?.account_type).toBe("BillingAccount");

      for (const row of [faRow, banRow]) {
        expect(row?.related_party).toHaveLength(1);
        const relatedParty = row!.related_party[0]!;
        expect(relatedParty).toMatchObject({
          id: partyRoleId,
          role: "customer",
          name: org?.name,
        });
        expect(relatedParty).toHaveProperty("@referredType", "Customer");
      }
    });

    test("financial_account.state CHECK rejects an invalid value (23514)", async () => {
      const { partyRoleId } = await insertCustomerFixture("Check Org");
      await expect(
        sql`
          INSERT INTO billing.financial_account (name, state, ref_party_role_id, currency, last_edited_by)
          VALUES ('Bad State FA', 'bogus', ${partyRoleId}, 'MYR', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23514" });
    });

    test("ledger_binding rejects a second row for the same owner+role (23505, Module Inv. #9)", async () => {
      const { partyRoleId } = await insertCustomerFixture("Ledger Binding Org");
      const faId = await insertFinancialAccount(partyRoleId);

      await sql`
        INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
        VALUES ('financial_account', ${faId}, 'unapplied_cash', 'pgla_test_1', ${appuserId})
      `;

      await expect(
        sql`
          INSERT INTO billing.ledger_binding (owner_type, owner_id, ledger_role, pgledger_account_id, last_edited_by)
          VALUES ('financial_account', ${faId}, 'unapplied_cash', 'pgla_test_2', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23505" });
    });

    test("document_line rejects a duplicate pgledger_transfer_id (23505, Module Inv. #7)", async () => {
      const { partyRoleId } = await insertCustomerFixture("Doc Line Org");
      const faId = await insertFinancialAccount(partyRoleId);
      const reasonCode = "TEST_DLN";
      await insertReasonCode(reasonCode, "PAY", "revenue");
      const documentId = await nextDocumentId("PAY");
      await sql`
        INSERT INTO billing.document
          (document_id, doc_type, ref_financial_account_id, reason_code, currency, total_amount, reference_info, event_at, created_by, last_edited_by)
        VALUES (${documentId}, 'PAY', ${faId}, ${reasonCode}, 'MYR', '10.00', 'ref', now(), ${appuserId}, ${appuserId})
      `;

      await sql`
        INSERT INTO billing.document_line
          (ref_document_id, line_no, line_kind, amount, pgledger_transfer_id, last_edited_by)
        VALUES (${documentId}, 1, 'capture', '10.00', 'pglt_test_1', ${appuserId})
      `;

      await expect(
        sql`
          INSERT INTO billing.document_line
            (ref_document_id, line_no, line_kind, amount, pgledger_transfer_id, last_edited_by)
          VALUES (${documentId}, 2, 'capture', '10.00', 'pglt_test_1', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23505" });
    });

    test("gl_mapping rejects a second all-currency mapping for the same selector (23505, NULLS NOT DISTINCT)", async () => {
      const [glCode] = await sql<{ gl_code: string }[]>`
        INSERT INTO billing.gl_account (gl_code, name, account_class, normal_balance, is_postable, last_edited_by)
        VALUES ('9100', 'Test GL Mapping Target', 'asset', 'debit', true, ${appuserId})
        RETURNING gl_code
      `;
      if (!glCode) throw new Error("gl_account insert returned no row.");

      await sql`
        INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code, last_edited_by)
        VALUES ('ledger_role', 'test_dup_role', NULL, '9100', ${appuserId})
      `;

      await expect(
        sql`
          INSERT INTO billing.gl_mapping (selector_type, selector, currency, ref_gl_code, last_edited_by)
          VALUES ('ledger_role', 'test_dup_role', NULL, '9100', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23505" });
    });

    test("cross-schema FK to a nonexistent party_role and a nonexistent appuser are both rejected (23503)", async () => {
      await expect(
        sql`
          INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
          VALUES ('Bad Party FA', 'PTRL99999999', 'MYR', ${appuserId})
        `,
      ).rejects.toMatchObject({ code: "23503" });

      const { partyRoleId } = await insertCustomerFixture("Bad Appuser Org");
      await expect(
        sql`
          INSERT INTO billing.financial_account (name, ref_party_role_id, currency, last_edited_by)
          VALUES ('Bad Appuser FA', ${partyRoleId}, 'MYR', 'nonexistent-user-id')
        `,
      ).rejects.toMatchObject({ code: "23503" });
    });
  },
);
