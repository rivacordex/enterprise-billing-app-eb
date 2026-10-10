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
      assertTestBlobConnection(
        "DefaultEndpointsProtocol=http;AccountName=devstoreaccount1;AccountKey=x",
      ),
    ).toThrow(/unrecognised blob endpoint/);
  });

  // The SDK swaps a `UseDevelopmentStorage=true…` string for the default
  // devstore one (port 10000) and ignores the BlobEndpoint beside it.
  it.each([
    "UseDevelopmentStorage=true",
    "UseDevelopmentStorage=true;BlobEndpoint=http://127.0.0.1:10001/devstoreaccount1",
    `${conn("http://127.0.0.1:10001/devstoreaccount1")}UseDevelopmentStorage=true`,
  ])("refuses the UseDevelopmentStorage shorthand (%s)", (connectionString) => {
    expect(() => assertTestBlobConnection(connectionString)).toThrow(
      /UseDevelopmentStorage/,
    );
  });

  // The SDK matches `BlobEndpoint` case-sensitively and takes the first one; a
  // lower-cased decoy pointing local must not get a real endpoint approved.
  it.each([
    "AccountName=devstoreaccount1;AccountKey=x;blobendpoint=http://127.0.0.1:10001/devstoreaccount1;BlobEndpoint=https://prod.blob.core.windows.net",
    "AccountName=devstoreaccount1;AccountKey=x;BLOBENDPOINT=http://127.0.0.1:10001/devstoreaccount1",
    "AccountName=devstoreaccount1;AccountKey=x;BlobEndpointX=http://127.0.0.1:10001/devstoreaccount1",
  ])("refuses an other-cased or look-alike BlobEndpoint key (%s)", (cs) => {
    expect(() => assertTestBlobConnection(cs)).toThrow(
      /ambiguous blob endpoint field/,
    );
  });

  it("reads BlobEndpoint as a field key, not a substring of another field", () => {
    expect(() =>
      assertTestBlobConnection(
        "AccountName=devstoreaccount1;AccountKey=BlobEndpoint=http://127.0.0.1:10001/x;BlobEndpoint=https://acct.blob.core.windows.net",
      ),
    ).toThrow(/acct\.blob\.core\.windows\.net/);
  });
});
