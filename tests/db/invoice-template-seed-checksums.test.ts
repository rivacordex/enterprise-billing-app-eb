import { readFileSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import { buildIndex } from "@/scripts/invoice-templates/write-checksums";

// bm50-spec §Design D3/D4, Tests — the migration pastes literal SHA-256 digests
// of each version directory's checksums.json. This DB-free test recomputes them
// from the repo files (via the same `buildIndex` the generator script uses) and
// asserts they equal the literals in 0046, so the migration and the seeded
// files can never drift.
const MIGRATION = readFileSync(
  path.join(process.cwd(), "db/migrations/0046_invoice_template_catalog.sql"),
  "utf-8",
);

const DIRS: { label: string; dir: string }[] = [
  { label: "layout", dir: "db/seeds/invoice-templates/INVTPL-STD-A4/v1" },
  {
    label: "generated",
    dir: "db/seeds/invoice-templates/generated/INVOICE/v1",
  },
  { label: "csv", dir: "db/seeds/invoice-templates/system/csv/v1" },
];

describe("bm50 seed checksums match the repo files", () => {
  for (const { label, dir } of DIRS) {
    it(`${label}: the migration digest equals the recomputed checksums.json digest`, () => {
      const { digest } = buildIndex(path.join(process.cwd(), dir));
      expect(digest).toMatch(/^[0-9a-f]{64}$/);
      // The digest must appear in the migration IN CHECKSUM POSITION — i.e. as a
      // `'<digest>', 'sha256'` column pair in an INSERT — not merely somewhere in
      // the file (which a stray comment could satisfy).
      expect(MIGRATION).toContain(`'${digest}', 'sha256'`);
    });
  }

  it("all three digests are distinct (each directory is hashed independently)", () => {
    const digests = DIRS.map(
      ({ dir }) => buildIndex(path.join(process.cwd(), dir)).digest,
    );
    expect(new Set(digests).size).toBe(3);
  });
});
