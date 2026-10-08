import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { blobStore } from "@/services/billing/blob-store";
import { BLOB_CONTAINERS } from "@/types/billing";

// bm51-spec §Tests — the real Azurite round-trip. Runs only where a real
// Azurite is reachable via BILLRUN_BLOB_CONNECTION_STRING; skips loudly with an
// explicit reason otherwise. The `.integration.test.ts` suffix keeps it out of
// the DB-free unit run (it drives the REAL blobStore, no SDK mock). It touches
// no Postgres, but — like every file in this project — still runs behind the
// destructive-DB preflight (DESTRUCTIVE_DB_OK=1 + the disposable sentinel).
const CONNECTION_STRING = process.env.BILLRUN_BLOB_CONNECTION_STRING;
const SKIP_REASON =
  "BILLRUN_BLOB_CONNECTION_STRING is not set — real Azurite round-trip skipped.";

// Unique run suffix so write-once paths never collide across runs on a
// persisted Azurite volume (`createIfNotExists` + write-once are idempotent on
// the SAME path; a second run needs a fresh one). Test files may use Date.now().
const RUN = `it-${Date.now().toString(36)}`;

describe.skipIf(!CONNECTION_STRING)(
  "blobStore — real Azurite round-trip",
  () => {
    let reachable = false;

    beforeAll(async () => {
      try {
        const service = BlobServiceClient.fromConnectionString(
          CONNECTION_STRING!,
        );
        for (const name of BLOB_CONTAINERS) {
          await service.getContainerClient(name).createIfNotExists();
        }
        reachable = true;
      } catch {
        reachable = false;
      }
    });

    afterAll(async () => {
      if (!reachable) return;
      const service = BlobServiceClient.fromConnectionString(
        CONNECTION_STRING!,
      );
      for (const name of BLOB_CONTAINERS) {
        const container = service.getContainerClient(name);
        for await (const blob of container.listBlobsFlat({ prefix: RUN })) {
          await container.deleteBlob(blob.name).catch(() => undefined);
        }
      }
    });

    it("round-trips bytes in all three containers", async (ctx) => {
      if (!reachable) ctx.skip(SKIP_REASON);
      for (const container of BLOB_CONTAINERS) {
        const path = `${RUN}/roundtrip.bin`;
        const bytes = Buffer.from(`hello-${container}`);
        const put = await blobStore.putObject(
          container,
          path,
          bytes,
          "application/octet-stream",
          {
            writeOnce: true,
            onExists: "returnExisting",
            checksumAlgorithm: container === "invoices" ? "md5" : "sha256",
          },
        );
        expect(put.blobRef).toBe(`${container}/${path}`);
        expect(put.checksum).toBe(
          blobStore.digest(bytes, put.checksumAlgorithm),
        );

        const got = await blobStore.getObject(container, path);
        expect(got).toStrictEqual(bytes);
      }
    });

    it("refuses a second write-once put to the same template path", async (ctx) => {
      if (!reachable) ctx.skip(SKIP_REASON);
      const path = `${RUN}/generated/INVOICE/v1/invoice.hbs`;
      const opts = {
        writeOnce: true as const,
        checksumAlgorithm: "sha256" as const,
      };

      const first = await blobStore.putObject(
        "invoice-templates",
        path,
        Buffer.from("v1"),
        "text/plain",
        opts,
      );
      expect(first.created).toBe(true);

      await expect(
        blobStore.putObject(
          "invoice-templates",
          path,
          Buffer.from("v2"),
          "text/plain",
          opts,
        ),
      ).rejects.toMatchObject({ code: "BLOB_ALREADY_EXISTS" });
    });

    it("putInvoice returns the first-stored md5 on a second put to the same invoice path", async (ctx) => {
      if (!reachable) ctx.skip(SKIP_REASON);
      const period = "2026-07-01";
      const invoiceNo = `${RUN.toUpperCase().replace(/[^A-Z0-9]/g, "")}INV1`;

      const first = await blobStore.putInvoice(
        period,
        invoiceNo,
        Buffer.from("FIRST-PDF"),
      );
      const second = await blobStore.putInvoice(
        period,
        invoiceNo,
        Buffer.from("SECOND-PDF"),
      );

      expect(second.blobRef).toBe(first.blobRef);
      expect(second.checksum).toBe(first.checksum);
    });
  },
);
