import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildRawUdrKey } from "@/validation/rating/udr-key";

// rm25-spec §Implementation §5 — the raw udr_key builder (Inv 27), the
// TypeScript mirror of PRP's build_udr_key. Pure-function tests, no database.

const KEY_COLUMNS = ["mno_public_id", "commercial_unit", "polygon_id"];

describe("buildRawUdrKey", () => {
  it("reproduces the spec's worked example", () => {
    expect(
      buildRawUdrKey(
        {
          mno_public_id: "MNO-001",
          commercial_unit: "CU-5G",
          polygon_id: "ABCD_25 DISTRICT2",
        },
        KEY_COLUMNS,
      ),
    ).toBe(
      "commercial_unit=CU-5G|mno_public_id=MNO-001|polygon_id=ABCD_25 DISTRICT2",
    );
  });

  it("preserves case and spaces in values", () => {
    expect(
      buildRawUdrKey(
        {
          mno_public_id: " mno-001 ",
          commercial_unit: "Cu-5g",
          polygon_id: "abcd_25  District2",
        },
        KEY_COLUMNS,
      ),
    ).toBe(
      "commercial_unit=Cu-5g|mno_public_id= mno-001 |polygon_id=abcd_25  District2",
    );
  });

  it("sorts names regardless of input order", () => {
    const columns = {
      mno_public_id: "MNO-001",
      commercial_unit: "CU-5G",
      polygon_id: "P1",
    };
    const expected =
      "commercial_unit=CU-5G|mno_public_id=MNO-001|polygon_id=P1";
    expect(
      buildRawUdrKey(columns, [
        "polygon_id",
        "mno_public_id",
        "commercial_unit",
      ]),
    ).toBe(expected);
    expect(
      buildRawUdrKey(columns, [
        "commercial_unit",
        "polygon_id",
        "mno_public_id",
      ]),
    ).toBe(expected);
  });

  it("does not mutate the keyColumns argument", () => {
    const keyColumns = ["polygon_id", "mno_public_id"];
    buildRawUdrKey({ polygon_id: "P1", mno_public_id: "M1" }, keyColumns);
    expect(keyColumns).toEqual(["polygon_id", "mno_public_id"]);
  });

  it("throws when a named column is missing", () => {
    expect(() =>
      buildRawUdrKey(
        { mno_public_id: "MNO-001", commercial_unit: "CU-5G" },
        KEY_COLUMNS,
      ),
    ).toThrow(/polygon_id/);
  });

  it("contains no normalising call in its source", () => {
    const source = readFileSync(
      path.resolve(__dirname, "../../validation/rating/udr-key.ts"),
      "utf8",
    );
    for (const call of ["trim", "toLowerCase", "toUpperCase", "normalize"]) {
      expect(source).not.toContain(call);
    }
  });
});
