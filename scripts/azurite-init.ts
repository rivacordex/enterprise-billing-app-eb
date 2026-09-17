import { BlobServiceClient } from "@azure/storage-blob";

import { logger } from "@/lib/logger";

// Local-dev only — creates the blob containers the stack needs but nothing
// creates on its own. Idempotent: `createIfNotExists` on each.
//
// Why this exists. Azurite does NOT auto-create containers, and neither does
// Kestra: when its Azure storage backend needs `kestra-internal` it simply PUTs
// into it and takes the 404. That surfaces far from the cause — a task like
// `azure.storage.blob.Download` fetches the blob successfully (Azurite logs a
// `206`), then fails with a bare `BlobStorageException: Status code 404` while
// writing the result to Kestra's OWN internal storage. Symptom: the bill-run
// distribution flow fails on every artifact even though every invoice PDF is
// present. See README "Part 2 step 9".
//
// `invoices` is listed too, for completeness on a fresh volume: the app creates
// it on first write (services/billing/blob-store.ts), so it normally exists
// already — but a developer who runs distribution before ever posting would
// otherwise hit the same 404 from the other side.
const CONTAINERS = ["kestra-internal", "invoices"] as const;

// The HOST-facing Azurite connection string (127.0.0.1). The engine reaches the
// same Azurite in-network as `azurite:10000`; this script runs on the host, so
// it uses the host mapping. Microsoft's published well-known emulator
// account/key — not a secret (README credentials table).
const CONNECTION_STRING =
  process.env.BILLRUN_BLOB_CONNECTION_STRING ??
  "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;BlobEndpoint=http://127.0.0.1:10000/devstoreaccount1;";

async function main(): Promise<void> {
  const service = BlobServiceClient.fromConnectionString(CONNECTION_STRING);
  for (const name of CONTAINERS) {
    const { succeeded } = await service
      .getContainerClient(name)
      .createIfNotExists();
    logger.info(
      succeeded
        ? `azurite-init: created container ${name}`
        : `azurite-init: container ${name} already present`,
    );
  }
}

main().catch((err: unknown) => {
  logger.error(
    "azurite-init failed — is the azurite container running on :10000?",
    { error: err instanceof Error ? err.message : String(err) },
  );
  process.exitCode = 1;
});
