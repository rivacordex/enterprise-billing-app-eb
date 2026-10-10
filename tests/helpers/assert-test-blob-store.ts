// Integration suites that DELETE blobs in cleanup (the bm58 activation suite and
// guardrail 46) point a real blob client at BILLRUN_BLOB_CONNECTION_STRING. Like
// `assertTestDatabaseUrl` guards the schema drops, this guards the blob deletes:
// they must only ever reach the throwaway Azurite from docker-compose.test.yml
// (published on host port 10001), never the dev stack's Azurite (port 10000) or
// a real storage account, whose activated-template directories they would wipe.
//
// The endpoint is read the way @azure/storage-blob reads it
// (`getValueInConnString`): split on `;`, trim, and take the FIRST element that
// starts with `BlobEndpoint`, case-sensitively. A regex search or a
// case-insensitive key match could approve a different endpoint from the one
// the SDK then uses. Refused outright, as ambiguous:
//   * the `UseDevelopmentStorage` shorthand, in any casing — the SDK replaces a
//     string starting `UseDevelopmentStorage=true` with the default devstore
//     one (port 10000) and ignores any BlobEndpoint beside it;
//   * any other-cased `blobendpoint` key, or a key that merely starts with
//     `BlobEndpoint` (e.g. `BlobEndpointX=`), which the SDK would pick up or
//     crash on.
const APPROVED_ENDPOINT =
  /^https?:\/\/(?:127\.0\.0\.1|localhost):10001(?:\/|$)/;

function refuse(target: string): never {
  throw new Error(
    "Refusing to run blob-deleting integration tests against " +
      `"${target}". ` +
      "BILLRUN_BLOB_CONNECTION_STRING must point at the throwaway Azurite " +
      "(127.0.0.1:10001, docker-compose.test.yml), not the dev stack's (10000) " +
      "or a real storage account. Load .env.test.",
  );
}

export function assertTestBlobConnection(connectionString: string): void {
  const elements = connectionString
    .split(";")
    .map((part) => part.trim())
    .filter((element) => element !== "");
  const keyOf = (element: string) =>
    (element.includes("=") ? element.slice(0, element.indexOf("=")) : element)
      .trim()
      .toLowerCase();

  if (elements.some((e) => keyOf(e) === "usedevelopmentstorage")) {
    refuse(
      "UseDevelopmentStorage (the SDK ignores BlobEndpoint and uses port 10000)",
    );
  }
  const ambiguous = elements.find(
    (e) =>
      (keyOf(e) === "blobendpoint" || e.startsWith("BlobEndpoint")) &&
      !e.startsWith("BlobEndpoint="),
  );
  if (ambiguous !== undefined) {
    refuse(`an ambiguous blob endpoint field (${ambiguous})`);
  }

  const picked = elements.find((e) => e.startsWith("BlobEndpoint"));
  const endpoint = picked ? picked.slice("BlobEndpoint=".length) : "";
  if (!APPROVED_ENDPOINT.test(endpoint)) {
    refuse(endpoint || "an unrecognised blob endpoint");
  }
}
