import { describe, expect, it } from "vitest";

import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";

const conn = (endpoint: string) =>
  `DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=x;BlobEndpoint=${endpoint};QueueEndpoint=http://127.0.0.1:10002/devstoreaccount1;`;

describe("assertTestBlobConnection", () => {
  it.each([
    "http://127.0.0.1:10001/devstoreaccount1",
    "http://localhost:10001/devstoreaccount1",
  ])("accepts the throwaway Azurite (%s)", (endpoint) => {
    expect(() => assertTestBlobConnection(conn(endpoint))).not.toThrow();
  });

  it.each([
    ["the dev stack's Azurite", "http://127.0.0.1:10000/devstoreaccount1"],
    ["a real storage account", "https://acct.blob.core.windows.net"],
    ["a look-alike port", "http://127.0.0.1:100011/devstoreaccount1"],
    ["a look-alike host", "http://evil-127.0.0.1:10001/devstoreaccount1"],
  ])("refuses %s", (_label, endpoint) => {
    expect(() => assertTestBlobConnection(conn(endpoint))).toThrow(
      /Refusing to run blob-deleting integration tests/,
    );
  });

  it("refuses a connection string with no blob endpoint", () => {
    expect(() =>
      assertTestBlobConnection("UseDevelopmentStorage=true"),
    ).toThrow(/unrecognised blob endpoint/);
  });
});
