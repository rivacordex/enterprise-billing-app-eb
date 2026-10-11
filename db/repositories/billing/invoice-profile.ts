import { and, desc, eq, inArray, isNotNull, like, sql } from "drizzle-orm";

import type { Database } from "@/db/client";
import { DRAFT_TOKEN_FORMAT } from "@/db/repositories/billing/bill-template-version";
import { appuser } from "@/db/schema/identity";
import { customerBill } from "@/db/schema/billing/customer-bill";
import { systemConfig } from "@/db/schema/system-config";
import {
  INVOICE_PROFILE_CONFIG_GROUP,
  INVOICE_PROFILE_FIELD_LABELS,
  INVOICE_PROFILE_META_PREFIX,
  type InvoiceProfileMetaKey,
} from "@/types/billing";
import type { ConfigStatus } from "@/types/system-config";

// bm53-spec §Design D3 — repository over the company profile:
// `core.system_config` group `invoice.profile`, where one version is N key rows
// sharing a `config_version` (all with the same `status`), `is_secret = false`
// (code-standards Part 2 data rule 5). bm59 adds the working-draft writes
// (`lockProfileGroup`, `nextProfileVersion`, `findDraftVersion`,
// `insertDraftVersion`, `updateDraftFields`); bm60 adds `setDraftLogo`; bm61
// adds activation (`findDraftTokenForUpdate`, `retireActiveVersion`,
// `promoteDraftVersion`, `writeMeta`).
// Every read excludes secret rows, so a mis-flagged row can never reach a
// rendered invoice.
export const INVOICE_PROFILE_GROUP = INVOICE_PROFILE_CONFIG_GROUP;

// bm59 D1 — the draft's optimistic-concurrency token: `max(last_modified_datetime)`
// of its rows, rendered in SQL at microsecond precision (the bm57 token form).
const draftToken = sql<string>`to_char(max(${systemConfig.lastModifiedDatetime}) AT TIME ZONE 'UTC', '${sql.raw(DRAFT_TOKEN_FORMAT)}')`;

export interface InvoiceProfileDraftVersion {
  configVersion: number;
  token: string;
}

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

