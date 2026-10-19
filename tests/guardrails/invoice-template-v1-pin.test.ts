import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm72-spec §Design "The v1 pin" — guardrail item 65, first half (Inv #57,
// D41, D49). Layout `INVTPL-STD-A4` v1 and the Standard generated v1 were
// rewritten for the last time in bm70–bm72; from here on they never change.
// This DB-free test pins them: the two constants below are the SHA-256 of each
// directory's `checksums.json`, and that index must still list the right
// digest for every file in its directory. Changing any byte of a v1 file (or
// re-running `write-checksums.ts` over it), or either checksum literal in
// `0046`, fails CI. A later change is a new version: layout v2+ in a new
// directory, or a new generated version made through the editor.
//
// Do NOT update these constants to make a change pass. v1 is immutable.
const LAYOUT_V1_CHECKSUMS_SHA256 =
  "17ec1bd75b543456b91c10b06ed7a2bafed18ba9ced89a22d93aa6eb9e59aa22";
const GENERATED_V1_CHECKSUMS_SHA256 =
  "0c875a77fae348b1d5cb7d4a028b0aa2a5ccc87bfb37b1cd0decf8ac571d1c41";

const REPO_ROOT = path.resolve(__dirname, "../..");
const SEEDS = path.join(REPO_ROOT, "db/seeds/invoice-templates");
const MIGRATION = readFileSync(
  path.join(REPO_ROOT, "db/migrations/0046_invoice_template_catalog.sql"),
  "utf-8",
);

const PINNED = [
  {
    label: "layout INVTPL-STD-A4/v1",
    dir: path.join(SEEDS, "INVTPL-STD-A4/v1"),
    digest: LAYOUT_V1_CHECKSUMS_SHA256,
    versionId: "BTV00000001",
  },
  {
    label: "generated INVOICE/v1",
    dir: path.join(SEEDS, "generated/INVOICE/v1"),
    digest: GENERATED_V1_CHECKSUMS_SHA256,
    versionId: "BTV00000002",
  },
] as const;

function sha256(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

// Every file under `dir` except the index itself, as POSIX relative paths.
function filesUnder(dir: string, base = dir): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...filesUnder(abs, base));
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out.filter((f) => f !== "checksums.json").sort();
}

// The seed INSERT row for a version id: from its `('BTV…'` tuple start to the
// statement's closing `);`.
function seedRow(versionId: string): string {
  const start = MIGRATION.indexOf(`('${versionId}', 'INVOICE'`);
  expect(start).toBeGreaterThan(-1);
  return MIGRATION.slice(start, MIGRATION.indexOf(");", start));
}

describe("invoice template v1 pin (bm72, guardrail 65, Inv #57)", () => {
  it.each(PINNED)(
    "$label: checksums.json hashes to the pinned constant",
    ({ dir, digest }) => {
      expect(sha256(readFileSync(path.join(dir, "checksums.json")))).toBe(
        digest,
      );
    },
  );

  it.each(PINNED)(
    "$label: checksums.json lists exactly the directory's files, each with its digest",
    ({ dir }) => {
      const index = JSON.parse(
        readFileSync(path.join(dir, "checksums.json"), "utf-8"),
      ) as { algorithm: string; files: Record<string, string> };
      expect(index.algorithm).toBe("sha256");
      expect(Object.keys(index.files).sort()).toEqual(filesUnder(dir));
      for (const [file, listed] of Object.entries(index.files)) {
        expect(
          sha256(readFileSync(path.join(dir, file))),
          `${file} changed since v1 was pinned`,
        ).toBe(listed);
      }
    },
  );

  it.each(PINNED)(
    "$label: the pinned constant is 0046's checksum literal for $versionId",
    ({ digest, versionId }) => {
      expect(seedRow(versionId)).toContain(`'${digest}', 'sha256'`);
    },
  );
});
