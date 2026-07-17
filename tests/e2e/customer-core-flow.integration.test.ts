import { randomUUID } from "node:crypto";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { appuser } from "@/db/schema/identity";
import { systemConfig } from "@/db/schema/system-config";
import type { createCustomer as CreateCustomer } from "@/services/customer/create-customer";
import type { addContact as AddContact } from "@/services/customer/contact-mutations";
import type { updateContact as UpdateContact } from "@/services/customer/contact-mutations";
import type { transitionOrganizationStatus as TransitionOrganizationStatus } from "@/services/customer/transition-organization-status";
import type { transitionCustomerStatus as TransitionCustomerStatus } from "@/services/customer/transition-customer-status";
import type { getCustomerDetail as GetCustomerDetail } from "@/services/customer/get-customer-detail";
import { isStatusInconsistent } from "@/components/customers/inconsistency-banner";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

const databaseUrl = process.env.DATABASE_URL;

// cm16-spec §3.3 — the one genuinely new test this unit adds: no prior unit
// owns the chained flow, only its individual steps (cm07 create, cm09/cm10
// transitions, cm11/cm12 contacts each unit-test their own step in
// isolation). Calls services directly, not the actions/customer/* Server
// Actions — same established boundary cm12–cm15's own integration tests
// use (custmgmt-progress-tracker.md's cm13 entry: no integration test in
// this module calls an actions/customer/* function directly, since
// `requirePermission` needs a real session this suite doesn't construct).
//
// Correction to the spec's literal step 4/5 wording: cm16-spec §3.3 labels
// the two-call, status-reasoned "INITIALIZED → VALIDATED → ACTIVE" sequence
// as the *organization* transition and the one-call "REGISTERED → ACTIVE"
// as the *customer* transition — backwards. `ORGANIZATION_STATUSES` has no
// INITIALIZED/VALIDATED member and `CUSTOMER_STATUSES` has no REGISTERED
// member (types/customer.ts) — the two are swapped in the spec's prose (the
// same "no live-repo mount this session" class of slip already flagged
// elsewhere in this module's specs). Implemented per the actual maps
// (validation/customer/transitions.ts): organization REGISTERED → ACTIVE in
// one call; customer INITIALIZED → VALIDATED → ACTIVE in two calls — which
// is also the only combination that reaches this test's asserted end state
// (org ACTIVE, customer ACTIVE, no isStatusInconsistent).
describe.skipIf(!databaseUrl)(
  "customer core flow: search → create → contact/methods → status transitions → view (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: ReturnType<typeof drizzle<typeof schema>>;
    let createCustomer: typeof CreateCustomer;
    let addContact: typeof AddContact;
    let updateContact: typeof UpdateContact;
    let transitionOrganizationStatus: typeof TransitionOrganizationStatus;
    let transitionCustomerStatus: typeof TransitionCustomerStatus;
    let getCustomerDetail: typeof GetCustomerDetail;
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
      ({ addContact, updateContact } =
        await import("@/services/customer/contact-mutations"));
      ({ transitionOrganizationStatus } =
        await import("@/services/customer/transition-organization-status"));
      ({ transitionCustomerStatus } =
        await import("@/services/customer/transition-customer-status"));
      ({ getCustomerDetail } =
        await import("@/services/customer/get-customer-detail"));

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

    it("chains create → contact/methods → both transition maps → visible in View Customer, end to end", async () => {
      // 1. Create, with a similar-name confirm round-trip.
      const seedName = `Core Flow Holdings ${randomUUID()}`;
      const seedCreate = await createCustomer(
        {
          name: seedName,
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-SEED-${randomUUID()}`,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: true,
        },
        actorUserId,
      );
      expect(seedCreate.ok).toBe(true);

      const unconfirmed = await createCustomer(
        {
          name: seedName,
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-DUP-${randomUUID()}`,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: false,
        },
        actorUserId,
      );
      expect(unconfirmed).toMatchObject({ code: "SIMILAR_NAMES_FOUND" });
      if (unconfirmed.ok || unconfirmed.code !== "SIMILAR_NAMES_FOUND") {
        throw new Error("expected SIMILAR_NAMES_FOUND");
      }
      expect(unconfirmed.similarNames).toContain(seedName);

      const created = await createCustomer(
        {
          name: seedName,
          tradingName: null,
          organizationType: "COMPANY",
          registrationNumber: `REG-DUP-${randomUUID()}`,
          taxId: null,
          industry: null,
          specificationRaw: "{}",
          confirmed: true,
        },
        actorUserId,
      );
      expect(created.ok).toBe(true);
      if (!created.ok) throw new Error("expected ok:true");
      const { partyRoleId } = created.value;

      // 2. Add a contact — first contact is auto-preferred (cm11).
      const detailAfterCreate = await getCustomerDetail(partyRoleId);
      const lockAfterCreate =
        detailAfterCreate!.customerRole.lastModifiedDatetime;
      const contactAdd = await addContact(
        {
          partyRoleId,
          lastModifiedDatetime: lockAfterCreate,
          contactName: "Jordan Contact",
          contactRole: "Billing",
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
      expect(contactAdd.ok).toBe(true);
      if (!contactAdd.ok) throw new Error("expected ok:true");
      const { contactMediumId } = contactAdd.value;

      // 3. Add phone, then email, to that contact — auto-preferred method
      //    resolves to PHONE (priority PHONE > EMAIL > ADDRESS, cm11/cm12).
      const afterPhone = await updateContact(
        {
          contactMediumId,
          partyRoleId,
          lastModifiedDatetime: contactAdd.value.lastModifiedDatetime,
          contactName: "Jordan Contact",
          contactRole: "Billing",
          phoneNumber: "+1-555-0100",
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
      expect(afterPhone.ok).toBe(true);
      if (!afterPhone.ok) throw new Error("expected ok:true");

      const afterEmail = await updateContact(
        {
          contactMediumId,
          partyRoleId,
          lastModifiedDatetime: afterPhone.value.lastModifiedDatetime,
          contactName: "Jordan Contact",
          contactRole: "Billing",
          phoneNumber: "+1-555-0100",
          emailAddress: "jordan@example.com",
          addressLine1: null,
          addressLine2: null,
          city: null,
          stateProvince: null,
          postalCode: null,
          country: null,
        },
        actorUserId,
      );
      expect(afterEmail.ok).toBe(true);
      if (!afterEmail.ok) throw new Error("expected ok:true");

      // 4. Organization: REGISTERED → ACTIVE (one call — see file-header
      //    correction note on the spec's swapped step 4/5 wording).
      const orgTransition = await transitionOrganizationStatus(
        {
          organizationId: created.value.organizationId,
          partyRoleId,
          targetStatus: "ACTIVE",
          statusReason: "Registration verified.",
          lastModifiedDatetime: afterEmail.value.lastModifiedDatetime,
        },
        actorUserId,
      );
      expect(orgTransition.ok).toBe(true);
      if (!orgTransition.ok) throw new Error("expected ok:true");

      // 5. Customer: INITIALIZED → VALIDATED → ACTIVE (two calls, each with
      //    status_reason).
      const toValidated = await transitionCustomerStatus(
        {
          partyRoleId,
          targetStatus: "VALIDATED",
          statusReason: "Onboarding checks complete.",
          lastModifiedDatetime: orgTransition.value.lastModifiedDatetime,
        },
        actorUserId,
      );
      expect(toValidated.ok).toBe(true);
      if (!toValidated.ok) throw new Error("expected ok:true");

      const toActive = await transitionCustomerStatus(
        {
          partyRoleId,
          targetStatus: "ACTIVE",
          statusReason: "First invoice-ready.",
          lastModifiedDatetime: toValidated.value.lastModifiedDatetime,
        },
        actorUserId,
      );
      expect(toActive.ok).toBe(true);
      if (!toActive.ok) throw new Error("expected ok:true");

      // 6. Visible in View Customer exactly as written, no errors.
      const finalDetail = await getCustomerDetail(partyRoleId);
      expect(finalDetail).not.toBeNull();
      if (!finalDetail) throw new Error("expected a detail row");

      expect(finalDetail.organization.status).toBe("ACTIVE");
      expect(finalDetail.customerRole.status).toBe("ACTIVE");
      expect(finalDetail.contacts).toHaveLength(1);
      expect(finalDetail.contacts[0]?.isPreferredContact).toBe(true);
      expect(finalDetail.contacts[0]?.preferredMethod).toBe("PHONE");
      expect(
        isStatusInconsistent(
          finalDetail.organization.status,
          finalDetail.customerRole.status,
        ),
      ).toBe(false);
    });
  },
);
