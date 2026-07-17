import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { eq } from "drizzle-orm";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { partyRole } from "@/db/schema/customer";
import { systemConfig } from "@/db/schema/system-config";
import type { partyRoleRepository as PartyRoleRepository } from "@/db/repositories/party-role";
import type { createCustomer as CreateCustomer } from "@/services/customer/create-customer";
import type { addContact as AddContact } from "@/services/customer/contact-mutations";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// cm11-spec §3.8's named guardrail — the first real exercise of cm01's
// composite deferrable FK end to end through the service (not just raw SQL
// as cm01's own test already did).
describe.skipIf(!databaseUrl)("add contact (requires DATABASE_URL)", () => {
  let sql: postgresjs.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let createCustomer: typeof CreateCustomer;
  let addContact: typeof AddContact;
  let partyRoleRepository: typeof PartyRoleRepository;
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

    ({ createCustomer } = await import("@/services/customer/create-customer"));
    ({ addContact } = await import("@/services/customer/contact-mutations"));
    ({ partyRoleRepository } = await import("@/db/repositories/party-role"));

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

  async function makeCustomer(): Promise<{
    organizationId: string;
    partyRoleId: string;
  }> {
    const created = await createCustomer(
      {
        name: `Add Contact Test ${randomUUID()}`,
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
    return created.value;
  }

  it("adding a contact to a brand-new customer (zero contacts) points party_role.contact_medium at the new row and the composite FK holds", async () => {
    const { partyRoleId } = await makeCustomer();

    const [before] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, partyRoleId));

    const result = await addContact(
      {
        partyRoleId,
        lastModifiedDatetime: before!.lastModifiedDatetime,
        contactName: "First Contact",
        contactRole: null,
        phoneNumber: "555-0100",
        emailAddress: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateProvince: null,
        postalCode: null,
        country: null,
      },
      actorUserId,
    );
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok:true");

    const [after] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, partyRoleId));
    expect(after?.contactMedium).toBe(result.value.contactMediumId);
  });

  it("a party_role.contact_medium pointer to a contact owned by a different party role is structurally impossible — the composite FK rejects it", async () => {
    const customerA = await makeCustomer();
    const customerB = await makeCustomer();

    const [beforeA] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, customerA.partyRoleId));

    const addResult = await addContact(
      {
        partyRoleId: customerA.partyRoleId,
        lastModifiedDatetime: beforeA!.lastModifiedDatetime,
        contactName: "Customer A Contact",
        contactRole: null,
        phoneNumber: null,
        emailAddress: null,
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateProvince: null,
        postalCode: null,
        country: null,
      },
      actorUserId,
    );
    expect(addResult.ok).toBe(true);
    if (!addResult.ok) throw new Error("expected ok:true");

    // Attempting to point customer B's preferred-contact pointer at
    // customer A's contact row bypasses the service entirely (no code
    // path in this module ever constructs this) — the composite
    // deferrable FK to `(contact_medium_id, ref_party_role)` is what makes
    // it a DB-level impossibility, re-confirmed here through the same
    // repository function the service calls, not just raw SQL.
    await expect(
      partyRoleRepository.setPreferredContact(
        db,
        customerB.partyRoleId,
        addResult.value.contactMediumId,
      ),
    ).rejects.toThrow();
  });
});
