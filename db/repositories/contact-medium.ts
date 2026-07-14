import { asc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { contactMedium } from "@/db/schema/customer";
import type { ContactMedium } from "@/db/schema/customer";

// v1 exports finders only (cm02-spec Design #2.2.2) — no insert/update/
// delete anywhere in this file.
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
};
