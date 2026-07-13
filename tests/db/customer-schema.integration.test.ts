import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "customer schema integration (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let appuserId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      // "customer" holds FKs into "core" and "product" holds FKs into
      // "core" too, so both must drop before "core" (cm01-spec §3.7).
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
        VALUES ('test-user-cm01', 'Test User', 'test-user-cm01@example.com', 'LOCAL', 'ACTIVE')
        RETURNING user_id AS id
      `;
      if (!user) throw new Error("Test appuser insert returned no row.");
      appuserId = user.id;
    });

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    async function insertOrganization(
      name: string,
      registrationNumber: string | null = null,
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO customer.organization (name, organization_type, registration_number, last_modified_by)
        VALUES (${name}, 'COMPANY', ${registrationNumber}, ${appuserId})
        RETURNING organization_id AS id
      `;
      if (!row) throw new Error("Organization insert returned no row.");
      return row.id;
    }

    async function insertPartyRole(
      organizationId: string,
      status = "INITIALIZED",
    ): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
        VALUES (${organizationId}, ${status}, ${appuserId})
        RETURNING party_role_id AS id
      `;
      if (!row) throw new Error("Party role insert returned no row.");
      return row.id;
    }

    async function insertContactMedium(partyRoleId: string): Promise<string> {
      const [row] = await sql<{ id: string }[]>`
        INSERT INTO customer.contact_medium (ref_party_role, contact_name, last_modified_by)
        VALUES (${partyRoleId}, 'Test Contact', ${appuserId})
        RETURNING contact_medium_id AS id
      `;
      if (!row) throw new Error("Contact medium insert returned no row.");
      return row.id;
    }

    test("the customer schema, its 3 tables, and its 3 sequences exist", async () => {
      const schemas = await sql<{ schema_name: string }[]>`
        SELECT schema_name FROM information_schema.schemata WHERE schema_name = 'customer'
      `;
      expect(schemas).toHaveLength(1);

      const tables = await sql<{ table_name: string }[]>`
        SELECT c.relname AS table_name
        FROM pg_class c
        JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'customer' AND c.relkind = 'r'
      `;
      expect(tables.map((t) => t.table_name).sort()).toEqual(
        ["organization", "party_role", "contact_medium"].sort(),
      );

      const sequences = await sql<{ sequence_name: string }[]>`
        SELECT sequencename AS sequence_name FROM pg_sequences WHERE schemaname = 'customer'
      `;
      expect(sequences.map((s) => s.sequence_name).sort()).toEqual(
        ["organization_seq", "party_role_seq", "contact_medium_seq"].sort(),
      );
    });

    test("inserted rows get ORG/PTRL/CTMD-format IDs from the column defaults", async () => {
      const organizationId = await insertOrganization("ID Format Org");
      expect(organizationId).toMatch(/^ORG\d{7}$/);

      const partyRoleId = await insertPartyRole(organizationId);
      expect(partyRoleId).toMatch(/^PTRL\d{8}$/);

      const contactMediumId = await insertContactMedium(partyRoleId);
      expect(contactMediumId).toMatch(/^CTMD\d{8}$/);
    });

    test("a second non-closed party_role for the same organization fails; a second CLOSED row succeeds", async () => {
      const organizationId = await insertOrganization("Dup Role Org");
      await insertPartyRole(organizationId, "INITIALIZED");

      await expect(insertPartyRole(organizationId, "ACTIVE")).rejects.toThrow();

      await expect(
        insertPartyRole(organizationId, "CLOSED"),
      ).resolves.toBeTruthy();
    });

    test("a duplicate non-null registration_number fails; two NULL values both succeed", async () => {
      await insertOrganization("Reg Number Org A", "REG-DUP-001");
      await expect(
        insertOrganization("Reg Number Org B", "REG-DUP-001"),
      ).rejects.toThrow();

      await expect(
        insertOrganization("Null Reg Org A", null),
      ).resolves.toBeTruthy();
      await expect(
        insertOrganization("Null Reg Org B", null),
      ).resolves.toBeTruthy();
    });

    test("a party_role.contact_medium pointer to another party_role's contact fails; a pointer to its own contact succeeds", async () => {
      const orgA = await insertOrganization("Pointer Org A");
      const partyRoleA = await insertPartyRole(orgA);
      const contactA1 = await insertContactMedium(partyRoleA);

      const orgB = await insertOrganization("Pointer Org B");
      const partyRoleB = await insertPartyRole(orgB);
      await insertContactMedium(partyRoleB);

      await expect(
        sql`UPDATE customer.party_role SET contact_medium = ${contactA1} WHERE party_role_id = ${partyRoleB}`,
      ).rejects.toThrow();

      await expect(
        sql`UPDATE customer.party_role SET contact_medium = ${contactA1} WHERE party_role_id = ${partyRoleA}`,
      ).resolves.toBeTruthy();
    });

    test("invalid organization_type, organization.status, party_role.status, and preferred_contact_method values are each rejected", async () => {
      await expect(
        sql`
          INSERT INTO customer.organization (name, organization_type, last_modified_by)
          VALUES ('Bad Type Org', 'BOGUS', ${appuserId})
        `,
      ).rejects.toThrow();

      await expect(
        sql`
          INSERT INTO customer.organization (name, organization_type, status, last_modified_by)
          VALUES ('Bad Status Org', 'COMPANY', 'BOGUS', ${appuserId})
        `,
      ).rejects.toThrow();

      const organizationId = await insertOrganization("Bad Party Status Org");
      await expect(
        sql`
          INSERT INTO customer.party_role (engaged_party, status, last_modified_by)
          VALUES (${organizationId}, 'BOGUS', ${appuserId})
        `,
      ).rejects.toThrow();

      const partyRoleId = await insertPartyRole(organizationId);
      await expect(
        sql`
          INSERT INTO customer.contact_medium (ref_party_role, contact_name, preferred_contact_method, last_modified_by)
          VALUES (${partyRoleId}, 'Bad Method Contact', 'BOGUS', ${appuserId})
        `,
      ).rejects.toThrow();
    });

    test("last_modified_by referencing a nonexistent core.appuser row is rejected", async () => {
      await expect(
        sql`
          INSERT INTO customer.organization (name, organization_type, last_modified_by)
          VALUES ('Bad FK Org', 'COMPANY', 'nonexistent-user-id')
        `,
      ).rejects.toThrow();
    });

    test("the core.permissions row 'customers' exists after migration", async () => {
      const rows = await sql<{ permission_name: string }[]>`
        SELECT permission_name FROM core.permissions WHERE permission_name = 'customers'
      `;
      expect(rows).toHaveLength(1);
    });
  },
);
