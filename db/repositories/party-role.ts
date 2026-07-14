import { asc, eq, ilike, or } from "drizzle-orm";

import type { Database } from "@/db/client";
import { organization, partyRole } from "@/db/schema/customer";
import type {
  Organization,
  PartyRole,
  PartyRoleInsert,
} from "@/db/schema/customer";

export const partyRoleRepository = {
  // Plain PK lookup.
  async findById(db: Database, partyRoleId: string): Promise<PartyRole | null> {
    const [row] = await db
      .select()
      .from(partyRole)
      .where(eq(partyRole.partyRoleId, partyRoleId))
      .limit(1);
    return row ?? null;
  },

  // Joins `party_role` to its `organization` via `engaged_party`, matching
  // `organization.name`/`trading_name` case-insensitively. `pattern` is the
  // caller's already-escaped, already-wrapped (`%…%`) ILIKE pattern; `limit`
  // is the caller's `limit + 1` — this repository just fetches what it's
  // asked, the "hint" concept and trim/hasMore logic live in the service
  // (cm02-spec §3.8, Design #2.2.5). Deterministic tie-break ordering keeps
  // repeated calls stable.
  async searchByOrganizationNameOrTradingName(
    db: Database,
    pattern: string,
    limit: number,
  ): Promise<Array<{ partyRole: PartyRole; organization: Organization }>> {
    return db
      .select({ partyRole, organization })
      .from(partyRole)
      .innerJoin(
        organization,
        eq(partyRole.engagedParty, organization.organizationId),
      )
      .where(
        or(
          ilike(organization.name, pattern),
          ilike(organization.tradingName, pattern),
        ),
      )
      .orderBy(asc(organization.name), asc(partyRole.partyRoleId))
      .limit(limit);
  },

  // `status` is hard-coded to `INITIALIZED`, overwriting whatever `data`
  // carries — belt-and-suspenders against a future caller mistake, since
  // there is no code path that should create a customer at any other
  // initial status (cm07-spec §2.3.3, §3.2). First write function on this
  // repository.
  async insert(tx: Database, data: PartyRoleInsert): Promise<PartyRole> {
    const [row] = await tx
      .insert(partyRole)
      .values({ ...data, status: "INITIALIZED" })
      .returning();
    return row!;
  },
};
