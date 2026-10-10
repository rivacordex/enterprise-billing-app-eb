// Integration suites that DELETE blobs in cleanup (the bm58 activation suite and
// guardrail 46) point a real blob client at BILLRUN_BLOB_CONNECTION_STRING. Like
// `assertTestDatabaseUrl` guards the schema drops, this guards the blob deletes:
// they must only ever reach the throwaway Azurite from docker-compose.test.yml
// (published on host port 10001), never the dev stack's Azurite (port 10000) or
// a real storage account, whose activated-template directories they would wipe.
export function assertTestBlobConnection(connectionString: string): void {
  const endpoint = /BlobEndpoint=([^;]+)/.exec(connectionString)?.[1] ?? "";
  if (!/^https?:\/\/(?:127\.0\.0\.1|localhost):10001(?:\/|$)/.test(endpoint)) {
    throw new Error(
      "Refusing to run blob-deleting integration tests against " +
        `"${endpoint || "an unrecognised blob endpoint"}". ` +
        "BILLRUN_BLOB_CONNECTION_STRING must point at the throwaway Azurite " +
        "(127.0.0.1:10001, docker-compose.test.yml), not the dev stack's (10000) " +
        "or a real storage account. Load .env.test.",
    );
  }
}
