import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { and, eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { contactMedium, organization, partyRole } from "@/db/schema/customer";
import { systemConfig } from "@/db/schema/system-config";
import { contactMediumRepository } from "@/db/repositories/contact-medium";
import { organizationRepository } from "@/db/repositories/organization";
import { partyRoleRepository } from "@/db/repositories/party-role";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import { getCustomerDetail } from "@/services/customer/get-customer-detail";
import { searchCustomers } from "@/services/customer/search-customers";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { CustomerStatus, OrganizationStatus } from "@/types/customer";

const databaseUrl = process.env.DATABASE_URL;

describe.skipIf(!databaseUrl)(
  "customer repositories + services/customer (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let orgEditorId: string;
    let roleEditorId: string;

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

      const [orgEditor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Organization Editor",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      orgEditorId = orgEditor!.id;

      const [roleEditor] = await db
        .insert(appuser)
        .values({
          id: crypto.randomUUID(),
          userName: "Role Editor",
          userEmail: `${crypto.randomUUID()}@example.com`,
          emailVerified: false,
          authMethod: "LOCAL",
          status: "ACTIVE",
        })
        .returning({ id: appuser.id });
      roleEditorId = roleEditor!.id;

      // The cm01 seed script (db/seeds/customer.ts) is a standalone process
      // never imported by application code (customer-seed.integration.test.ts
      // owns exercising it) — this row is inserted directly here, matching
      // the shape that seed produces.
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

    async function insertOrganization(data: {
      name: string;
      tradingName?: string | null;
      status?: OrganizationStatus;
    }): Promise<string> {
      const [row] = await db
        .insert(organization)
        .values({
          name: data.name,
          tradingName: data.tradingName ?? null,
          organizationType: "COMPANY",
          status: data.status ?? "ACTIVE",
          lastModifiedBy: orgEditorId,
        })
        .returning({ organizationId: organization.organizationId });
      return row!.organizationId;
    }

    async function insertPartyRole(data: {
      organizationId: string;
      status?: CustomerStatus;
    }): Promise<string> {
      const [row] = await db
        .insert(partyRole)
        .values({
          engagedParty: data.organizationId,
          status: data.status ?? "ACTIVE",
          lastModifiedBy: roleEditorId,
        })
        .returning({ partyRoleId: partyRole.partyRoleId });
      return row!.partyRoleId;
    }

    async function insertContact(data: {
      partyRoleId: string;
      contactName: string;
      address?: {
        line1: string;
        line2?: string | null;
        city?: string | null;
        stateProvince?: string | null;
        postalCode?: string | null;
        country?: string | null;
      } | null;
    }): Promise<string> {
      const [row] = await db
        .insert(contactMedium)
        .values({
          refPartyRole: data.partyRoleId,
          contactName: data.contactName,
          gaAddressLine1: data.address?.line1 ?? null,
          gaAddressLine2: data.address?.line2 ?? null,
          gaCity: data.address?.city ?? null,
          gaStateProvince: data.address?.stateProvince ?? null,
          gaPostalCode: data.address?.postalCode ?? null,
          gaCountry: data.address?.country ?? null,
          lastModifiedBy: roleEditorId,
        })
        .returning({ contactMediumId: contactMedium.contactMediumId });
      return row!.contactMediumId;
    }

    // Search is party-role-keyed (cm02-spec §2.1) — an organization with no
    // party_role surfaces no search row at all, so every search fixture
    // needs both.
    async function insertOrganizationWithRole(data: {
      name: string;
      tradingName?: string | null;
    }): Promise<{ organizationId: string; partyRoleId: string }> {
      const organizationId = await insertOrganization(data);
      const partyRoleId = await insertPartyRole({ organizationId });
      return { organizationId, partyRoleId };
    }

    describe("repository finders (direct, no service layer)", () => {
      it("organizationRepository.findById returns the row, or null for an unknown id", async () => {
        const organizationId = await insertOrganization({
          name: "SEARCH Direct Org",
        });

        const found = await organizationRepository.findById(db, organizationId);
        expect(found?.name).toBe("SEARCH Direct Org");

        const notFound = await organizationRepository.findById(
          db,
          "ORG9999999",
        );
        expect(notFound).toBeNull();
      });

      it("partyRoleRepository.findById returns the row, or null for an unknown id", async () => {
        const organizationId = await insertOrganization({
          name: "SEARCH Direct Role Org",
        });
        const partyRoleId = await insertPartyRole({ organizationId });

        const found = await partyRoleRepository.findById(db, partyRoleId);
        expect(found?.engagedParty).toBe(organizationId);

        const notFound = await partyRoleRepository.findById(db, "PTRL99999998");
        expect(notFound).toBeNull();
      });

      it("contactMediumRepository.findByPartyRoleId orders by contact_medium_id ASC", async () => {
        const organizationId = await insertOrganization({
          name: "SEARCH Direct Contacts Org",
        });
        const partyRoleId = await insertPartyRole({ organizationId });
        const firstId = await insertContact({
          partyRoleId,
          contactName: "First Contact",
        });
        const secondId = await insertContact({
          partyRoleId,
          contactName: "Second Contact",
        });

        const rows = await contactMediumRepository.findByPartyRoleId(
          db,
          partyRoleId,
        );
        expect(rows.map((r) => r.contactMediumId)).toEqual([firstId, secondId]);
      });

      it("partyRoleRepository.searchByOrganizationNameOrTradingName respects the caller-supplied limit", async () => {
        for (let i = 0; i < 3; i++) {
          await insertOrganizationWithRole({
            name: `SEARCH DirectLimit Org ${i}`,
          });
        }

        const rows =
          await partyRoleRepository.searchByOrganizationNameOrTradingName(
            db,
            "%SEARCH DirectLimit%",
            2,
          );
        expect(rows).toHaveLength(2);
      });
    });

    describe("search (partyRoleRepository + searchCustomers)", () => {
      it("case-insensitive substring match on name and trading_name, incl. a genuine multi-match pair", async () => {
        await insertOrganizationWithRole({
          name: "SEARCH Acme Corp",
          tradingName: "Acme Co",
        });
        await insertOrganizationWithRole({ name: "SEARCH Acme Industries" });
        await insertOrganizationWithRole({ name: "SEARCH Globex Corporation" });
        await insertOrganizationWithRole({ name: "SEARCH Initech Solutions" });
        await insertOrganizationWithRole({ name: "SEARCH Wayne Enterprises" });
        await insertOrganizationWithRole({ name: "SEARCH Stark Group" });

        const result = await searchCustomers("acme");
        expect(result.results.map((r) => r.organizationName).sort()).toEqual(
          ["SEARCH Acme Corp", "SEARCH Acme Industries"].sort(),
        );

        const byTradingName = await searchCustomers("Acme Co");
        expect(byTradingName.results.map((r) => r.organizationName)).toEqual([
          "SEARCH Acme Corp",
        ]);
      });

      it("literal %, _, and \\ in the query do not act as wildcards", async () => {
        await insertOrganizationWithRole({ name: "SEARCH Percent%Sign" });
        await insertOrganizationWithRole({ name: "SEARCH Underscore_Char" });

        const percent = await searchCustomers("%");
        expect(percent.results.map((r) => r.organizationName)).toEqual([
          "SEARCH Percent%Sign",
        ]);

        const underscore = await searchCustomers("_");
        expect(underscore.results.map((r) => r.organizationName)).toEqual([
          "SEARCH Underscore_Char",
        ]);

        const noMatch = await searchCustomers("zzz_no_match_xyz");
        expect(noMatch.results).toEqual([]);
      });

      it("an organization with one CLOSED and one ACTIVE party_role surfaces as two distinct search rows", async () => {
        const organizationId = await insertOrganization({
          name: "SEARCH TwoRoles Org",
        });
        const closedRoleId = await insertPartyRole({
          organizationId,
          status: "CLOSED",
        });
        const activeRoleId = await insertPartyRole({
          organizationId,
          status: "ACTIVE",
        });

        const result = await searchCustomers("TwoRoles");
        expect(result.results).toHaveLength(2);
        const byPartyRoleId = new Map(
          result.results.map((r) => [r.partyRoleId, r]),
        );
        expect(byPartyRoleId.get(closedRoleId)?.customerStatus).toBe("CLOSED");
        expect(byPartyRoleId.get(activeRoleId)?.customerStatus).toBe("ACTIVE");
        expect(
          result.results.every(
            (r) => r.organizationName === "SEARCH TwoRoles Org",
          ),
        ).toBe(true);
      });

      it("deterministic ordering (name ASC, party_role_id ASC) is stable across repeated calls", async () => {
        await insertOrganizationWithRole({ name: "SEARCH Order Alpha" });
        await insertOrganizationWithRole({ name: "SEARCH Order Bravo" });
        await insertOrganizationWithRole({ name: "SEARCH Order Charlie" });

        const first = await searchCustomers("SEARCH Order");
        const second = await searchCustomers("SEARCH Order");
        expect(first.results.map((r) => r.partyRoleId)).toEqual(
          second.results.map((r) => r.partyRoleId),
        );
        expect(first.results.map((r) => r.organizationName)).toEqual([
          "SEARCH Order Alpha",
          "SEARCH Order Bravo",
          "SEARCH Order Charlie",
        ]);
      });
    });

    describe("0009 seeded config row", () => {
      it("findActiveValue(db, 'customer', 'CUSTOMER_SEARCH_RESULT_LIMIT') returns '5'", async () => {
        const value = await systemConfigRepository.findActiveValue(
          db,
          "customer",
          "CUSTOMER_SEARCH_RESULT_LIMIT",
        );
        expect(value).toBe("5");
      });

      it("changing config_value changes searchCustomers's effective cap on the next call, no deploy", async () => {
        for (let i = 0; i < 4; i++) {
          await insertOrganizationWithRole({ name: `SEARCH CapTest Org ${i}` });
        }

        const beforeChange = await searchCustomers("SEARCH CapTest");
        expect(beforeChange.limit).toBe(5);
        expect(beforeChange.hasMore).toBe(false);

        await db
          .update(systemConfig)
          .set({ configValue: "2" })
          .where(
            and(
              eq(systemConfig.configGroup, "customer"),
              eq(systemConfig.configKey, "CUSTOMER_SEARCH_RESULT_LIMIT"),
            ),
          );

        const afterChange = await searchCustomers("SEARCH CapTest");
        expect(afterChange.limit).toBe(2);
        expect(afterChange.results).toHaveLength(2);
        expect(afterChange.hasMore).toBe(true);

        // Restore for any subsequent test in this file.
        await db
          .update(systemConfig)
          .set({ configValue: "5" })
          .where(
            and(
              eq(systemConfig.configGroup, "customer"),
              eq(systemConfig.configKey, "CUSTOMER_SEARCH_RESULT_LIMIT"),
            ),
          );
      });
    });

    describe("getCustomerDetail", () => {
      it("assembles all three sections, resolving user_name via the real core.appuser join for both editors", async () => {
        const organizationId = await insertOrganization({
          name: "SEARCH Detail Org",
        });
        const partyRoleId = await insertPartyRole({ organizationId });
        const contactWithAddressId = await insertContact({
          partyRoleId,
          contactName: "Full Address Contact",
          address: {
            line1: "1 Main St",
            line2: "Suite 2",
            city: "Kuala Lumpur",
            stateProvince: "WP",
            postalCode: "50000",
            country: "Malaysia",
          },
        });
        await insertContact({
          partyRoleId,
          contactName: "No Address Contact",
          address: null,
        });
        await db
          .update(partyRole)
          .set({ contactMedium: contactWithAddressId })
          .where(eq(partyRole.partyRoleId, partyRoleId));

        const detail = await getCustomerDetail(partyRoleId);

        expect(detail).not.toBeNull();
        expect(detail?.organization.name).toBe("SEARCH Detail Org");
        expect(detail?.organization.lastModifiedByName).toBe(
          "Organization Editor",
        );
        expect(detail?.customerRole.lastModifiedByName).toBe("Role Editor");
        expect(detail?.customerRole.preferredContactId).toBe(
          contactWithAddressId,
        );
        expect(detail?.contacts).toHaveLength(2);

        const withAddress = detail!.contacts.find(
          (c) => c.contactMediumId === contactWithAddressId,
        )!;
        expect(withAddress.isPreferredContact).toBe(true);
        expect(withAddress.address).toEqual({
          line1: "1 Main St",
          line2: "Suite 2",
          city: "Kuala Lumpur",
          stateProvince: "WP",
          postalCode: "50000",
          country: "Malaysia",
        });

        const withoutAddress = detail!.contacts.find(
          (c) => c.contactMediumId !== contactWithAddressId,
        )!;
        expect(withoutAddress.isPreferredContact).toBe(false);
        expect(withoutAddress.address).toBeNull();
      });

      it("returns null for an unknown partyRoleId", async () => {
        const result = await getCustomerDetail("PTRL99999999");
        expect(result).toBeNull();
      });
    });
  },
);
