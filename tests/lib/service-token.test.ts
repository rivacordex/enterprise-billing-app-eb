import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// bm04-spec §Design/§Implementation §5, architecture Inv. #9. Mirrors
// `tests/lib/csrf.test.ts`'s constant-time-compare coverage shape.

const configState: { BILLRUN_APP_TOKEN: string | undefined } = {
  BILLRUN_APP_TOKEN: undefined,
};
vi.mock("@/lib/config", () => ({
  get config() {
    return configState;
  },
}));

import { requireServiceToken, serviceTokenMatches } from "@/lib/service-token";

const VALID_TOKEN = "a".repeat(32);

function requestWithAuth(header: string | null): Request {
  const headers = new Headers();
  if (header !== null) headers.set("authorization", header);
  return new Request("http://localhost/api/billrun/BRN00000001/status", {
    method: "POST",
    headers,
  });
}

describe("serviceTokenMatches", () => {
  it("matches identical tokens", () => {
    expect(serviceTokenMatches(VALID_TOKEN, VALID_TOKEN)).toBe(true);
  });

  it("rejects a mismatched token of the same length", () => {
    expect(serviceTokenMatches("b".repeat(32), VALID_TOKEN)).toBe(false);
  });

  it("rejects a different-length token", () => {
    expect(serviceTokenMatches("a".repeat(10), VALID_TOKEN)).toBe(false);
  });

  it("rejects when either side is null/undefined", () => {
    expect(serviceTokenMatches(null, VALID_TOKEN)).toBe(false);
    expect(serviceTokenMatches(VALID_TOKEN, undefined)).toBe(false);
    expect(serviceTokenMatches(undefined, undefined)).toBe(false);
  });
});

describe("requireServiceToken (bm04-spec §Design/§5)", () => {
  beforeEach(() => {
    configState.BILLRUN_APP_TOKEN = VALID_TOKEN;
  });
  afterEach(() => {
    configState.BILLRUN_APP_TOKEN = undefined;
  });

  it("passes silently on a valid bearer token", () => {
    expect(() =>
      requireServiceToken(requestWithAuth(`Bearer ${VALID_TOKEN}`)),
    ).not.toThrow();
  });

  it("throws UNAUTHENTICATED on a missing Authorization header", () => {
    expect(() => requireServiceToken(requestWithAuth(null))).toThrow(
      expect.objectContaining({ code: "UNAUTHENTICATED" }),
    );
  });

  it("throws UNAUTHENTICATED on a non-Bearer scheme", () => {
    expect(() =>
      requireServiceToken(requestWithAuth(`Basic ${VALID_TOKEN}`)),
    ).toThrow(expect.objectContaining({ code: "UNAUTHENTICATED" }));
  });

  it("throws UNAUTHENTICATED on a mismatched token", () => {
    expect(() =>
      requireServiceToken(requestWithAuth(`Bearer ${"b".repeat(32)}`)),
    ).toThrow(expect.objectContaining({ code: "UNAUTHENTICATED" }));
  });

  it("fail-closed: throws UNAUTHENTICATED for every call when BILLRUN_APP_TOKEN is unset", () => {
    configState.BILLRUN_APP_TOKEN = undefined;
    expect(() =>
      requireServiceToken(requestWithAuth(`Bearer ${VALID_TOKEN}`)),
    ).toThrow(expect.objectContaining({ code: "UNAUTHENTICATED" }));
  });
});
