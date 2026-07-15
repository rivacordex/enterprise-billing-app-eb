import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { auditLog } from "@/db/schema/audit";
import { organization, partyRole } from "@/db/schema/customer";
import { systemConfig } from "@/db/schema/system-config";
import type { createCustomer as CreateCustomer } from "@/services/customer/create-customer";
import type { updateOrganization as UpdateOrganization } from "@/services/customer/update-organization";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// cm08-spec §3.8's named guardrail — proves the compare-and-bump primitive
// (Module Inv. #6) actually rejects a stale save against a live database,
// not just mocked repositories. Imports both services dynamically inside
// `beforeAll`, after confirming `DATABASE_URL` is set, mirroring
// tests/db/create-customer.integration.test.ts so the eager `@/lib/config`
// validation in their import graph never runs when this suite is skipped.
describe.skipIf(!databaseUrl)(
  "optimistic-lock conflict (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createCustomer: typeof CreateCustomer;
    let updateOrganization: typeof UpdateOrganization;
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
      ({ updateOrganization } =
        await import("@/services/customer/update-organization"));

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

    it("a stale second save is rejected with CONFLICT; the first editor's change survives; exactly one ORGANIZATION_UPDATED audit row exists", async () => {
      const created = await createCustomer(
        {
          name: "Two Editors Inc",
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
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("expected ok:true");

      const { organizationId, partyRoleId } = created.value;

      // Both editors "open" the customer, loading the same lock value.
      const [initialRoleRow] = await db
        .select()
        .from(partyRole)
        .where(eq(partyRole.partyRoleId, partyRoleId));
      const staleLock = initialRoleRow!.lastModifiedDatetime;

      // Editor A saves successfully — the lock bumps.
      const editorA = await updateOrganization(
        {
          organizationId,
          partyRoleId,
          lastModifiedDatetime: staleLock,
          name: "Editor A's Name",
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-A-${randomUUID()}`,
          taxId: null,
          industry: null,
        },
        actorUserId,
      );
      expect(editorA.ok).toBe(true);

      // Editor B, still holding the original stale lock, attempts to save.
      const editorB = await updateOrganization(
        {
          organizationId,
          partyRoleId,
          lastModifiedDatetime: staleLock,
          name: "Editor B's Name",
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-B-${randomUUID()}`,
          taxId: null,
          industry: null,
        },
        actorUserId,
      );

      expect(editorB).toEqual({ ok: false, code: "CONFLICT" });

      const [orgRow] = await db
        .select()
        .from(organization)
        .where(eq(organization.organizationId, organizationId));
      expect(orgRow?.name).toBe("Editor A's Name");

      const updateAudits = await db
        .select()
        .from(auditLog)
        .where(
          and(
            eq(auditLog.eventType, "ORGANIZATION_UPDATED"),
            eq(auditLog.targetId, organizationId),
          ),
        );
      expect(updateAudits).toHaveLength(1);
    });
  },
);
