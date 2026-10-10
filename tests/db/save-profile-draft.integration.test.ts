import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { INVOICE_PROFILE_FIELD_LABELS } from "@/types/billing";
import { INVOICE_PROFILE_FIELD_KEYS } from "@/validation/billing/invoice-profile.schema";

// bm59-spec §Tests: save-profile-draft on a real database. The first save
// inserts every key at `max + 1` as DRAFT with `modified_by` (blanks NULL, the
// ACTIVE logo carried over); a second save updates only the changed keys; a
// stale token is DRAFT_CONFLICT with nothing written; two concurrent first
// saves allocate one version; each save writes exactly one
// INVOICE_PROFILE_DRAFT_SAVED row with the changed keys' before/after; the
// DRAFT is never resolved for rendering; and the generic System Config page
// still hides the group. The service opens its own transaction on the
// `@/db/client` singleton, so that singleton is replaced with one built on a
// real client (the bm57 precedent).
const databaseUrl = process.env.DATABASE_URL;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import {
  isProfileDraftRaceViolation,
  saveProfileDraft,
} from "@/services/billing/invoice-profile/save-profile-draft";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { systemConfigRepository } from "@/db/repositories/system-config.repository";
import type { Database } from "@/db/client";
import type { SaveProfileDraftInput } from "@/validation/billing/invoice-profile.schema";

const ACTOR = "bm59-actor";
const OTHER = "bm59-other";
const LOGO = "INVASV00000042";

const ACTIVE_ROWS: Record<string, string> = {
  company_name: "Digital Billing Sdn Bhd",
  registration_no: "202001000001",
  tin: "C12345678901",
  address_line1: "Level 10, Menara Billing",
  postcode: "50450",
  city: "Kuala Lumpur",
  state_code: "14",
  country_code: "MY",
  phone: "+60 3-2000 0000",
  email: "billing@digital-billing.example",
  brand_color: "#2E45A9",
  accent_color: "#006975",
  bank_name: "Maybank Berhad",
  bank_account_name: "Digital Billing Sdn Bhd",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  remittance_email: "ar@digital-billing.example",
  payment_terms_days: "30",
  logo_asset_version_id: LOGO,
};

// What the form posts after the action's parse: normalised, blanks absent.
function draftInput(
  overrides: Record<string, unknown> = {},
  expectedDraftToken: string | null = null,
): SaveProfileDraftInput {
  const fields: Record<string, unknown> = {
    company_name: "Digital Billing Sdn Bhd",
    tin: "C12345678901",
    city: "Kuala Lumpur",
    payment_terms_days: 30,
    country_code: "MY",
    ...overrides,
  };
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) delete fields[k];
  }
  return { fields, expectedDraftToken } as SaveProfileDraftInput;
}

interface ProfileRow {
  config_key: string;
  config_value: string | null;
  status: string;
  is_secret: boolean;
  modified_by: string | null;
  description: string | null;
  last_modified: string;
}

