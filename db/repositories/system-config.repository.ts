import { and, asc, desc, eq } from "drizzle-orm";

import type { Database } from "@/db/client";
import { appuser } from "@/db/schema/identity";
import { systemConfig } from "@/db/schema/system-config";
import type {
  ConfigStatus,
  SystemConfigDisplayRow,
} from "@/types/system-config";

export const systemConfigRepository = {
  // Backs the System Configuration page (um22-spec §22.3). Left-joins
  // `appuser` to resolve the modifier's display name; excludes
  // `is_secret = TRUE` rows so a secret config row is never read into app
  // memory, let alone rendered. Returns rows across all statuses (DRAFT,
  // ACTIVE, RETIRED) — status filtering is a display concern, not a query
  // concern.
  async findAllNonSecret(db: Database): Promise<SystemConfigDisplayRow[]> {
    const rows = await db
      .select({
        configId: systemConfig.configId,
        configGroup: systemConfig.configGroup,
        configVersion: systemConfig.configVersion,
        configKey: systemConfig.configKey,
        configValue: systemConfig.configValue,
        description: systemConfig.description,
        isSecret: systemConfig.isSecret,
        status: systemConfig.status,
        modifiedByUserId: systemConfig.modifiedBy,
        modifiedByName: appuser.userName,
        lastModifiedDatetime: systemConfig.lastModifiedDatetime,
      })
      .from(systemConfig)
      .leftJoin(appuser, eq(systemConfig.modifiedBy, appuser.id))
      .where(eq(systemConfig.isSecret, false))
      .orderBy(asc(systemConfig.configGroup), asc(systemConfig.configKey));

    return rows.map((row) => ({
      ...row,
      status: row.status as ConfigStatus,
      modifiedByName: row.modifiedByName ?? null,
    }));
  },

  // Backs the EDIT dialog's read (um23-spec §23.3). Same join shape as
  // `findAllNonSecret` above, but filtered to a single row and with no
  // `is_secret` filter — it returns any row by id, including secret ones,
  // so the write service can apply the secret-row guard itself.
  async findById(
    db: Database,
    configId: string,
  ): Promise<SystemConfigDisplayRow | null> {
    const rows = await db
      .select({
        configId: systemConfig.configId,
        configGroup: systemConfig.configGroup,
        configVersion: systemConfig.configVersion,
        configKey: systemConfig.configKey,
        configValue: systemConfig.configValue,
        description: systemConfig.description,
        isSecret: systemConfig.isSecret,
        status: systemConfig.status,
        modifiedByUserId: systemConfig.modifiedBy,
        modifiedByName: appuser.userName,
        lastModifiedDatetime: systemConfig.lastModifiedDatetime,
      })
      .from(systemConfig)
      .leftJoin(appuser, eq(systemConfig.modifiedBy, appuser.id))
      .where(eq(systemConfig.configId, configId))
      .limit(1);

    const row = rows[0];
    if (!row) return null;

    return {
      ...row,
      status: row.status as ConfigStatus,
      modifiedByName: row.modifiedByName ?? null,
    };
  },

  // Resolves a single non-secret ACTIVE config value by (group, key) for the
  // app-config read path (um28-spec §2.6) — branding logo, locale, currency.
  // The `ORDER BY config_version DESC` is load-bearing, not cosmetic: the
  // unique index is `(config_group, config_version, config_key)`, so two
  // ACTIVE rows for the same `(group, key)` at different versions can legally
  // coexist; without a deterministic order the returned row is
  // nondeterministic. `config_version DESC` makes "latest active version
  // wins" explicit. (All current seeds are version 1 — forward-hardening,
  // not a present bug.) Returns the value, or `null` for missing/RETIRED/
  // secret.
  async findActiveValue(
    db: Database,
    group: string,
    key: string,
  ): Promise<string | null> {
    const rows = await db
      .select({ configValue: systemConfig.configValue })
      .from(systemConfig)
      .where(
        and(
          eq(systemConfig.configGroup, group),
          eq(systemConfig.configKey, key),
          eq(systemConfig.status, "ACTIVE"),
          eq(systemConfig.isSecret, false),
        ),
      )
      .orderBy(desc(systemConfig.configVersion))
      .limit(1);

    return rows[0]?.configValue ?? null;
  },

  // Writes the new value + modifier (um23-spec §23.3). No permission check,
  // no audit write — both are the write service's responsibility. Always
  // called within the write service's transaction, so `db` here is a `tx`
  // handle in practice.
  async updateValue(
    db: Database,
    configId: string,
    configValue: string | null,
    modifiedBy: string,
  ): Promise<void> {
    await db
      .update(systemConfig)
      .set({
        configValue,
        modifiedBy,
        lastModifiedDatetime: new Date(),
      })
      .where(eq(systemConfig.configId, configId));
  },
};
