import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { blobStore } from "@/services/billing/blob-store";
import { BLOB_CONTAINERS } from "@/types/billing";

// bm51-spec §Tests — the real Azurite round-trip. The whole suite is skipped
// only when BILLRUN_BLOB_CONNECTION_STRING is unset (describe.skipIf). When it
// IS set, a container-init failure FAILS the suite — a configured-but-
// unreachable Azurite is a real error, not a reason to pass silently. The
// `.integration.test.ts` suffix keeps it out of the DB-free unit run (it drives
// the REAL blobStore, no SDK mock). It touches no Postgres, but — like every
// file in this project — still runs behind the destructive-DB preflight
// (DESTRUCTIVE_DB_OK=1 + the disposable sentinel).
const CONNECTION_STRING = process.env.BILLRUN_BLOB_CONNECTION_STRING;

// Unique run suffix so write-once paths never collide across runs on a
// persisted Azurite volume (`createIfNotExists` + write-once are idempotent on
// the SAME path; a second run needs a fresh one). Test files may use Date.now().
const RUN = `it-${Date.now().toString(36)}`;

describe.skipIf(!CONNECTION_STRING)(
  "blobStore — real Azurite round-trip",
  () => {
    // One SDK client for both setup and teardown (describe.skipIf guarantees the
    // connection string is set when this body runs).
    const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING!);
    // Every blobRef the suite creates, torn down in afterAll via `parseBlobRef`.
    // The invoice blob lands at `invoices/<YYYY-MM>/<INV>.pdf` — which a single
    // `RUN`-prefix scan would never match — so track the returned refs rather
    // than guess paths.
    const createdRefs: string[] = [];

    beforeAll(async () => {
      for (const name of BLOB_CONTAINERS) {
        await service.getContainerClient(name).createIfNotExists();
      }
    });

    afterAll(async () => {
      if (createdRefs.length === 0) return;
      for (const ref of createdRefs) {
        const { container, path } = blobStore.parseBlobRef(ref);
        await service
          .getContainerClient(container)
          .deleteBlob(path)
          .catch(() => undefined);
      }
    });

    it("round-trips bytes in all three containers", async () => {
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
        createdRefs.push(put.blobRef);
        expect(put.blobRef).toBe(`${container}/${path}`);
        expect(put.checksum).toBe(
          blobStore.digest(bytes, put.checksumAlgorithm),
        );

        const got = await blobStore.getObject(container, path);
        expect(got).toStrictEqual(bytes);
      }
    });

    it("refuses a second write-once put to the same template path", async () => {
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
      createdRefs.push(first.blobRef);
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

    it("putInvoice returns the first-stored md5 on a second put to the same invoice path", async () => {
      const period = "2026-07-01";
      const invoiceNo = `${RUN.toUpperCase().replace(/[^A-Z0-9]/g, "")}INV1`;

      const first = await blobStore.putInvoice(
        period,
        invoiceNo,
        Buffer.from("FIRST-PDF"),
      );
      createdRefs.push(first.blobRef);
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
