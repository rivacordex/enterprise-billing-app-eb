import { and, asc, eq, ilike, or } from "drizzle-orm";

import type { Database } from "@/db/client";
import { organization, partyRole } from "@/db/schema/customer";
import type {
  Organization,
  PartyRole,
  PartyRoleInsert,
} from "@/db/schema/customer";
import type { CustomerStatus } from "@/types/customer";

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

  // The one place Module Invariant #6 is implemented (cm08-spec §2.2) — a
  // single atomic `UPDATE ... WHERE last_modified_datetime = $expected`, no
  // separate read-then-write, so there's no TOCTOU window for a second
  // transaction to interleave. Zero rows matched (stale lock or unknown ID)
  // returns `null`; the caller maps that to `CONFLICT` without needing to
  // distinguish the two cases. Every mutation service from this unit through
  // cm15 calls this exact function, even a contact-only edit.
  async compareAndBumpLock(
    tx: Database,
    partyRoleId: string,
    expectedLastModifiedDatetime: Date,
  ): Promise<Date | null> {
    const [row] = await tx
      .update(partyRole)
      .set({ lastModifiedDatetime: new Date() })
      .where(
        and(
          eq(partyRole.partyRoleId, partyRoleId),
          eq(partyRole.lastModifiedDatetime, expectedLastModifiedDatetime),
        ),
      )
      .returning({ lastModifiedDatetime: partyRole.lastModifiedDatetime });
    return row?.lastModifiedDatetime ?? null;
  },

  // A same-row refinement of `compareAndBumpLock` (cm10-spec §2.2) — this
  // mutation and its lock column both live on `party_role`, so the
  // compare-check and the actual data write collapse into one atomic
  // `UPDATE` instead of bumping the lock and then issuing a second `UPDATE`
  // against the row just touched. Zero rows matched (stale lock or unknown
  // ID) returns `null`, same convention as `compareAndBumpLock`.
  async compareAndUpdateStatus(
    tx: Database,
    partyRoleId: string,
    expectedLastModifiedDatetime: Date,
    data: {
      status: CustomerStatus;
      statusReason: string;
      lastModifiedBy: string;
    },
  ): Promise<PartyRole | null> {
    const [row] = await tx
      .update(partyRole)
      .set({ ...data, lastModifiedDatetime: new Date() })
      .where(
        and(
          eq(partyRole.partyRoleId, partyRoleId),
          eq(partyRole.lastModifiedDatetime, expectedLastModifiedDatetime),
        ),
      )
      .returning();
    return row ?? null;
  },

  // Same shape as `compareAndUpdateStatus`, setting `partyRoleSpecification`
  // instead of `status`/`statusReason` (cm10-spec §2.2) — a specification
  // edit writes no `status_reason`-style field, since it isn't a lifecycle
  // transition.
  async compareAndUpdateSpecification(
    tx: Database,
    partyRoleId: string,
    expectedLastModifiedDatetime: Date,
    data: {
      partyRoleSpecification: Record<string, unknown>;
      lastModifiedBy: string;
    },
  ): Promise<PartyRole | null> {
    const [row] = await tx
      .update(partyRole)
      .set({ ...data, lastModifiedDatetime: new Date() })
      .where(
        and(
          eq(partyRole.partyRoleId, partyRoleId),
          eq(partyRole.lastModifiedDatetime, expectedLastModifiedDatetime),
        ),
      )
      .returning();
    return row ?? null;
  },
};
