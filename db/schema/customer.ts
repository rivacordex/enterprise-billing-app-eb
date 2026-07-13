import {
  check,
  index,
  jsonb,
  pgSchema,
  text,
  timestamp,
  unique,
  uniqueIndex,
} from "drizzle-orm/pg-core";
import { sql } from "drizzle-orm";

import { appuser } from "@/db/schema/identity";

export const customer = pgSchema("customer");

export const organizationSeq = customer.sequence("organization_seq", {
  startWith: 1,
});
export const partyRoleSeq = customer.sequence("party_role_seq", {
  startWith: 1,
});
export const contactMediumSeq = customer.sequence("contact_medium_seq", {
  startWith: 1,
});

// Millisecond precision (not the Postgres-default microsecond precision) on
// every timestamp in this schema — load-bearing only for
// `party_role.last_modified_datetime` (the module's one optimistic-lock
// column, cm08), applied everywhere else for consistency (cm01-spec §2.1.7).
export const organization = customer.table(
  "organization",
  {
    organizationId: text("organization_id")
      .primaryKey()
      .default(
        sql`'ORG' || lpad(nextval('customer.organization_seq')::text, 7, '0')`,
      ),
    name: text("name").notNull(),
    tradingName: text("trading_name"),
    organizationType: text("organization_type").notNull(),
    // Nullable + plain UNIQUE: Postgres treats multiple NULLs as distinct,
    // so this is nullable-unique with no partial index needed (Inv. #8).
    registrationNumber: text("registration_number").unique(),
    taxId: text("tax_id"),
    industry: text("industry"),
    status: text("status").notNull().default("REGISTERED"),
    statusReason: text("status_reason"),
    lastModifiedBy: text("last_modified_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  () => [
    check(
      "organization_organization_type_check",
      sql`organization_type IN ('COMPANY','GOVERNMENT')`,
    ),
    check(
      "organization_status_check",
      sql`status IN ('REGISTERED','ACTIVE','INACTIVE','SUSPENDED','DISSOLVED','MERGED')`,
    ),
  ],
);

export const partyRole = customer.table(
  "party_role",
  {
    partyRoleId: text("party_role_id")
      .primaryKey()
      .default(
        sql`'PTRL' || lpad(nextval('customer.party_role_seq')::text, 8, '0')`,
      ),
    engagedParty: text("engaged_party")
      .notNull()
      .references(() => organization.organizationId, {
        onDelete: "restrict",
      }),
    status: text("status").notNull().default("INITIALIZED"),
    statusReason: text("status_reason"),
    partyRoleSpecification: jsonb("party_role_specification")
      .notNull()
      .default(sql`'{}'::jsonb`)
      .$type<Record<string, unknown>>(),
    // No FK, no CHECK — display-only until an Account module exists (Inv. #9).
    account: text("account"),
    // The preferred-contact pointer (cm01-spec §2.2). The composite
    // `party_role_contact_medium_fk` DEFERRABLE INITIALLY DEFERRED FK to
    // `contact_medium (contact_medium_id, ref_party_role)` — the constraint
    // that makes a pointer into another customer's contact a DB-level
    // impossibility — is hand-authored directly in the migration SQL, not
    // declared here: drizzle-kit's `foreignKey()` builder can't express
    // DEFERRABLE, and a table-level composite FK against `contactMedium`
    // (itself referencing `partyRole.partyRoleId`) is a genuine mutual type
    // dependency between the two tables that `tsc` can't resolve without an
    // explicit annotation drizzle-kit doesn't support for this builder.
    contactMedium: text("contact_medium"),
    lastModifiedBy: text("last_modified_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    // The module's one optimistic-lock column (Inv. #6, cm08) — millisecond
    // precision is what keeps the compare-and-bump equality check exact
    // across the client Date/ISO round trip.
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    uniqueIndex("party_role_engaged_party_unique_open")
      .on(t.engagedParty)
      .where(sql`status != 'CLOSED'`),
    index("party_role_engaged_party_idx").on(t.engagedParty),
    check(
      "party_role_status_check",
      sql`status IN ('INITIALIZED','VALIDATED','ACTIVE','SUSPENDED','CLOSED')`,
    ),
  ],
);

export const contactMedium = customer.table(
  "contact_medium",
  {
    contactMediumId: text("contact_medium_id")
      .primaryKey()
      .default(
        sql`'CTMD' || lpad(nextval('customer.contact_medium_seq')::text, 8, '0')`,
      ),
    refPartyRole: text("ref_party_role")
      .notNull()
      .references(() => partyRole.partyRoleId, { onDelete: "restrict" }),
    contactName: text("contact_name").notNull(),
    contactRole: text("contact_role"),
    phoneNumber: text("phone_number"),
    emailAddress: text("email_address"),
    gaAddressLine1: text("ga_address_line1"),
    gaAddressLine2: text("ga_address_line2"),
    gaCity: text("ga_city"),
    gaStateProvince: text("ga_state_province"),
    gaPostalCode: text("ga_postal_code"),
    gaCountry: text("ga_country"),
    preferredContactMethod: text("preferred_contact_method"),
    lastModifiedBy: text("last_modified_by")
      .notNull()
      .references(() => appuser.id, { onDelete: "restrict" }),
    createdDatetime: timestamp("created_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
    lastModifiedDatetime: timestamp("last_modified_datetime", {
      withTimezone: true,
      precision: 3,
      mode: "date",
    })
      .notNull()
      .default(sql`now()`),
  },
  (t) => [
    // The FK target for `party_role.contact_medium` (§2.2) — the load-bearing
    // constraint of the unit; without it the composite FK on `party_role`
    // cannot be created. Must be a true UNIQUE CONSTRAINT (not a bare unique
    // index) — Postgres composite FKs require a unique/PK constraint on the
    // exact referenced column tuple.
    unique("contact_medium_id_ref_party_role_unique").on(
      t.contactMediumId,
      t.refPartyRole,
    ),
    index("contact_medium_ref_party_role_idx").on(t.refPartyRole),
    check(
      "contact_medium_preferred_contact_method_check",
      sql`preferred_contact_method IN ('PHONE','EMAIL','ADDRESS')`,
    ),
  ],
);

export type Organization = typeof organization.$inferSelect;
export type OrganizationInsert = typeof organization.$inferInsert;
export type PartyRole = typeof partyRole.$inferSelect;
export type PartyRoleInsert = typeof partyRole.$inferInsert;
export type ContactMedium = typeof contactMedium.$inferSelect;
export type ContactMediumInsert = typeof contactMedium.$inferInsert;
