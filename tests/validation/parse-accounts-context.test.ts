import { describe, expect, it } from "vitest";

import { parseAccountsContext } from "@/validation/accounts/parse-accounts-context";

describe("parseAccountsContext", () => {
  it("returns all three ids when all are valid", () => {
    expect(
      parseAccountsContext({
        party: "PTRL00000001",
        fa: "FIN000001",
        ban: "BAN000001",
      }),
    ).toEqual({
      party: "PTRL00000001",
      fa: "FIN000001",
      ban: "BAN000001",
    });
  });

  it("returns only the present ids when others are absent", () => {
    expect(parseAccountsContext({ fa: "FIN000042" })).toEqual({
      party: undefined,
      fa: "FIN000042",
      ban: undefined,
    });
  });

  it("returns empty context when no params", () => {
    expect(parseAccountsContext({})).toEqual({
      party: undefined,
      fa: undefined,
      ban: undefined,
    });
  });

  it("rejects a party id with wrong prefix", () => {
    expect(parseAccountsContext({ party: "ORGX0000001" })).toEqual({
      party: undefined,
      fa: undefined,
      ban: undefined,
    });
  });

  it("rejects a FA id with wrong digit count", () => {
    // FIN needs exactly 6 digits
    expect(parseAccountsContext({ fa: "FIN0000001" })).toEqual({
      party: undefined,
      fa: undefined,
      ban: undefined,
    });
  });

  it("rejects a BAN id with wrong prefix", () => {
    expect(parseAccountsContext({ ban: "BNC000001" })).toEqual({
      party: undefined,
      fa: undefined,
      ban: undefined,
    });
  });

  it("accepts the first element when the param is an array", () => {
    expect(
      parseAccountsContext({ party: ["PTRL00000001", "PTRL00000002"] }),
    ).toEqual({
      party: "PTRL00000001",
      fa: undefined,
      ban: undefined,
    });
  });

  it("rejects empty string values", () => {
    expect(parseAccountsContext({ party: "", fa: "", ban: "" })).toEqual({
      party: undefined,
      fa: undefined,
      ban: undefined,
    });
  });

  it("rejects non-numeric characters in the id", () => {
    expect(parseAccountsContext({ fa: "FINABC001" })).toEqual({
      party: undefined,
      fa: undefined,
      ban: undefined,
    });
  });

  it("accepts max-size valid PTRL id (PTRL + 8 digits)", () => {
    expect(parseAccountsContext({ party: "PTRL99999999" })).toEqual({
      party: "PTRL99999999",
      fa: undefined,
      ban: undefined,
    });
  });
});
