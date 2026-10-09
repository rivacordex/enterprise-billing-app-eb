import { and, desc, eq, inArray, isNotNull, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { systemConfig } from "@/db/schema/system-config";
import {
  INVOICE_PROFILE_CONFIG_GROUP,
  INVOICE_PROFILE_META_PREFIX,
  type InvoiceProfileMetaKey,
} from "@/types/billing";
import type { ConfigStatus } from "@/types/system-config";

// bm53-spec §Design D3 — READ-ONLY repository over the company profile:
// `core.system_config` group `invoice.profile`, where one version is N key rows
// sharing a `config_version` (all with the same `status`), `is_secret = false`
// (code-standards Part 2 data rule 5). Writes arrive with bm59/bm61. Every read
// excludes secret rows, so a mis-flagged row can never reach a rendered invoice.
export const INVOICE_PROFILE_GROUP = INVOICE_PROFILE_CONFIG_GROUP;

export interface InvoiceProfileVersionSummary {
  configVersion: number;
  status: ConfigStatus;
  modifiedBy: string | null;
  createdDatetime: Date;
  lastModifiedDatetime: Date;
  // bm56 D2 — the version's `meta.*` display values (absent key → absent).
  meta: Partial<Record<InvoiceProfileMetaKey, string>>;
  // bm56 D1 — `count(*)` of `customer_bill` rows stamped with this version.
  usedByCount: number;
}

// bm56 D2 — a version's rows split into profile `fields` and reserved `meta`.
export interface InvoiceProfileRawVersion {
  fields: Record<string, string | null>;
  meta: Partial<Record<InvoiceProfileMetaKey, string>>;
}

function isMetaKey(key: string): boolean {
  return key.startsWith(INVOICE_PROFILE_META_PREFIX);
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

  // One version's PROFILE FIELD rows as `{ config_key: config_value }`. The
  // reserved `meta.*` keys are excluded — the strict profile schema must never
  // see them (bm56 D2). An unknown version returns `{}` (the caller's schema
  // parse then fails — never a partial profile).
  async readVersion(
    db: Database,
    configVersion: number,
  ): Promise<Record<string, string | null>> {
    return (await this.readVersionRaw(db, configVersion)).fields;
  },

  // bm56 D2 — the version's rows split into fields and `meta.*`, unparsed (a
  // DRAFT may be incomplete and must still render).
  async readVersionRaw(
    db: Database,
    configVersion: number,
  ): Promise<InvoiceProfileRawVersion> {
    const rows = await db
      .select({
        key: systemConfig.configKey,
        value: systemConfig.configValue,
      })
      .from(systemConfig)
      .where(
        and(inProfileGroup, eq(systemConfig.configVersion, configVersion)),
      );
    const fields: Record<string, string | null> = {};
    const meta: InvoiceProfileRawVersion["meta"] = {};
    for (const { key, value } of rows) {
      if (!isMetaKey(key)) fields[key] = value;
      else if (value !== null) meta[key as InvoiceProfileMetaKey] = value;
    }
    return { fields, meta };
  },

  // The status shared by all rows of a version, or `null` for an unknown one.
  async findVersionStatus(
    db: Database,
    configVersion: number,
  ): Promise<ConfigStatus | null> {
    const [row] = await db
      .select({ status: sql<string>`max(${systemConfig.status})` })
      .from(systemConfig)
      .where(and(inProfileGroup, eq(systemConfig.configVersion, configVersion)))
      .having(sql`count(*) > 0`);
    return (row?.status as ConfigStatus | undefined) ?? null;
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

    const metaRows = await db
      .select({
        version: systemConfig.configVersion,
        key: systemConfig.configKey,
        value: systemConfig.configValue,
      })
      .from(systemConfig)
      .where(and(inProfileGroup, isNotNull(systemConfig.configValue)));
    const metaByVersion = new Map<number, InvoiceProfileRawVersion["meta"]>();
    for (const { version, key, value } of metaRows) {
      if (!isMetaKey(key) || value === null) continue;
      const bucket = metaByVersion.get(version) ?? {};
      bucket[key as InvoiceProfileMetaKey] = value;
      metaByVersion.set(version, bucket);
    }

    // Used-by: a plain SQL count of the bills stamped with each version.
    const usedRows = await db
      .select({
        version: customerBill.refInvoiceProfileVersion,
        count: sql<number>`count(*)::int`,
      })
      .from(customerBill)
      .where(isNotNull(customerBill.refInvoiceProfileVersion))
      .groupBy(customerBill.refInvoiceProfileVersion);
    const usedBy = new Map(usedRows.map((r) => [r.version, r.count]));

    return rows.map((r) => ({
      ...r,
      status: r.status as ConfigStatus,
      meta: metaByVersion.get(r.configVersion) ?? {},
      usedByCount: usedBy.get(r.configVersion) ?? 0,
    }));
  },

  // bm56 D1 — display names for the appuser ids stored on a version (`modified_by`,
  // `meta.activated_by`). Unknown ids are simply absent from the map.
  async resolveUserNames(
    db: Database,
    ids: readonly string[],
  ): Promise<Map<string, string>> {
    if (ids.length === 0) return new Map();
    const rows = await db
      .select({ id: appuser.id, name: appuser.userName })
      .from(appuser)
      .where(inArray(appuser.id, [...ids]));
    return new Map(rows.map((r) => [r.id, r.name]));
  },
};
