import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import {
  afterAll,
  afterEach,
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

// bm60-spec §Tests: the logo upload on a real database and a real Azurite. A
// valid PNG creates the INVAST/INVASV rows, stores the exact bytes at the
// content-addressed path (digest verified), points the DRAFT profile at the
// new version and writes one audit row; re-uploading the same bytes adds a
// version over the same blob; no draft is DRAFT_CONFLICT; and a DB failure
// after the blob write leaves an orphan blob, no row and no audit. The
// service uses the `@/db/client` singleton, so it is replaced with one built
// on a real client (the bm57/bm58 precedent).
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { getVerifiedLogo } from "@/services/billing/invoice-profile/read-profile";
import { saveProfileDraft } from "@/services/billing/invoice-profile/save-profile-draft";
import { uploadLogo } from "@/services/billing/invoice-profile/upload-logo";
import type { Database } from "@/db/client";
import type { SaveProfileDraftInput } from "@/validation/billing/invoice-profile.schema";

const ACTOR = "bm60-actor";
let saves = 0;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm60 upload logo (requires DATABASE_URL + Azurite)",
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

    async function blobNames(): Promise<string[]> {
      const names: string[] = [];
      for await (const b of assets().listBlobsFlat({ prefix: "INVAST" })) {
        names.push(b.name);
      }
      return names.sort();
    }

    async function newDraft(): Promise<string> {
      const existing = await invoiceProfileRepository.findDraftVersion(db);
      const saved = await saveProfileDraft(
        {
          fields: { company_name: `Logo Co ${++saves}`, country_code: "MY" },
          expectedDraftToken: existing?.token ?? null,
        } as SaveProfileDraftInput,
        ACTOR,
      );
      if (!saved.ok) throw new Error(`save draft failed: ${saved.code}`);
      return saved.draftToken;
    }

    async function versionRows() {
      return sql<
        {
          bill_asset_version_id: string;
          ref_bill_asset_id: string;
          version_no: number;
          mime: string;
          width: number;
          height: number;
          byte_size: number;
          blob_ref: string;
          checksum: string;
          checksum_algorithm: string;
          status: string;
          created_by: string;
        }[]
      >`SELECT * FROM billing.bill_asset_version ORDER BY version_no`;
    }

    async function draftLogo(): Promise<string | null> {
      const draft = await invoiceProfileRepository.findDraftVersion(db);
      if (!draft) return null;
      return (
        (await invoiceProfileRepository.readVersion(db, draft.configVersion))
          .logo_asset_version_id ?? null
      );
    }

    async function auditRows() {
      return sql<
        {
          target_entity: string;
          target_id: string;
          before_data: unknown;
          after_data: unknown;
        }[]
      >`
        SELECT target_entity, target_id, before_data, after_data
        FROM core.audit_log WHERE event_type = 'INVOICE_LOGO_UPLOADED'
        ORDER BY created_datetime`;
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
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${ACTOR}, 'Logo Admin', 'logo-admin@example.com', 'LOCAL', 'ACTIVE')`;
      // Asset ids restart per migrate, so clear what an earlier run stored.
      await clearAssetBlobs();
    }, 180_000);

    beforeEach(async () => {
      await sql`DELETE FROM core.audit_log WHERE event_type = 'INVOICE_LOGO_UPLOADED'`;
    });

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      await clearAssetBlobs();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 120_000);

    it("no draft → DRAFT_CONFLICT, nothing stored", async () => {
      const result = await uploadLogo(
        {
          bytes: png(400, 300),
          declaredMime: "image/png",
          expectedDraftToken: "2026-10-10T01:02:03.123456Z",
        },
        ACTOR,
      );
      expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await versionRows()).toEqual([]);
      expect(await blobNames()).toEqual([]);
      expect(await auditRows()).toHaveLength(0);
    });

    it("an empty logo asset (a failed first upload) is not a stored logo: the import stays offered (bm60 D8)", async () => {
      await db.transaction((tx) =>
        billAssetRepository.ensureLogoAsset(tx, ACTOR),
      );
      expect(await billAssetRepository.findLogoAsset(db)).not.toBeNull();
      expect(await billAssetRepository.hasLogoVersion(db)).toBe(false);
    });

    it("a valid PNG → INVAST/INVASV rows, the exact bytes at the content-addressed path, the draft pointed at it, one audit row", async () => {
      const token = await newDraft();
      const bytes = png(400, 300);
      const digest = sha256(bytes);
      const result = await uploadLogo(
        { bytes, declaredMime: "image/png", expectedDraftToken: token },
        ACTOR,
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      expect(result.assetVersionId).toMatch(/^INVASV\d{8}$/);
      expect(result.versionNo).toBe(1);

      const [asset] = await sql<
        { bill_asset_id: string; kind: string; name: string }[]
      >`SELECT bill_asset_id, kind, name FROM billing.bill_asset`;
      expect(asset).toMatchObject({ kind: "logo", name: "Company logo" });
      expect(asset!.bill_asset_id).toMatch(/^INVAST\d{8}$/);

      const path = `${asset!.bill_asset_id}/sha256-${digest.slice(0, 12)}/logo.png`;
      expect(await versionRows()).toEqual([
        expect.objectContaining({
          bill_asset_version_id: result.assetVersionId,
          ref_bill_asset_id: asset!.bill_asset_id,
          version_no: 1,
          status: "ACTIVE",
          mime: "image/png",
          width: 400,
          height: 300,
          byte_size: bytes.length,
          blob_ref: `invoice-assets/${path}`,
          checksum: digest,
          checksum_algorithm: "sha256",
          created_by: ACTOR,
        }),
      ]);

      // Stored bytes = uploaded bytes, and the digest matches.
      const stored = await assets().getBlockBlobClient(path).downloadToBuffer();
      expect(stored.equals(bytes)).toBe(true);
      expect(sha256(stored)).toBe(digest);
      // The bm56 GET route's checksum-verified read serves it.
      const served = await getVerifiedLogo(db, result.assetVersionId);
      expect(served?.mime).toBe("image/png");
      expect(served?.bytes.equals(bytes)).toBe(true);

      expect(await draftLogo()).toBe(result.assetVersionId);
      const audit = await auditRows();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        target_entity: "BILL_ASSET_VERSION",
        target_id: result.assetVersionId,
        before_data: { previousDraftLogoAssetVersionId: null },
        after_data: {
          assetId: asset!.bill_asset_id,
          assetVersionId: result.assetVersionId,
          versionNo: 1,
          mime: "image/png",
          width: 400,
          height: 300,
          byteSize: bytes.length,
          checksum: digest,
        },
      });
      // The empty asset from the previous test was reused, and now holds a
      // version: the first-setup import is no longer offered.
      expect(await billAssetRepository.hasLogoVersion(db)).toBe(true);
    });

    it("re-uploading the same bytes adds a version over the same blob", async () => {
      const draft = await invoiceProfileRepository.findDraftVersion(db);
      const before = await versionRows();
      const previous = await draftLogo();
      const result = await uploadLogo(
        {
          bytes: png(400, 300),
          declaredMime: "image/png",
          expectedDraftToken: draft!.token,
        },
        ACTOR,
      );
      if (!result.ok) throw new Error(JSON.stringify(result));
      const after = await versionRows();
      expect(after).toHaveLength(before.length + 1);
      expect(after.at(-1)!.version_no).toBe(2);
      expect(after.at(-1)!.blob_ref).toBe(before.at(-1)!.blob_ref);
      expect(await blobNames()).toHaveLength(1);
      expect(await draftLogo()).toBe(result.assetVersionId);
      expect((await auditRows())[0]?.before_data).toEqual({
        previousDraftLogoAssetVersionId: previous,
      });
      // Earlier versions are never retired (profiles pin them).
      expect(after.every((r) => r.status === "ACTIVE")).toBe(true);
    });

    it("a stale token is DRAFT_CONFLICT and writes no row", async () => {
      const before = await versionRows();
      const draft = await invoiceProfileRepository.findDraftVersion(db);
      const fresh = await newDraft(); // moves the token on
      expect(fresh).not.toBe(draft!.token);
      expect(
        await uploadLogo(
          {
            bytes: png(500, 500),
            declaredMime: "image/png",
            expectedDraftToken: draft!.token,
          },
          ACTOR,
        ),
      ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await versionRows()).toEqual(before);
      expect(await auditRows()).toHaveLength(0);
    });

    it("a DB failure after the blob write leaves an orphan blob, no row and no audit", async () => {
      const draft = await invoiceProfileRepository.findDraftVersion(db);
      const before = await versionRows();
      const logoBefore = await draftLogo();
      const bytes = png(640, 480);
      vi.spyOn(invoiceProfileRepository, "setDraftLogo").mockRejectedValueOnce(
        new Error("injected: setDraftLogo failed"),
      );
      await expect(
        uploadLogo(
          {
            bytes,
            declaredMime: "image/png",
            expectedDraftToken: draft!.token,
          },
          ACTOR,
        ),
      ).rejects.toThrow("injected");

      const orphan = `${before[0]!.ref_bill_asset_id}/sha256-${sha256(bytes).slice(0, 12)}/logo.png`;
      expect(await blobNames()).toContain(orphan);
      expect(await versionRows()).toEqual(before);
      expect(await draftLogo()).toBe(logoBefore);
      expect(await auditRows()).toHaveLength(0);
    });

    it("a rejected file stores nothing", async () => {
      const draft = await invoiceProfileRepository.findDraftVersion(db);
      const blobs = await blobNames();
      const before = await versionRows();
      expect(
        await uploadLogo(
          {
            bytes: png(200, 200),
            declaredMime: "image/png",
            expectedDraftToken: draft!.token,
          },
          ACTOR,
        ),
      ).toMatchObject({
        ok: false,
        code: "LOGO_REJECTED",
        reason: "dimensions",
      });
      expect(await blobNames()).toEqual(blobs);
      expect(await versionRows()).toEqual(before);
    });
  },
);
