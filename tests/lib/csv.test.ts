import { describe, expect, it } from "vitest";

import { csvField } from "@/lib/csv";

// Shared CSV field escaping (RFC-4180 quoting + formula-injection prefix).
describe("csvField", () => {
  it("passes a plain value through unchanged", () => {
    expect(csvField("Enterprise Monthly")).toBe("Enterprise Monthly");
  });

  it("quotes and doubles embedded quotes for commas/quotes/newlines", () => {
    expect(csvField("a,b")).toBe('"a,b"');
    expect(csvField('a"b')).toBe('"a""b"');
    expect(csvField("a\nb")).toBe('"a\nb"');
  });

  it.each(["=1+1", "+1", "-1", "@x", "\tx"])(
    "prefixes formula-trigger %j with a single quote",
    (value) => {
      expect(csvField(value).startsWith("'")).toBe(true);
    },
  );

  it("prefixes AND quotes a formula value that also contains a comma", () => {
    expect(csvField("=A1,B1")).toBe(`"'=A1,B1"`);
  });

  it("prefixes AND quotes a value starting with CR (a quote-trigger)", () => {
    // Formula-neutralized ('-prefixed) then RFC-4180 quoted for the \r.
    expect(csvField("\rx")).toBe(`"'\rx"`);
  });
});
