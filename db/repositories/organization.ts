import { and, eq, ilike, ne, or, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { organization } from "@/db/schema/customer";
import type { Organization, OrganizationInsert } from "@/db/schema/customer";
import type { OrganizationFields } from "@/validation/customer/organization.schema";
import type { OrganizationStatus } from "@/types/customer";

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

  // `data` never sets `organizationId`, `status`, or `lastModifiedDatetime`
  // — all DB defaults (cm01). First write function on this repository
  // (cm07-spec §3.1).
  async insert(tx: Database, data: OrganizationInsert): Promise<Organization> {
    const [row] = await tx.insert(organization).values(data).returning();
    return row!;
  },

  // No `status` field in `data` — `OrganizationForm` (cm08) never submits
  // one, so there's nothing to accidentally overwrite (cm08-spec §2.4). Org
  // status stays a read-only badge until cm09 adds a status control.
  async update(
    tx: Database,
    organizationId: string,
    data: OrganizationFields & { lastModifiedBy: string },
  ): Promise<Organization> {
    const [row] = await tx
      .update(organization)
      .set({ ...data, lastModifiedDatetime: new Date() })
      .where(eq(organization.organizationId, organizationId))
      .returning();
    return row!;
  },

  // Splits `name` into words >= 3 chars, ILIKE-matches each against
  // `name`/`trading_name`, LIMIT 5, projecting `COALESCE(trading_name, name)`
  // (cm07-spec §2.2/§3.1). `excludeOrganizationId` is unused at create time
  // (always `null`) but reused as-is by cm08's update-organization, which
  // excludes the record being edited.
  async findSimilarNames(
    db: Database,
    name: string,
    excludeOrganizationId: string | null,
  ): Promise<string[]> {
    const words = name.split(/\s+/).filter((w) => w.length >= 3);
    if (words.length === 0) return [];

    const patterns = words.map((w) => `%${w.replace(/[%_\\]/g, "\\$&")}%`);
    const nameConditions = patterns.flatMap((pattern) => [
      ilike(organization.name, pattern),
      ilike(organization.tradingName, pattern),
    ]);

    const rows = await db
      .select({
        display: sql<string>`coalesce(${organization.tradingName}, ${organization.name})`,
      })
      .from(organization)
      .where(
        and(
          or(...nameConditions),
          excludeOrganizationId === null
            ? undefined
            : ne(organization.organizationId, excludeOrganizationId),
        ),
      )
      .limit(5);

    return rows.map((row) => row.display);
  },

  // A narrow, targeted update (status + reason + provenance only) — distinct
  // from `update` above so neither function can accidentally touch the
  // other's columns (cm09-spec §3.1). First write function to touch
  // `status`/`status_reason`.
  async updateStatus(
    tx: Database,
    organizationId: string,
    data: {
      status: OrganizationStatus;
      statusReason: string;
      lastModifiedBy: string;
    },
  ): Promise<Organization> {
    const [row] = await tx
      .update(organization)
      .set({ ...data, lastModifiedDatetime: new Date() })
      .where(eq(organization.organizationId, organizationId))
      .returning();
    return row!;
  },
};
