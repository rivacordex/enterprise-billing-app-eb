import { describe, expect, it, vi } from "vitest";

// bm77-spec §11 — the pure parts of invoice template types: name
// normalization, the derived code (DB-shaped, btf_code_format), and the one
// derived status. The DB path (create type) is template-types-create.integration.test.ts.
// bm82: countBoundBansByType's row mapping (its SQL is covered there too).
vi.mock("@/db/client", () => ({ db: {} }));

import type { Database } from "@/db/client";
import {
  countBoundBansByType,
  deriveTemplateTypeCode,
  deriveTemplateTypeStatus,
  normalizeTemplateTypeName,
} from "@/services/billing/invoice-template/template-types";

const CODE_FORMAT = /^[A-Z][A-Z0-9_]{0,59}$/; // btf_code_format (0053)

describe("normalizeTemplateTypeName", () => {
  it("trims and collapses internal whitespace runs", () => {
    expect(normalizeTemplateTypeName("  Whole   sale ")).toBe("Whole sale");
  });
});

describe("deriveTemplateTypeCode", () => {
  it.each([
    ["Wholesale", "WHOLESALE"],
    ["Wholesale & Retail (East)", "WHOLESALE_RETAIL_EAST"],
    ["5G Enterprise", "T_5G_ENTERPRISE"],
  ])("%s → %s", (name, code) => {
    expect(deriveTemplateTypeCode(name)).toBe(code);
  });

  it("cuts a 60-character name's code to at most 60 characters, matching btf_code_format", () => {
    const name = "A".repeat(30) + " " + "B".repeat(29);
    expect(name).toHaveLength(60);
    const code = deriveTemplateTypeCode(name);
    expect(code.length).toBeLessThanOrEqual(60);
    expect(code).toMatch(CODE_FORMAT);
  });

  it("a digit-led 60-character name keeps within 60 after the T_ prefix", () => {
    const code = deriveTemplateTypeCode("9".repeat(60));
    expect(code.length).toBeLessThanOrEqual(60);
    expect(code).toMatch(CODE_FORMAT);
  });
});

describe("deriveTemplateTypeStatus", () => {
  it("RETIRED when retired, whatever its settings", () => {
    expect(
      deriveTemplateTypeStatus({ retiredDatetime: new Date() }, true),
    ).toBe("RETIRED");
  });

  it("USABLE with an ACTIVE (or default) settings version", () => {
    expect(deriveTemplateTypeStatus({ retiredDatetime: null }, true)).toBe(
      "USABLE",
    );
  });

  it("NOT_YET_USABLE without one", () => {
    expect(deriveTemplateTypeStatus({ retiredDatetime: null }, false)).toBe(
      "NOT_YET_USABLE",
    );
  });
});

describe("countBoundBansByType (bm82)", () => {
  function dbReturning(rows: { type_id: string | null; n: number }[]): {
    db: Database;
    execute: ReturnType<typeof vi.fn>;
  } {
    const execute = vi.fn().mockResolvedValue(rows);
    return { db: { execute } as unknown as Database, execute };
  }

  it("maps each type to its count; NULL BANs arrive under Standard's id (the SQL coalesces)", async () => {
    const { db, execute } = dbReturning([
      { type_id: "BTF00000001", n: 5 },
      { type_id: "BTF00000002", n: 2 },
    ]);
    const counts = await countBoundBansByType(db);
    expect(counts).toEqual(
      new Map([
        ["BTF00000001", 5],
        ["BTF00000002", 2],
      ]),
    );
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("drops a NULL type row (no default family — impossible after 0046)", async () => {
    const { db } = dbReturning([
      { type_id: null, n: 3 },
      { type_id: "BTF00000002", n: 1 },
    ]);
    expect(await countBoundBansByType(db)).toEqual(
      new Map([["BTF00000002", 1]]),
    );
  });

  it("is empty when there are no BANs", async () => {
    const { db } = dbReturning([]);
    expect((await countBoundBansByType(db)).size).toBe(0);
  });
});
