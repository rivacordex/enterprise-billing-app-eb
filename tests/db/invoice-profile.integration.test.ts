import { createHash } from "node:crypto";

import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { getInvoiceProfile } from "@/services/billing/invoice-profile/read-profile";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { InvoiceRenderError } from "@/types/billing";

// bm53-spec §Design D3/D4, §Tests row 4 — the `invoice.profile` read on a fresh
// DB (`core.system_config`), the typed parse failure, and the checksum-verified
// logo inline against a real Azurite. Requires DATABASE_URL; the logo cases
// also require BILLRUN_BLOB_CONNECTION_STRING (Azurite) and fail loudly when it
// is configured but unreachable.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

// Unique per run so write-once logo paths never collide on a persisted Azurite.
const RUN = `it-${Date.now().toString(36)}`;

// A minimal valid PNG (1×1). Bytes only matter for the checksum/data URI.
const LOGO = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==",
  "base64",
);

const PROFILE_ROWS: Record<string, string> = {
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
};

describe.skipIf(!databaseUrl)(
  "bm53 invoice profile read (requires DATABASE_URL)",
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

    async function insertProfileVersion(
      version: number,
      status: "DRAFT" | "ACTIVE" | "RETIRED",
      rows: Record<string, string>,
    ): Promise<void> {
      for (const [key, value] of Object.entries(rows)) {
        await sql`
          INSERT INTO core.system_config
            (config_group, config_version, config_key, config_value, is_secret, status)
          VALUES ('invoice.profile', ${version}, ${key}, ${value}, false, ${status})
        `;
      }
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      await dropAll();
      db = drizzle(sql, { schema }) as unknown as Database;
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
    }, 120_000);

    afterAll(async () => {
      if (sql) {
        await dropAll();
        await sql.end();
      }
    });

    it("no ACTIVE version → findActiveVersion is null (G15 A)", async () => {
      await insertProfileVersion(1, "DRAFT", PROFILE_ROWS);
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBeNull();
    });

    it("findActiveVersion picks the ACTIVE version, not a newer DRAFT or an older RETIRED one", async () => {
      await sql`UPDATE core.system_config SET status = 'RETIRED' WHERE config_group = 'invoice.profile' AND config_version = 1`;
      await insertProfileVersion(2, "ACTIVE", PROFILE_ROWS);
      await insertProfileVersion(3, "DRAFT", {
        ...PROFILE_ROWS,
        company_name: "Draft Co",
      });
      expect(await invoiceProfileRepository.findActiveVersion(db)).toBe(2);
    });

    it("never reads a secret-flagged row", async () => {
      await sql`
        INSERT INTO core.system_config
          (config_group, config_version, config_key, config_value, is_secret, status)
        VALUES ('invoice.profile', 2, 'smtp_password', 'hunter2', true, 'ACTIVE')
      `;
      const rows = await invoiceProfileRepository.readVersion(db, 2);
      expect(rows).not.toHaveProperty("smtp_password");
    });

    it("parses the ACTIVE version into InvoiceProfile (labels derived, no logo → logoUrl null)", async () => {
      const profile = await getInvoiceProfile(db, 2);
      expect(profile.configVersion).toBe(2);
      expect(profile.company.name).toBe("Digital Billing Sdn Bhd");
      expect(profile.company.state).toBe("Wilayah Persekutuan Kuala Lumpur");
      expect(profile.company.country).toBe("Malaysia");
      expect(profile.company.logoUrl).toBeNull();
      expect(profile.payment.swift).toBe("MBBEMYKL");
      expect(profile.paymentTermsDays).toBe(30);
    });

    it("a parse failure → INVOICE_PROFILE_INVALID (never a partial profile)", async () => {
      await insertProfileVersion(4, "DRAFT", { ...PROFILE_ROWS, tin: "BAD" });
      let caught: unknown;
      try {
        await getInvoiceProfile(db, 4);
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(InvoiceRenderError);
      expect((caught as InvoiceRenderError).code).toBe(
        "INVOICE_PROFILE_INVALID",
      );
      expect((caught as InvoiceRenderError).detail).toMatchObject({
        configVersion: 4,
      });
    });

    it("an unknown version → INVOICE_PROFILE_INVALID", async () => {
      await expect(getInvoiceProfile(db, 99)).rejects.toMatchObject({
        code: "INVOICE_PROFILE_INVALID",
      });
    });

    describe.skipIf(!blobConnection)("logo (requires Azurite)", () => {
      const service = blobConnection
        ? BlobServiceClient.fromConnectionString(blobConnection)
        : null;
      const logoPath = `${RUN}/v1/logo.png`;

      beforeAll(async () => {
        const container = service!.getContainerClient("invoice-assets");
        await container.createIfNotExists();
        await container.getBlockBlobClient(logoPath).uploadData(LOGO, {
          blobHTTPHeaders: { blobContentType: "image/png" },
        });
        await sql`INSERT INTO billing.bill_asset (bill_asset_id, kind, name) VALUES ('INVAST00000001', 'logo', 'Company logo')`;
        await sql`
          INSERT INTO billing.bill_asset_version
            (bill_asset_version_id, ref_bill_asset_id, version_no, mime, width, height, byte_size,
             blob_ref, checksum, checksum_algorithm)
          VALUES ('INVASV00000001', 'INVAST00000001', 1, 'image/png', 1, 1, ${LOGO.length},
                  ${`invoice-assets/${logoPath}`},
                  ${createHash("sha256").update(LOGO).digest("hex")}, 'sha256')
        `;
        await insertProfileVersion(5, "DRAFT", {
          ...PROFILE_ROWS,
          logo_asset_version_id: "INVASV00000001",
        });
      });

      afterAll(async () => {
        await service!
          .getContainerClient("invoice-assets")
          .deleteBlob(logoPath)
          .catch(() => undefined);
      });

      it("inlines the verified logo as a data: URI", async () => {
        const profile = await getInvoiceProfile(db, 5);
        expect(profile.logoAssetVersionId).toBe("INVASV00000001");
        expect(profile.company.logoUrl).toBe(
          `data:image/png;base64,${LOGO.toString("base64")}`,
        );
      });

      it("a tampered logo blob → ASSET_CHECKSUM_MISMATCH", async () => {
        const tampered = Buffer.from(LOGO);
        tampered[tampered.length - 1] = tampered[tampered.length - 1]! ^ 0x01;
        // Test-only raw SDK overwrite (bypasses write-once).
        await service!
          .getContainerClient("invoice-assets")
          .getBlockBlobClient(logoPath)
          .uploadData(tampered);
        await expect(getInvoiceProfile(db, 5)).rejects.toMatchObject({
          code: "ASSET_CHECKSUM_MISMATCH",
          detail: { assetVersionId: "INVASV00000001" },
        });
      });

      it("a profile naming an unknown logo version → INVOICE_PROFILE_INVALID", async () => {
        await insertProfileVersion(6, "DRAFT", {
          ...PROFILE_ROWS,
          logo_asset_version_id: "INVASV00000099",
        });
        await expect(getInvoiceProfile(db, 6)).rejects.toMatchObject({
          code: "INVOICE_PROFILE_INVALID",
        });
      });
    });
  },
);
