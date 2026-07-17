import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { contactMedium } from "@/db/schema/customer";
import type { ContactMedium, ContactMediumInsert } from "@/db/schema/customer";

export const contactMediumRepository = {
  // Uses `cm01`'s index on `ref_party_role`. Ordered by
  // `contact_medium_id ASC` — deterministic insertion order via the ID
  // sequence, the simplest defensible default since the overview doesn't
  // specify a display order (cm02-spec §3.9).
  async findByPartyRoleId(
    db: Database,
    partyRoleId: string,
  ): Promise<ContactMedium[]> {
    return db
      .select()
      .from(contactMedium)
      .where(eq(contactMedium.refPartyRole, partyRoleId))
      .orderBy(asc(contactMedium.contactMediumId));
  },

  // Plain PK lookup — `updateContact` (cm12) reads `before` outside the
  // transaction, same convention as `organizationRepository.findById`.
  async findById(
    db: Database,
    contactMediumId: string,
  ): Promise<ContactMedium | null> {
    const [row] = await db
      .select()
      .from(contactMedium)
      .where(eq(contactMedium.contactMediumId, contactMediumId))
      .limit(1);
    return row ?? null;
  },

  // First write function on this repository — cm11 is the JIT unit that
  // ends the finder-only guardrail (cm07/cm08 already ended it for
  // `organizationRepository`/`partyRoleRepository`).
  async insert(
    tx: Database,
    data: ContactMediumInsert,
  ): Promise<ContactMedium> {
    const [row] = await tx.insert(contactMedium).values(data).returning();
    return row!;
  },

  // Field-only update (cm12-spec §3.1) — `preferredContactMethod` is
  // included since the caller (`updateContact`) has already resolved its new
  // value per `resolveUpdatedPreferredMethod`, not left untouched here.
  async update(
    tx: Database,
    contactMediumId: string,
    data: Pick<
      ContactMediumInsert,
      | "contactName"
      | "contactRole"
      | "phoneNumber"
      | "emailAddress"
      | "gaAddressLine1"
      | "gaAddressLine2"
      | "gaCity"
      | "gaStateProvince"
      | "gaPostalCode"
      | "gaCountry"
      | "preferredContactMethod"
      | "lastModifiedBy"
    >,
  ): Promise<ContactMedium> {
    const [row] = await tx
      .update(contactMedium)
      .set({ ...data, lastModifiedDatetime: new Date() })
      .where(eq(contactMedium.contactMediumId, contactMediumId))
      .returning();
    return row!;
  },
};
