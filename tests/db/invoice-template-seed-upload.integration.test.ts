import {
  cpSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import type { Database } from "@/db/client";
import * as schema from "@/db/schema";
import {
  DEFAULT_SEED_REPO_ROOT,
  SeedInvoiceTemplatesError,
  seedInvoiceTemplates,
} from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import type { BlobContainer } from "@/types/billing";

// bm53-spec §Design D6, §Tests row 5 — `db:seed-invoice-templates` against a
// fresh DB (the 0046 seed rows) and a REAL Azurite. Every case routes the
// seed's puts through the real `blobStore.putObject` under a unique per-case
// path prefix, so the suite never touches the real seeded paths on a shared
// Azurite and re-runs never collide (write-once paths). Requires DATABASE_URL
// and BILLRUN_BLOB_CONNECTION_STRING.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;
const RUN = `it-${Date.now().toString(36)}`;

// The three seeded version directories (repo-relative) and their file counts
// incl. `checksums.json`, derived from the committed indexes.
const SEED_DIRS = ["INVTPL-STD-A4/v1", "generated/INVOICE/v1", "system/csv/v1"];
const EXPECTED_FILE_COUNT = SEED_DIRS.reduce((n, dir) => {
  const index = JSON.parse(
    readFileSync(
      path.join(DEFAULT_SEED_REPO_ROOT, dir, "checksums.json"),
      "utf-8",
    ),
  ) as { files: Record<string, string> };
  return n + Object.keys(index.files).length + 1;
}, 0);

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm53 invoice template seed upload (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const created: string[] = [];
    const tempDirs: string[] = [];

    // The real store, under `${RUN}/${prefix}/…`, recording every put.
    function prefixedStore(prefix: string, calls: string[] = []) {
      return {
        putObject: (
          container: BlobContainer,
          blobPath: string,
          ...rest: Parameters<typeof blobStore.putObject> extends [
            unknown,
            unknown,
            ...infer R,
          ]
            ? R
            : never
        ) => {
          const p = `${RUN}/${prefix}/${blobPath}`;
          calls.push(p);
          created.push(p);
          return blobStore.putObject(container, p, ...rest);
        },
      };
    }

    function editedRepoCopy(): string {
      const dir = mkdtempSync(path.join(tmpdir(), "bm53-seed-"));
      tempDirs.push(dir);
      cpSync(DEFAULT_SEED_REPO_ROOT, dir, { recursive: true });
      const file = path.join(dir, "generated/INVOICE/v1/footer.hbs");
      writeFileSync(file, `${readFileSync(file, "utf-8")}<!-- edited -->\n`);
      return dir;
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
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
      db = drizzle(sql, { schema }) as unknown as Database;
      await migrate(db, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      await service!
        .getContainerClient("invoice-templates")
        .createIfNotExists();
    }, 120_000);

    afterAll(async () => {
      const container = service?.getContainerClient("invoice-templates");
      for (const p of new Set(created)) {
        await container?.deleteBlob(p).catch(() => undefined);
      }
      for (const d of tempDirs) rmSync(d, { recursive: true, force: true });
      if (sql) await sql.end();
    });

    it("first run uploads every seeded file; a second run uploads nothing", async () => {
      const first = await seedInvoiceTemplates(db, {
        store: prefixedStore("idem"),
      });
      expect(first.uploaded).toHaveLength(EXPECTED_FILE_COUNT);
      expect(first.existing).toEqual([]);
      expect(first.uploaded).toContain(
        `invoice-templates/${RUN}/idem/generated/INVOICE/v1/invoice.hbs`,
      );
      // The layout uploads under its `layouts/` blob path.
      expect(first.uploaded).toContain(
        `invoice-templates/${RUN}/idem/layouts/INVTPL-STD-A4/v1/manifest.json`,
      );

      const second = await seedInvoiceTemplates(db, {
        store: prefixedStore("idem"),
      });
      expect(second.uploaded).toEqual([]);
      expect(second.existing).toHaveLength(EXPECTED_FILE_COUNT);
    });

    it("stores the exact repo bytes with the D6 content types", async () => {
      const blob = service!
        .getContainerClient("invoice-templates")
        .getBlockBlobClient(`${RUN}/idem/generated/INVOICE/v1/invoice.hbs`);
      const props = await blob.getProperties();
      expect(props.contentType).toBe(
        "text/x-handlebars-template; charset=utf-8",
      );
      expect(
        (await blob.downloadToBuffer()).equals(
          readFileSync(
            path.join(
              DEFAULT_SEED_REPO_ROOT,
              "generated/INVOICE/v1/invoice.hbs",
            ),
          ),
        ),
      ).toBe(true);
    });

    it("a repo file edited after seeding → SEED_CHECKSUM_DRIFT, nothing uploaded", async () => {
      const calls: string[] = [];
      let caught: unknown;
      try {
        await seedInvoiceTemplates(db, {
          repoRoot: editedRepoCopy(),
          store: prefixedStore("drift", calls),
        });
      } catch (err) {
        caught = err;
      }
      expect(caught).toBeInstanceOf(SeedInvoiceTemplatesError);
      expect((caught as SeedInvoiceTemplatesError).code).toBe(
        "SEED_CHECKSUM_DRIFT",
      );
      expect((caught as SeedInvoiceTemplatesError).detail).toMatchObject({
        versionId: "BTV00000002",
      });
      expect(calls).toEqual([]);
    });

    it("a pre-existing different blob → SEED_BLOB_CONFLICT, never overwritten", async () => {
      const conflictPath = `${RUN}/conflict/generated/INVOICE/v1/footer.hbs`;
      created.push(conflictPath);
      const foreign = Buffer.from("<span>not the seeded footer</span>");
      await blobStore.putObject(
        "invoice-templates",
        conflictPath,
        foreign,
        "text/plain",
        { writeOnce: true, checksumAlgorithm: "sha256" },
      );

      await expect(
        seedInvoiceTemplates(db, { store: prefixedStore("conflict") }),
      ).rejects.toMatchObject({
        code: "SEED_BLOB_CONFLICT",
        detail: { blobRef: `invoice-templates/${conflictPath}` },
      });

      const stored = await blobStore.getObject(
        "invoice-templates",
        conflictPath,
      );
      expect(stored.equals(foreign)).toBe(true);
    });
  },
);