describe.skipIf(!databaseUrl)(
  "bm59 save company profile draft (requires DATABASE_URL)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    async function insertActive(version: number): Promise<void> {
      for (const [key, value] of Object.entries(ACTIVE_ROWS)) {
        await sql`
          INSERT INTO core.system_config
            (config_group, config_version, config_key, config_value, is_secret, status)
          VALUES ('invoice.profile', ${version}, ${key}, ${value}, false, 'ACTIVE')`;
      }
    }

    async function versionRows(version: number): Promise<ProfileRow[]> {
      return sql<ProfileRow[]>`
        SELECT config_key, config_value, status, is_secret, modified_by,
               description,
               to_char(last_modified_datetime, 'YYYY-MM-DD HH24:MI:SS.US') AS last_modified
        FROM core.system_config
        WHERE config_group = 'invoice.profile' AND config_version = ${version}
        ORDER BY config_key`;
    }

    async function auditRows(): Promise<
      {
        target_entity: string;
        target_id: string;
        actor_user_id: string;
        before_data: unknown;
        after_data: unknown;
      }[]
    > {
      return sql`
        SELECT target_entity, target_id, actor_user_id, before_data, after_data
        FROM core.audit_log
        WHERE event_type = 'INVOICE_PROFILE_DRAFT_SAVED'
        ORDER BY created_datetime`;
    }

    async function draftVersions(): Promise<number[]> {
      const rows = await sql<{ v: number }[]>`
        SELECT DISTINCT config_version AS v FROM core.system_config
        WHERE config_group = 'invoice.profile' AND status = 'DRAFT'
        ORDER BY v`;
      return rows.map((r) => r.v);
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 8, onnotice: () => {} });
      await dropAll();
      const drizzleDb = drizzle(sql, { schema });
      await migrate(drizzleDb, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      db = drizzleDb as unknown as Database;
      hoisted.holder.db = db;
      for (const [id, name] of [
        [ACTOR, "Profile Saver"],
        [OTHER, "Other Saver"],
      ] as const) {
        await sql`
          INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
          VALUES (${id}, ${name}, ${`${id}@example.com`}, 'LOCAL', 'ACTIVE')`;
      }
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    });

    beforeEach(async () => {
      await sql`DELETE FROM core.system_config WHERE config_group = 'invoice.profile'`;
      await sql`DELETE FROM core.audit_log WHERE event_type = 'INVOICE_PROFILE_DRAFT_SAVED'`;
      await insertActive(1);
    });

    it("the first save inserts every key at max+1 as DRAFT with modified_by; blanks are NULL; the ACTIVE logo is carried", async () => {
      const result = await saveProfileDraft(draftInput(), ACTOR);
      expect(result).toMatchObject({ ok: true, versionNo: 2 });

      const rows = await versionRows(2);
      expect(rows.map((r) => r.config_key).sort()).toEqual(
        [...INVOICE_PROFILE_FIELD_KEYS, "logo_asset_version_id"].sort(),
      );
      for (const row of rows) {
        expect(row.status).toBe("DRAFT");
        expect(row.is_secret).toBe(false);
        expect(row.modified_by).toBe(ACTOR);
        expect(row.description).toBe(
          INVOICE_PROFILE_FIELD_LABELS[row.config_key],
        );
      }
      const value = (k: string) =>
        rows.find((r) => r.config_key === k)?.config_value;
      expect(value("company_name")).toBe("Digital Billing Sdn Bhd");
      expect(value("payment_terms_days")).toBe("30");
      expect(value("swift")).toBeNull();
      expect(value("sst_reg_no")).toBeNull();
      expect(value("logo_asset_version_id")).toBe(LOGO);
      // No meta.* rows (bm61 writes them), and the ACTIVE version is untouched.
      expect(rows.some((r) => r.config_key.startsWith("meta."))).toBe(false);
      expect((await versionRows(1)).every((r) => r.status === "ACTIVE")).toBe(
        true,
      );
    });

    it("the token is max(last_modified_datetime) of the draft's rows", async () => {
      const result = await saveProfileDraft(draftInput(), ACTOR);
      const [row] = await sql<{ token: string }[]>`
        SELECT to_char(max(last_modified_datetime) AT TIME ZONE 'UTC',
                       'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS token
        FROM core.system_config
        WHERE config_group = 'invoice.profile' AND config_version = 2`;
      expect(result.ok && result.draftToken).toBe(row?.token);
    });

    it("a second save updates only the changed keys, under a new token", async () => {
      const first = await saveProfileDraft(draftInput(), ACTOR);
      if (!first.ok) throw new Error("first save failed");
      const before = await versionRows(2);

      const second = await saveProfileDraft(
        draftInput(
          { city: "Putrajaya", tin: undefined, swift: "MBBEMYKL" },
          first.draftToken,
        ),
        OTHER,
      );
      expect(second).toMatchObject({ ok: true, versionNo: 2 });
      expect(second.ok && second.draftToken).not.toBe(first.draftToken);

      const after = await versionRows(2);
      const changed = after
        .filter((r) => {
          const old = before.find((b) => b.config_key === r.config_key)!;
          return r.last_modified !== old.last_modified;
        })
        .map((r) => r.config_key)
        .sort();
      expect(changed).toEqual(["city", "swift", "tin"]);
      for (const r of after) {
        expect(r.modified_by).toBe(
          changed.includes(r.config_key) ? OTHER : ACTOR,
        );
      }
      expect(
        after.find((r) => r.config_key === "tin")?.config_value,
      ).toBeNull();
      expect(after.find((r) => r.config_key === "city")?.config_value).toBe(
        "Putrajaya",
      );
      expect(await draftVersions()).toEqual([2]);
    });

    it("a stale token is DRAFT_CONFLICT and writes nothing", async () => {
      const first = await saveProfileDraft(draftInput(), ACTOR);
      if (!first.ok) throw new Error("first save failed");
      const second = await saveProfileDraft(
        draftInput({ city: "Ipoh" }, first.draftToken),
        ACTOR,
      );
      if (!second.ok) throw new Error("second save failed");
      const rowsBefore = await versionRows(2);
      const auditBefore = (await auditRows()).length;

      // A third save still holding the FIRST token.
      const stale = await saveProfileDraft(
        draftInput({ city: "Melaka" }, first.draftToken),
        OTHER,
      );
      expect(stale).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await versionRows(2)).toEqual(rowsBefore);
      expect(await auditRows()).toHaveLength(auditBefore);
    });

    it("a wrong belief about the draft's existence is DRAFT_CONFLICT", async () => {
      // A token while no draft exists.
      expect(
        await saveProfileDraft(
          draftInput({}, "2026-10-10T01:02:03.123456Z"),
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await draftVersions()).toEqual([]);
      // No token while a draft exists.
      await saveProfileDraft(draftInput(), ACTOR);
      expect(await saveProfileDraft(draftInput(), OTHER)).toEqual({
        ok: false,
        code: "DRAFT_CONFLICT",
      });
      expect(await draftVersions()).toEqual([2]);
    });

    it("two concurrent first saves allocate one version: one winner, one DRAFT_CONFLICT", async () => {
      for (let round = 0; round < 3; round++) {
        await sql`DELETE FROM core.system_config WHERE config_group = 'invoice.profile' AND status = 'DRAFT'`;
        await sql`DELETE FROM core.audit_log WHERE event_type = 'INVOICE_PROFILE_DRAFT_SAVED'`;
        const results = await Promise.all([
          saveProfileDraft(draftInput({ city: "A" }), ACTOR),
          saveProfileDraft(draftInput({ city: "B" }), OTHER),
        ]);
        expect(results.filter((r) => r.ok)).toHaveLength(1);
        expect(results.filter((r) => !r.ok)).toEqual([
          { ok: false, code: "DRAFT_CONFLICT" },
        ]);
        expect(await draftVersions()).toEqual([2]);
        expect(await auditRows()).toHaveLength(1);
      }
    });

    it("writes exactly one audit row per save, with the changed keys' before/after", async () => {
      const first = await saveProfileDraft(draftInput(), ACTOR);
      if (!first.ok) throw new Error("first save failed");
      await saveProfileDraft(
        draftInput({ city: "Putrajaya", bank_name: "CIMB" }, first.draftToken),
        OTHER,
      );

      const audit = await auditRows();
      expect(audit).toHaveLength(2);
      expect(audit[0]).toMatchObject({
        target_entity: "SYSTEM_CONFIG",
        target_id: "invoice.profile:v2",
        actor_user_id: ACTOR,
        before_data: null,
      });
      const created = audit[0]!.after_data as {
        configVersion: number;
        fields: Record<string, string | null>;
      };
      expect(created.configVersion).toBe(2);
      expect(Object.keys(created.fields).sort()).toEqual(
        [...INVOICE_PROFILE_FIELD_KEYS, "logo_asset_version_id"].sort(),
      );
      expect(audit[1]).toMatchObject({
        target_id: "invoice.profile:v2",
        actor_user_id: OTHER,
        before_data: {
          configVersion: 2,
          fields: { city: "Kuala Lumpur", bank_name: null },
        },
        after_data: {
          configVersion: 2,
          fields: { city: "Putrajaya", bank_name: "CIMB" },
        },
      });
    });

    it("an invalid value is VALIDATION_ERROR and writes nothing", async () => {
      const result = await saveProfileDraft(
        draftInput({ tin: "C123", swift: "bad" }),
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "VALIDATION_ERROR" });
      expect(await draftVersions()).toEqual([]);
      expect(await auditRows()).toHaveLength(0);
    });

    it("the DRAFT is never resolved for rendering", async () => {
      await saveProfileDraft(draftInput({ company_name: "Draft Co" }), ACTOR);
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBe(1);

      // With no ACTIVE version at all, a DRAFT still resolves to nothing.
      await sql`UPDATE core.system_config SET status = 'RETIRED' WHERE config_group = 'invoice.profile' AND config_version = 1`;
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBeNull();
    });

    it("the generic System Config page still hides the profile rows, draft included", async () => {
      await saveProfileDraft(draftInput(), ACTOR);
      const rows = await systemConfigRepository.findAllNonSecret(db);
      expect(rows.some((r) => r.configGroup === "invoice.profile")).toBe(false);
    });

    it("only a unique violation on the version key counts as a lost draft race", async () => {
      let caught: unknown;
      try {
        await sql`
          INSERT INTO core.system_config
            (config_group, config_version, config_key, config_value, is_secret, status)
          VALUES ('invoice.profile', 1, 'company_name', 'Dup', false, 'DRAFT')`;
      } catch (error) {
        caught = error;
      }
      expect(isProfileDraftRaceViolation(caught)).toBe(true);
      expect(
        isProfileDraftRaceViolation({ code: "23505", constraint_name: "x" }),
      ).toBe(false);
    });
  },
);
