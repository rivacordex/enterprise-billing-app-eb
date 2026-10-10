import { BlobServiceClient } from "@azure/storage-blob";
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
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { png } from "@/tests/helpers/logo-fixtures";

// bm61-spec §Tests — GUARDRAIL 51, ACTIVATION HALF, on a real database and a
// real Azurite. Each refusal (no logo, empty note, an incomplete required
// field, a stale token, a tampered logo blob) changes nothing: the same rows,
// statuses and audit rows as before. Success promotes the DRAFT, retires the
// previous ACTIVE, writes `meta.*` and exactly one INVOICE_PROFILE_ACTIVATED
// row with `bankDetailsChanged`. No four-eyes (G14 decided 2026-10-11): the
// draft's own editor may activate it, bank changes included. Also closes
// DR-01: an invalid draft can never become ACTIVE, and the previous ACTIVE
// stays untouched.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { activateProfile } from "@/services/billing/invoice-profile/activate-profile";
import { saveProfileDraft } from "@/services/billing/invoice-profile/save-profile-draft";
import { uploadLogo } from "@/services/billing/invoice-profile/upload-logo";
import type { Database } from "@/db/client";
import type { SaveProfileDraftInput } from "@/validation/billing/invoice-profile.schema";

const EDITOR = "bm61-editor";
const APPROVER = "bm61-approver";

const FULL: Record<string, unknown> = {
  company_name: "Activated Co Sdn Bhd",
  registration_no: "202001000001",
  tin: "C12345678901",
  address_line1: "Level 10, Menara Billing",
  postcode: "50450",
  city: "Kuala Lumpur",
  state_code: "14",
  country_code: "MY",
  phone: "+60 3-2000 0000",
  email: "billing@activated.example",
  brand_color: "#2E45A9",
  accent_color: "#006975",
  bank_name: "Maybank Berhad",
  bank_account_name: "Activated Co Sdn Bhd",
  bank_account_no: "5140-1234-5678",
  swift: "MBBEMYKL",
  remittance_email: "ar@activated.example",
  payment_terms_days: 30,
};