// A profile field row, not a reserved `meta.*` row (bm56 D2).
const notMetaRow = sql`${systemConfig.configKey} NOT LIKE ${`${INVOICE_PROFILE_META_PREFIX}%`}`;

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
  // status; `modifiedBy` is the actor on the most recently modified FIELD row
  // (bm61: the `meta.*` rows an activation writes are excluded, so "created
  // by" stays the editor, not the activator).
  async listVersions(db: Database): Promise<InvoiceProfileVersionSummary[]> {
    const rows = await db
      .select({
        configVersion: systemConfig.configVersion,
        status: sql<string>`max(${systemConfig.status})`,
        modifiedBy: sql<
          string | null
        >`(array_agg(${systemConfig.modifiedBy} ORDER BY ${systemConfig.lastModifiedDatetime} DESC) FILTER (WHERE ${notMetaRow}))[1]`,
        createdDatetime:
          sql<Date>`min(${systemConfig.createdDatetime})`.mapWith(
            systemConfig.createdDatetime,
          ),
        lastModifiedDatetime:
          sql<Date>`COALESCE(max(${systemConfig.lastModifiedDatetime}) FILTER (WHERE ${notMetaRow}), max(${systemConfig.lastModifiedDatetime}))`.mapWith(
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
      .where(
        and(
          inProfileGroup,
          like(systemConfig.configKey, `${INVOICE_PROFILE_META_PREFIX}%`),
          isNotNull(systemConfig.configValue),
        ),
      );
    const metaByVersion = new Map<number, InvoiceProfileRawVersion["meta"]>();
    // The query already restricts to non-null `meta.*` rows, so no re-check.
    for (const { version, key, value } of metaRows) {
      if (value === null) continue; // narrows the type; never true at runtime
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

  // bm59 D1 — serialise profile-draft writers for the rest of the transaction.
  // Taken BEFORE the draft lookup, so two concurrent first saves become one
  // insert and one `DRAFT_CONFLICT` (the bm57 precedent). Re-entrant within a
  // transaction, so `nextProfileVersion` simply re-takes it.
  async lockProfileGroup(tx: Database): Promise<void> {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`core.system_config:${INVOICE_PROFILE_GROUP}`}))`,
    );
  },

  // bm59 D1 — `max(config_version) + 1` over the whole group (secret rows
  // included, so the unique key can never collide), under the group lock.
  // `system_config_group_version_key_unique` is the backstop.
  async nextProfileVersion(tx: Database): Promise<number> {
    await this.lockProfileGroup(tx);
    const [row] = await tx
      .select({
        maxVersion: sql<number>`COALESCE(max(${systemConfig.configVersion}), 0)::int`,
      })
      .from(systemConfig)
      .where(eq(systemConfig.configGroup, INVOICE_PROFILE_GROUP));
    return (row?.maxVersion ?? 0) + 1;
  },

  // bm59 D1 — the single working DRAFT version with its token, or `null`.
  async findDraftVersion(
    db: Database,
  ): Promise<InvoiceProfileDraftVersion | null> {
    const [row] = await db
      .select({ configVersion: systemConfig.configVersion, token: draftToken })
      .from(systemConfig)
      .where(and(inProfileGroup, eq(systemConfig.status, "DRAFT")))
      .groupBy(systemConfig.configVersion)
      .orderBy(desc(systemConfig.configVersion))
      .limit(1);
    return row ?? null;
  },

  // bm59 D1 — first save: one DRAFT row per key at `version` (every key
  // present; a blank is `NULL`), `is_secret = false`, the key's label as its
  // description. Returns the new draft's token.
  async insertDraftVersion(
    tx: Database,
    input: {
      version: number;
      fields: Readonly<Record<string, string | null>>;
      actor: string;
    },
  ): Promise<string> {
    await tx.insert(systemConfig).values(
      Object.entries(input.fields).map(([key, value]) => ({
        configGroup: INVOICE_PROFILE_GROUP,
        configVersion: input.version,
        configKey: key,
        configValue: value,
        description: INVOICE_PROFILE_FIELD_LABELS[key] ?? null,
        isSecret: false,
        status: "DRAFT",
        modifiedBy: input.actor,
      })),
    );
    const draft = await this.findDraftVersion(tx);
    if (draft?.configVersion !== input.version) {
      throw new Error("insertDraftVersion: the inserted draft was not found");
    }
    return draft.token;
  },

  // bm59 D1 — a later save: update only the changed keys of the DRAFT, guarded
  // by the caller's token in the same statement. Returns the new token, or
  // `null` when the token no longer matches (the caller reports
  // `DRAFT_CONFLICT`). No changes → the token is checked and returned as is.
  async updateDraftFields(
    tx: Database,
    input: {
      version: number;
      changes: Readonly<Record<string, string | null>>;
      actor: string;
      expectedToken: string;
    },
  ): Promise<string | null> {
    // The token is checked first, so "no row matched" below can only mean a
    // key missing from the stored draft, never a stale token. Every caller
    // holds the group lock (`lockProfileGroup`), so the check stays true for
    // the rest of the transaction; the UPDATE keeps its own guard as well.
    const current = await this.findDraftVersion(tx);
    if (
      current?.configVersion !== input.version ||
      current.token !== input.expectedToken
    ) {
      return null;
    }
    const entries = Object.entries(input.changes);
    if (entries.length === 0) return current.token;
    const values = sql.join(
      entries.map(([key, value]) => sql`(${key}::text, ${value}::text)`),
      sql`, `,
    );
    const updated = await tx.execute(sql`
      UPDATE ${systemConfig} AS sc
      SET config_value = c.value,
          modified_by = ${input.actor},
          last_modified_datetime = now()
      FROM (VALUES ${values}) AS c(key, value)
      WHERE sc.config_group = ${INVOICE_PROFILE_GROUP}
        AND sc.config_version = ${input.version}
        AND sc.status = 'DRAFT'
        AND sc.is_secret = false
        AND sc.config_key = c.key
        AND (
          SELECT to_char(max(d.last_modified_datetime) AT TIME ZONE 'UTC', '${sql.raw(DRAFT_TOKEN_FORMAT)}')
          FROM ${systemConfig} AS d
          WHERE d.config_group = ${INVOICE_PROFILE_GROUP}
            AND d.config_version = ${input.version}
            AND d.status = 'DRAFT'
            AND d.is_secret = false
        ) = ${input.expectedToken}
      RETURNING sc.config_key`);
    // A key with no row in the stored draft (a draft that predates a field
    // key, or a hand-inserted one) is inserted, so the change is never
    // silently dropped while the audit records it.
    const updatedKeys = new Set(
      (updated as unknown as { config_key: string }[]).map((r) => r.config_key),
    );
    const missing = entries.filter(([key]) => !updatedKeys.has(key));
    if (missing.length > 0) {
      await tx.insert(systemConfig).values(
        missing.map(([key, value]) => ({
          configGroup: INVOICE_PROFILE_GROUP,
          configVersion: input.version,
          configKey: key,
          configValue: value,
          description: INVOICE_PROFILE_FIELD_LABELS[key] ?? null,
          isSecret: false,
          status: "DRAFT",
          modifiedBy: input.actor,
        })),
      );
    }
    const draft = await this.findDraftVersion(tx);
    return draft?.token ?? null;
  },

  // bm60 D5 step 4 — point the working DRAFT's `logo_asset_version_id` row at
  // a new logo version, guarded by the caller's draft token (the
  // `updateDraftFields` statement). Returns the draft version, the previous
  // logo id and the new token, or `null` when there is no draft or the token
  // is stale (the caller reports `DRAFT_CONFLICT`).
  async setDraftLogo(
    tx: Database,
    input: {
      expectedDraftToken: string;
      assetVersionId: string;
      actor: string;
    },
  ): Promise<{
    configVersion: number;
    previousLogoAssetVersionId: string | null;
    token: string;
  } | null> {
    await this.lockProfileGroup(tx);
    const draft = await this.findDraftVersion(tx);
    if (draft?.token !== input.expectedDraftToken) return null;
    const previous =
      (await this.readVersion(tx, draft.configVersion)).logo_asset_version_id ??
      null;
    const token = await this.updateDraftFields(tx, {
      version: draft.configVersion,
      changes: { logo_asset_version_id: input.assetVersionId },
      actor: input.actor,
      expectedToken: input.expectedDraftToken,
    });
    if (token === null) return null;
    return {
      configVersion: draft.configVersion,
      previousLogoAssetVersionId: previous,
      token,
    };
  },

  // bm61 D3 — re-check the draft under `FOR UPDATE` of its rows: the token of
  // `configVersion`'s DRAFT rows, or `null` when it is no longer a draft.
  async findDraftTokenForUpdate(
    tx: Database,
    configVersion: number,
  ): Promise<string | null> {
    const rows = await tx
      .select({ lastModified: systemConfig.lastModifiedDatetime })
      .from(systemConfig)
      .where(
        and(
          inProfileGroup,
          eq(systemConfig.configVersion, configVersion),
          eq(systemConfig.status, "DRAFT"),
        ),
      )
      .for("update");
    if (rows.length === 0) return null;
    const draft = await this.findDraftVersion(tx);
    return draft?.configVersion === configVersion ? draft.token : null;
  },

  // bm61 D3 step 1 — retire the ACTIVE version: every ACTIVE row of the group
  // (`meta.*` included), so even a hand-edited second ACTIVE version cannot
  // survive. Returns the retired versions, newest first (`[]` when none was
  // ACTIVE). Status only: `modified_by`/`last_modified_datetime` keep the
  // editor's.
  async retireActiveVersion(tx: Database): Promise<number[]> {
    const rows = await tx
      .update(systemConfig)
      .set({ status: "RETIRED" })
      .where(
        and(
          eq(systemConfig.configGroup, INVOICE_PROFILE_GROUP),
          eq(systemConfig.status, "ACTIVE"),
        ),
      )
      .returning({ version: systemConfig.configVersion });
    return [...new Set(rows.map((r) => r.version))].sort((a, b) => b - a);
  },

  // bm61 D3 step 2 — promote the draft's rows to ACTIVE. Returns the number of
  // rows promoted (0 → the draft is gone; the caller rolls back).
  async promoteDraftVersion(
    tx: Database,
    configVersion: number,
  ): Promise<number> {
    const rows = await tx
      .update(systemConfig)
      .set({ status: "ACTIVE" })
      .where(
        and(
          eq(systemConfig.configGroup, INVOICE_PROFILE_GROUP),
          eq(systemConfig.configVersion, configVersion),
          eq(systemConfig.status, "DRAFT"),
        ),
      )
      .returning({ id: systemConfig.configId });
    return rows.length;
  },

  // bm61 D3 — write (insert or overwrite) a version's reserved `meta.*` rows
  // (bm56 D2) with the version's status. Display convenience only; AUDIT_LOG
  // stays authoritative.
  async writeMeta(
    tx: Database,
    input: {
      configVersion: number;
      status: ConfigStatus;
      values: Partial<Record<InvoiceProfileMetaKey, string>>;
      actor: string;
    },
  ): Promise<void> {
    const entries = Object.entries(input.values);
    if (entries.length === 0) return;
    await tx
      .insert(systemConfig)
      .values(
        entries.map(([key, value]) => ({
          configGroup: INVOICE_PROFILE_GROUP,
          configVersion: input.configVersion,
          configKey: key,
          configValue: value,
          isSecret: false,
          status: input.status,
          modifiedBy: input.actor,
        })),
      )
      .onConflictDoUpdate({
        target: [
          systemConfig.configGroup,
          systemConfig.configVersion,
          systemConfig.configKey,
        ],
        set: {
          configValue: sql`excluded.config_value`,
          status: sql`excluded.status`,
          modifiedBy: sql`excluded.modified_by`,
          lastModifiedDatetime: sql`now()`,
        },
      });
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
