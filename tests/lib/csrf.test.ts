import { describe, expect, it } from "vitest";

import {
  csrfTokensMatch,
  generateCsrfToken,
  readCookieValue,
} from "@/lib/csrf";

describe("generateCsrfToken", () => {
  it("produces distinct, fixed-length hex tokens", () => {
    const a = generateCsrfToken();
    const b = generateCsrfToken();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("readCookieValue", () => {
  it("extracts the named cookie from a multi-cookie header", () => {
    expect(
      readCookieValue("a=1; csrf_token=abc123; other=2", "csrf_token"),
    ).toBe("abc123");
  });

  it("returns null when the cookie is absent or the header is missing", () => {
    expect(readCookieValue("a=1; other=2", "csrf_token")).toBeNull();
    expect(readCookieValue(null, "csrf_token")).toBeNull();
    expect(readCookieValue(undefined, "csrf_token")).toBeNull();
  });

  it("decodes a percent-encoded cookie value", () => {
    expect(readCookieValue("csrf_token=a%2Fb", "csrf_token")).toBe("a/b");
  });

  it("returns null instead of throwing on malformed percent-encoding", () => {
    expect(readCookieValue("csrf_token=%", "csrf_token")).toBeNull();
    expect(readCookieValue("csrf_token=%E0%A4%A", "csrf_token")).toBeNull();
  });
});

describe("csrfTokensMatch", () => {
  it("matches identical tokens", () => {
    const token = generateCsrfToken();
    expect(csrfTokensMatch(token, token)).toBe(true);
  });

  it("rejects a mismatched, missing, or differently-sized token", () => {
    expect(csrfTokensMatch(generateCsrfToken(), generateCsrfToken())).toBe(
      false,
    );
    expect(csrfTokensMatch(null, generateCsrfToken())).toBe(false);
    expect(csrfTokensMatch(generateCsrfToken(), null)).toBe(false);
    expect(csrfTokensMatch("abc", "abcd")).toBe(false);
  });
});
