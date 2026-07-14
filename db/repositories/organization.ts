import { eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { organization } from "@/db/schema/customer";
import type { Organization } from "@/db/schema/customer";

// v1 exports finders only (cm02-spec Design #2.2.2) — no insert/update/
// delete anywhere in this file. Write functions arrive JIT in the mutation
// unit that first needs them (cm07's organization+party_role inserts).
export const organizationRepository = {
  // Plain PK lookup. No projection composition here — `getCustomerDetail`
  // assembles the `OrganizationDetail` read model itself so the
  // `user_name` join lives in one place, not duplicated across
  // repositories (cm02-spec §3.7).
  async findById(
    db: Database,
    organizationId: string,
  ): Promise<Organization | null> {
    const [row] = await db
      .select()
      .from(organization)
      .where(eq(organization.organizationId, organizationId))
      .limit(1);
    return row ?? null;
  },
};