let logoSeq = 0;

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm61 activate company profile — guardrail 51 activation half (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const assets = () => service!.getContainerClient("invoice-assets");

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

    async function clearAssetBlobs(): Promise<void> {
      if (!service) return;
      await assets().createIfNotExists();
      for await (const b of assets().listBlobsFlat({ prefix: "INVAST" })) {
        await assets()
          .deleteBlob(b.name)
          .catch(() => undefined);
      }
    }

    // Save (or update) the working draft as `saver` and return its version
    // and token.
    async function saveDraft(
      fields: Record<string, unknown>,
      saver: string,
    ): Promise<{ version: number; token: string }> {
      const existing = await invoiceProfileRepository.findDraftVersion(db);
      const saved = await saveProfileDraft(
        {
          fields,
          expectedDraftToken: existing?.token ?? null,
        } as SaveProfileDraftInput,
        saver,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      return { version: saved.versionNo, token: saved.draftToken };
    }

    // Upload a fresh (distinct) logo onto the draft as `uploader`.
    async function addLogo(
      token: string,
      uploader: string,
    ): Promise<{ token: string; assetVersionId: string; blobPath: string }> {
      const bytes = png(400 + ++logoSeq, 300);
      const result = await uploadLogo(
        { bytes, declaredMime: "image/png", expectedDraftToken: token },
        uploader,
      );
      if (!result.ok)
        throw new Error(`upload failed: ${JSON.stringify(result)}`);
      const [row] = await sql<{ blob_ref: string }[]>`
        SELECT blob_ref FROM billing.bill_asset_version
        WHERE bill_asset_version_id = ${result.assetVersionId}`;
      return {
        token: result.draftToken,
        assetVersionId: result.assetVersionId,
        blobPath: row!.blob_ref.slice("invoice-assets/".length),
      };
    }

    // A complete draft saved by `saver`, with a logo uploaded by `uploader`.
    async function readyDraft(
      fields: Record<string, unknown> = FULL,
      saver = EDITOR,
      uploader = EDITOR,
    ): Promise<{ version: number; token: string }> {
      const { version, token } = await saveDraft(fields, saver);
      const logo = await addLogo(token, uploader);
      return { version, token: logo.token };
    }

    async function snapshot() {
      const rows = await sql`
        SELECT config_version, config_key, config_value, status
        FROM core.system_config WHERE config_group = 'invoice.profile'
        ORDER BY config_version, config_key`;
      const [audit] = await sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.audit_log
        WHERE event_type = 'INVOICE_PROFILE_ACTIVATED'`;
      return { rows, audits: audit!.n };
    }

    async function statusOf(version: number): Promise<string[]> {
      const rows = await sql<{ status: string }[]>`
        SELECT DISTINCT status FROM core.system_config
        WHERE config_group = 'invoice.profile' AND config_version = ${version}`;
      return rows.map((r) => r.status);
    }

    async function metaOf(version: number): Promise<Record<string, string>> {
      const rows = await sql<{ config_key: string; config_value: string }[]>`
        SELECT config_key, config_value FROM core.system_config
        WHERE config_group = 'invoice.profile' AND config_version = ${version}
          AND config_key LIKE 'meta.%'`;
      return Object.fromEntries(
        rows.map((r) => [r.config_key, r.config_value]),
      );
    }

    async function activationAudits() {
      return sql<
        {
          actor_user_id: string;
          target_entity: string;
          target_id: string;
          before_data: Record<string, unknown> | null;
          after_data: Record<string, unknown>;
        }[]
      >`
        SELECT actor_user_id, target_entity, target_id, before_data, after_data
        FROM core.audit_log WHERE event_type = 'INVOICE_PROFILE_ACTIVATED'
        ORDER BY created_datetime`;
    }

    async function expectRefused(
      call: () => Promise<unknown>,
      expected: unknown,
    ): Promise<void> {
      const before = await snapshot();
      expect(await call()).toEqual(expected);
      expect(await snapshot()).toEqual(before);
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      // The cleanup deletes blobs, so guard the blob store like the DB.
      assertTestBlobConnection(blobConnection as string);
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
        [EDITOR, "Profile Editor"],
        [APPROVER, "Profile Approver"],
      ] as const) {
        await sql`
          INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
          VALUES (${id}, ${name}, ${`${id}@example.com`}, 'LOCAL', 'ACTIVE')`;
      }
      await clearAssetBlobs();
    }, 180_000);

    beforeEach(async () => {
      await sql`DELETE FROM core.system_config WHERE config_group = 'invoice.profile'`;
      await sql`DELETE FROM core.audit_log WHERE event_type = 'INVOICE_PROFILE_ACTIVATED'`;
    });

    afterAll(async () => {
      await clearAssetBlobs();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 120_000);

    it("refuses a draft without a logo: PROFILE_LOGO_REQUIRED, nothing changed", async () => {
      const { version, token } = await saveDraft(FULL, EDITOR);
      await expectRefused(
        () =>
          activateProfile(
            {
              configVersion: version,
              expectedDraftToken: token,
              changeNote: "go",
            },
            APPROVER,
          ),
        { ok: false, code: "PROFILE_LOGO_REQUIRED" },
      );
    });

    it("refuses an empty (blank) note: CHANGE_NOTE_REQUIRED, nothing changed", async () => {
      const { version, token } = await readyDraft();
      await expectRefused(
        () =>
          activateProfile(
            {
              configVersion: version,
              expectedDraftToken: token,
              changeNote: "   ",
            },
            APPROVER,
          ),
        { ok: false, code: "CHANGE_NOTE_REQUIRED" },
      );
    });

    it("refuses an incomplete required field: VALIDATION_ERROR naming it, nothing changed", async () => {
      const { swift: _swift, city: _city, ...partial } = FULL;
      const { version, token } = await readyDraft(partial);
      const before = await snapshot();
      const result = await activateProfile(
        { configVersion: version, expectedDraftToken: token, changeNote: "go" },
        APPROVER,
      );
      expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      const { fieldErrors } = result as {
        fieldErrors: Record<string, string[]>;
      };
      expect(Object.keys(fieldErrors).sort()).toEqual(["city", "swift"]);
      expect(await snapshot()).toEqual(before);
    });

    it("refuses a stale token and a wrong version: DRAFT_CONFLICT, nothing changed", async () => {
      const { version, token } = await readyDraft();
      // A later save moves the token on.
      const later = await saveDraft({ ...FULL, city: "Putrajaya" }, EDITOR);
      expect(later.token).not.toBe(token);
      await expectRefused(
        () =>
          activateProfile(
            {
              configVersion: version,
              expectedDraftToken: token,
              changeNote: "go",
            },
            APPROVER,
          ),
        { ok: false, code: "DRAFT_CONFLICT" },
      );
      await expectRefused(
        () =>
          activateProfile(
            {
              configVersion: version + 1,
              expectedDraftToken: later.token,
              changeNote: "go",
            },
            APPROVER,
          ),
        { ok: false, code: "DRAFT_CONFLICT" },
      );
    });

    it("refuses a tampered logo blob: ASSET_CHECKSUM_MISMATCH, nothing changed", async () => {
      const { version, token } = await saveDraft(FULL, EDITOR);
      const logo = await addLogo(token, EDITOR);
      // Overwrite the stored bytes behind the recorded checksum.
      await assets()
        .getBlockBlobClient(logo.blobPath)
        .uploadData(png(999, 999));
      await expectRefused(
        () =>
          activateProfile(
            {
              configVersion: version,
              expectedDraftToken: logo.token,
              changeNote: "go",
            },
            APPROVER,
          ),
        { ok: false, code: "ASSET_CHECKSUM_MISMATCH" },
      );
    });

    it("the first activation sets bank details and may be done by the draft's own editor and logo uploader (G14: no four-eyes)", async () => {
      const { version, token } = await readyDraft(FULL, EDITOR, EDITOR);
      const result = await activateProfile(
        {
          configVersion: version,
          expectedDraftToken: token,
          changeNote: "First company profile",
        },
        EDITOR,
      );
      expect(result).toEqual({
        ok: true,
        configVersion: version,
        retiredVersion: null,
      });
      expect(await statusOf(version)).toEqual(["ACTIVE"]);
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBe(
        version,
      );
      const meta = await metaOf(version);
      expect(meta["meta.change_note"]).toBe("First company profile");
      expect(meta["meta.activated_by"]).toBe(EDITOR);
      expect(Number.isNaN(Date.parse(meta["meta.activated_at"]!))).toBe(false);
      const audits = await activationAudits();
      expect(audits).toHaveLength(1);
      expect(audits[0]).toMatchObject({
        actor_user_id: EDITOR,
        target_entity: "SYSTEM_CONFIG",
        target_id: `invoice.profile:v${version}`,
        before_data: { activeVersion: null, fields: null },
        after_data: {
          activatedVersion: version,
          retiredVersion: null,
          changeNote: "First company profile",
          bankDetailsChanged: true,
        },
      });
    });

    it("success retires the previous ACTIVE (+ meta.retired_at); a non-bank change may be activated by its own editor", async () => {
      const v1 = await readyDraft(FULL, EDITOR, EDITOR);
      const first = await activateProfile(
        {
          configVersion: v1.version,
          expectedDraftToken: v1.token,
          changeNote: "v1",
        },
        APPROVER,
      );
      expect(first.ok).toBe(true);

      // v2 changes only the city (the ACTIVE logo is carried over, bm59 D1).
      const v2 = await saveDraft({ ...FULL, city: "Putrajaya" }, EDITOR);
      expect(v2.version).toBe(v1.version + 1);
      const second = await activateProfile(
        {
          configVersion: v2.version,
          expectedDraftToken: v2.token,
          changeNote: "New office city",
        },
        EDITOR,
      );
      expect(second).toEqual({
        ok: true,
        configVersion: v2.version,
        retiredVersion: v1.version,
      });

      expect(await statusOf(v1.version)).toEqual(["RETIRED"]);
      expect(await statusOf(v2.version)).toEqual(["ACTIVE"]);
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBe(
        v2.version,
      );
      expect(
        Number.isNaN(
          Date.parse((await metaOf(v1.version))["meta.retired_at"]!),
        ),
      ).toBe(false);
      // v1 keeps its own activation meta.
      expect((await metaOf(v1.version))["meta.change_note"]).toBe("v1");

      const audits = await activationAudits();
      expect(audits).toHaveLength(2);
      expect(audits[1]).toMatchObject({
        actor_user_id: EDITOR,
        before_data: {
          activeVersion: v1.version,
          fields: expect.objectContaining({ city: "Kuala Lumpur" }),
        },
        after_data: {
          activatedVersion: v2.version,
          retiredVersion: v1.version,
          changeNote: "New office city",
          bankDetailsChanged: false,
          fields: expect.objectContaining({ city: "Putrajaya" }),
        },
      });
      // The history still names the editor, not the activator.
      const history = await invoiceProfileRepository.listVersions(db);
      expect(
        history.find((h) => h.configVersion === v2.version)?.modifiedBy,
      ).toBe(EDITOR);
    });

    it("a bank change against the ACTIVE version may be activated by its own editor and is audited as bankDetailsChanged", async () => {
      const v1 = await readyDraft(FULL, EDITOR, EDITOR);
      expect(
        (
          await activateProfile(
            {
              configVersion: v1.version,
              expectedDraftToken: v1.token,
              changeNote: "v1",
            },
            EDITOR,
          )
        ).ok,
      ).toBe(true);

      const v2 = await saveDraft(
        { ...FULL, bank_account_no: "9999-0000-1111" },
        EDITOR,
      );
      const ok = await activateProfile(
        {
          configVersion: v2.version,
          expectedDraftToken: v2.token,
          changeNote: "new bank",
        },
        EDITOR,
      );
      expect(ok).toMatchObject({ ok: true, retiredVersion: v1.version });
      const audits = await activationAudits();
      expect(audits.at(-1)).toMatchObject({
        actor_user_id: EDITOR,
        after_data: { bankDetailsChanged: true },
      });
    });

    it("a refused invalid draft leaves the previous ACTIVE version untouched (DR-01)", async () => {
      const v1 = await readyDraft(FULL, EDITOR, EDITOR);
      await activateProfile(
        {
          configVersion: v1.version,
          expectedDraftToken: v1.token,
          changeNote: "v1",
        },
        APPROVER,
      );
      const { tin: _tin, ...broken } = FULL;
      const v2 = await saveDraft(broken, EDITOR);
      const result = await activateProfile(
        {
          configVersion: v2.version,
          expectedDraftToken: v2.token,
          changeNote: "x",
        },
        APPROVER,
      );
      expect(result).toMatchObject({ ok: false, code: "VALIDATION_ERROR" });
      expect(await statusOf(v1.version)).toEqual(["ACTIVE"]);
      expect(await statusOf(v2.version)).toEqual(["DRAFT"]);
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBe(
        v1.version,
      );
    });
  },
);
