import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, count, eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { organization, partyRole } from "@/db/schema/customer";
import { systemConfig } from "@/db/schema/system-config";
import type { createCustomer as CreateCustomer } from "@/services/customer/create-customer";
import type { searchCustomers as SearchCustomers } from "@/services/customer/search-customers";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// Exercises the real `createCustomer` service (its own internal
// `@/db/client` pool, not the local `db` connection below) against a live
// Postgres database — imported dynamically inside `beforeAll`, after
// confirming `DATABASE_URL` is set, mirroring
// tests/services/users-write.service.integration.test.ts so the eager
// `@/lib/config` validation in its import graph never runs when this suite
// is skipped (cm07-spec §3.9).
describe.skipIf(!databaseUrl)(
  "createCustomer service (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createCustomer: typeof CreateCustomer;
    let searchCustomers: typeof SearchCustomers;
    let actorUserId: string;

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 1 });
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      db = drizzle(sql, { schema });
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });

      ({ createCustomer } =
        await import("@/services/customer/create-customer"));
      ({ searchCustomers } =
        await import("@/services/customer/search-customers"));

      actorUserId = randomUUID();
      await db.insert(appuser).values({
        id: actorUserId,
        userName: "Acting Manager",
        userEmail: `${actorUserId}@example.com`,
        emailVerified: false,
        authMethod: "LOCAL",
        status: "ACTIVE",
      });

      await db.insert(systemConfig).values({
        configGroup: "customer",
        configVersion: 1,
        configKey: "CUSTOMER_SEARCH_RESULT_LIMIT",
        configValue: "5",
        description: "Max rows returned by a Customer search.",
        isSecret: false,
        status: "ACTIVE",
        modifiedBy: null,
      });
    }, 30_000);

    afterAll(async () => {
      await sql.unsafe('DROP SCHEMA IF EXISTS "customer" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "product" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "core" CASCADE');
      await sql.unsafe('DROP SCHEMA IF EXISTS "drizzle" CASCADE');
      await sql.end();
    });

    it("creates an organization + party role at REGISTERED/INITIALIZED with human-readable IDs, writes both audit rows, and is immediately searchable", async () => {
      const result = await createCustomer(
        {
          name: "Integration Test Org",
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-${randomUUID()}`,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: true,
        },
        actorUserId,
      );

      expect(result.ok).toBe(true);
      if (!result.ok) throw new Error("expected ok:true");

      expect(result.value.organizationId).toMatch(/^ORG\d{7}$/);
      expect(result.value.partyRoleId).toMatch(/^PTRL\d{8}$/);

      const [orgRow] = await db
        .select()
        .from(organization)
        .where(eq(organization.organizationId, result.value.organizationId));
      expect(orgRow?.status).toBe("REGISTERED");

      const [roleRow] = await db
        .select()
        .from(partyRole)
        .where(eq(partyRole.partyRoleId, result.value.partyRoleId));
      expect(roleRow?.status).toBe("INITIALIZED");

      const orgAudit = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, "ORGANIZATION_CREATED"),
            eq(auditLog.targetId, result.value.organizationId),
          ),
        );
      expect(orgAudit).toHaveLength(1);
      expect(orgAudit[0]?.targetEntity).toBe("ORGANIZATION");

      const roleAudit = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, "CUSTOMER_CREATED"),
            eq(auditLog.targetId, result.value.partyRoleId),
          ),
        );
      expect(roleAudit).toHaveLength(1);
      expect(roleAudit[0]?.targetEntity).toBe("PARTY_ROLE");

      const searchResults = await searchCustomers("Integration Test Org");
      expect(
        searchResults.results.some(
          (row) => row.partyRoleId === result.value.partyRoleId,
        ),
      ).toBe(true);
    });

    it("a second create with the same registration_number fails with DUPLICATE_REGISTRATION_NUMBER and leaves no partial rows", async () => {
      const registrationNumber = `REG-${randomUUID()}`;

      const first = await createCustomer(
        {
          name: "Duplicate Reg First",
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: true,
        },
        actorUserId,
      );
      expect(first.ok).toBe(true);

      const [orgCountBeforeRow] = await db
        .select({ value: count() })
        .from(organization);
      const [roleCountBeforeRow] = await db
        .select({ value: count() })
        .from(partyRole);
      const orgCountBefore = orgCountBeforeRow!.value;
      const roleCountBefore = roleCountBeforeRow!.value;

      const second = await createCustomer(
        {
          name: "Duplicate Reg Second",
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: true,
        },
        actorUserId,
      );

      expect(second).toEqual({
        ok: false,
        code: "DUPLICATE_REGISTRATION_NUMBER",
      });

      const [orgCountAfterRow] = await db
        .select({ value: count() })
        .from(organization);
      const [roleCountAfterRow] = await db
        .select({ value: count() })
        .from(partyRole);
      const orgCountAfter = orgCountAfterRow!.value;
      const roleCountAfter = roleCountAfterRow!.value;

      expect(orgCountAfter).toBe(orgCountBefore);
      expect(roleCountAfter).toBe(roleCountBefore);
    });
  },
);
