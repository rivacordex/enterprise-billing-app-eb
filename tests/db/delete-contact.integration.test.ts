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
import { contactMedium, partyRole } from "@/db/schema/customer";
import { systemConfig } from "@/db/schema/system-config";
import type { createCustomer as CreateCustomer } from "@/services/customer/create-customer";
import type {
  addContact as AddContact,
  deleteContact as DeleteContact,
} from "@/services/customer/contact-mutations";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// cm13-spec §3.6's "Integration" bullet — a direct call against the
// preferred contact is still rejected server-side, proving the UI's
// button-omission (cm13-spec §3.5) is a UX nicety, not the actual boundary.
// Calls the service directly, same testing boundary every prior mutation
// integration test in this module uses (`addContact`, `updateOrganization`,
// etc.) — no action in `actions/customer/**` is exercised directly by any
// integration test in this module, since `requirePermission` needs a real
// session this suite doesn't construct.
describe.skipIf(!databaseUrl)("delete contact (requires DATABASE_URL)", () => {
  let sql: postgresjs.Sql;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let createCustomer: typeof CreateCustomer;
  let addContact: typeof AddContact;
  let deleteContact: typeof DeleteContact;
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
    ({ addContact, deleteContact } =
      await import("@/services/customer/contact-mutations"));

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
        name: `Delete Contact Test ${randomUUID()}`,
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

  it("a direct call to delete the preferred contact is rejected server-side, and the row survives", async () => {
    const { partyRoleId } = await makeCustomer();

    const [beforeAdd] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, partyRoleId));

    const added = await addContact(
      {
        partyRoleId,
        lastModifiedDatetime: beforeAdd!.lastModifiedDatetime,
        contactName: "Preferred Contact",
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
    expect(added.ok).toBe(true);
    if (!added.ok) throw new Error("expected ok:true");

    const [afterAdd] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, partyRoleId));
    expect(afterAdd?.contactMedium).toBe(added.value.contactMediumId);

    const deleteResult = await deleteContact(
      {
        contactMediumId: added.value.contactMediumId,
        partyRoleId,
        lastModifiedDatetime: afterAdd!.lastModifiedDatetime,
      },
      actorUserId,
    );

    expect(deleteResult).toEqual({
      ok: false,
      code: "CANNOT_DELETE_PREFERRED_CONTACT",
    });

    const [survivingContact] = await db
      .select()
      .from(contactMedium)
      .where(eq(contactMedium.contactMediumId, added.value.contactMediumId));
    expect(survivingContact).toBeDefined();
  });

  it("deleting a non-preferred contact physically removes the row and audits CONTACT_DELETED with the full pre-delete row", async () => {
    const { partyRoleId } = await makeCustomer();

    const [beforeFirstAdd] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, partyRoleId));

    const firstContact = await addContact(
      {
        partyRoleId,
        lastModifiedDatetime: beforeFirstAdd!.lastModifiedDatetime,
        contactName: "Preferred Contact",
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
    expect(firstContact.ok).toBe(true);
    if (!firstContact.ok) throw new Error("expected ok:true");

    const secondContact = await addContact(
      {
        partyRoleId,
        lastModifiedDatetime: firstContact.value.lastModifiedDatetime,
        contactName: "Secondary Contact",
        contactRole: null,
        phoneNumber: null,
        emailAddress: "secondary@example.com",
        addressLine1: null,
        addressLine2: null,
        city: null,
        stateProvince: null,
        postalCode: null,
        country: null,
      },
      actorUserId,
    );
    expect(secondContact.ok).toBe(true);
    if (!secondContact.ok) throw new Error("expected ok:true");

    const deleteResult = await deleteContact(
      {
        contactMediumId: secondContact.value.contactMediumId,
        partyRoleId,
        lastModifiedDatetime: secondContact.value.lastModifiedDatetime,
      },
      actorUserId,
    );
    expect(deleteResult.ok).toBe(true);

    const [deletedRow] = await db
      .select()
      .from(contactMedium)
      .where(
        eq(contactMedium.contactMediumId, secondContact.value.contactMediumId),
      );
    expect(deletedRow).toBeUndefined();

    const [auditRow] = await db
      .select()
      .from(auditLog)
      .where(
        and(
          eq(auditLog.targetId, secondContact.value.contactMediumId),
          eq(auditLog.eventType, "CONTACT_DELETED"),
        ),
      );
    expect(auditRow?.eventType).toBe("CONTACT_DELETED");
    expect(auditRow?.afterData).toBeNull();
    expect(
      (auditRow?.beforeData as { contactMediumId?: string } | null)
        ?.contactMediumId,
    ).toBe(secondContact.value.contactMediumId);
  });
});
