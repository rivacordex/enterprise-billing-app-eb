import { and, desc, eq, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { systemConfig } from "@/db/schema/system-config";
import type { ConfigStatus } from "@/types/system-config";

// bm53-spec §Design D3 — READ-ONLY repository over the company profile:
// `core.system_config` group `invoice.profile`, where one version is N key rows
// sharing a `config_version` (all with the same `status`), `is_secret = false`
// (code-standards Part 2 data rule 5). Writes arrive with bm59/bm61. Every read
// excludes secret rows, so a mis-flagged row can never reach a rendered invoice.
export const INVOICE_PROFILE_GROUP = "invoice.profile";

export interface InvoiceProfileVersionSummary {
  configVersion: number;
  status: ConfigStatus;
  modifiedBy: string | null;
  createdDatetime: Date;
  lastModifiedDatetime: Date;
}

const inProfileGroup = and(
  eq(systemConfig.configGroup, INVOICE_PROFILE_GROUP),
  eq(systemConfig.isSecret, false),
);

export const invoiceProfileRepository = {
  // The highest `config_version` whose rows are ACTIVE, or `null` when no
  // version is ACTIVE (G15 A — the render then prints no issuer/payment block).
  async findActiveVersion(db: Database): Promise<number | null> {
    const [row] = await db
      .select({
        version: sql<number | null>`max(${systemConfig.configVersion})::int`,
      })
      .from(systemConfig)
      .where(and(inProfileGroup, eq(systemConfig.status, "ACTIVE")));
    return row?.version ?? null;
  },

  // One version's rows as `{ config_key: config_value }`. An unknown version
  // returns `{}` (the caller's schema parse then fails — never a partial
  // profile).
  async readVersion(
    db: Database,
    configVersion: number,
  ): Promise<Record<string, string | null>> {
    const rows = await db
      .select({
        key: systemConfig.configKey,
        value: systemConfig.configValue,
      })
      .from(systemConfig)
      .where(
        and(inProfileGroup, eq(systemConfig.configVersion, configVersion)),
      );
    return Object.fromEntries(rows.map((r) => [r.key, r.value]));
  },

  // Version history for bm56, newest first. All rows of a version share a
  // status; `modifiedBy` is the actor on the most recently modified row.
  async listVersions(db: Database): Promise<InvoiceProfileVersionSummary[]> {
    const rows = await db
      .select({
        configVersion: systemConfig.configVersion,
        status: sql<string>`max(${systemConfig.status})`,
        modifiedBy: sql<
          string | null
        >`(array_agg(${systemConfig.modifiedBy} ORDER BY ${systemConfig.lastModifiedDatetime} DESC))[1]`,
        createdDatetime:
          sql<Date>`min(${systemConfig.createdDatetime})`.mapWith(
            systemConfig.createdDatetime,
          ),
        lastModifiedDatetime:
          sql<Date>`max(${systemConfig.lastModifiedDatetime})`.mapWith(
            systemConfig.lastModifiedDatetime,
          ),
      })
      .from(systemConfig)
      .where(inProfileGroup)
      .groupBy(systemConfig.configVersion)
      .orderBy(desc(systemConfig.configVersion));
    return rows.map((r) => ({ ...r, status: r.status as ConfigStatus }));
  },
};
