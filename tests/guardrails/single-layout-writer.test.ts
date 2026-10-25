import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { listSourceFiles } from "@/tests/helpers/list-source-files";
import { stripComments } from "@/tests/helpers/strip-code-comments";

// bm78-spec §13 / billmgmt-code-standards.md guardrail item 68 (Inv #59) — the
// ONE writer of layout DRAFTs: `services/billing/invoice-template/
// install-layout-package.ts`. A DB-free static-source scan of every production
// file (comments stripped, so a comment that merely NAMES a call is ignored):
//   1. calls to `insertLayoutDraft(` / `repointDraftLayout(`;
//   2. any SQL inserting a `'layout'` row into `bill_template_version` (raw SQL,
//      or a Drizzle `.insert(billTemplateVersion)` with `kind: "layout"`);
//   3. any `putObject(` in a file that names a `layouts/` blob path;
// appear only in that file.
//
// Excluded:
//   - `db/repositories/**` — where the repository methods are DEFINED;
//   - `db/migrations/**` — `0046` seeds the default layout row by SQL;
//   - `db/seeds/**` — the seed uploader `db/seeds/invoice-templates.ts` writes
//     the default layout's files under `layouts/INVTPL-STD-A4/v1/`: a known,
//     pre-existing writer of the SEEDED default (never a DRAFT), not an upload path.

const ROOT = process.cwd();

const SOURCE_DIRS = [
  "app",
  "actions",
  "components",
  "services",
  "lib",
  "db",
  "scripts",
];
const EXCLUDED_PREFIXES = ["db/repositories/", "db/migrations/", "db/seeds/"];

const WRITER_FILE =
  "services/billing/invoice-template/install-layout-package.ts";

const LAYOUT_DRAFT_CALL = /\b(?:insertLayoutDraft|repointDraftLayout)\s*\(/;
const SQL_LAYOUT_INSERT =
  /INSERT\s+INTO\s+(?:"?billing"?\s*\.\s*)?"?bill_template_version"?[\s\S]{0,1000}?'layout'/i;
const DRIZZLE_LAYOUT_INSERT =
  /\.insert\(\s*billTemplateVersion\s*\)[\s\S]{0,1000}?kind\s*:\s*["'`]layout["'`]/;
const PUT_OBJECT = /\bputObject\s*\(/;
const LAYOUTS_PATH = /["'`][^"'`\n]*\blayouts\//;

const productionFiles = SOURCE_DIRS.flatMap(listSourceFiles).filter(
  (file) => !EXCLUDED_PREFIXES.some((p) => file.startsWith(p)),
);

function matching(test: (src: string) => boolean): string[] {
  return productionFiles
    .filter((file) => test(stripComments(readFileSync(file, "utf8"))))
    .sort();
}

describe("guardrail 68 — one layout DRAFT writer (Inv #59)", () => {
  it("scans the writer itself (the scan is not vacuous)", () => {
    expect(productionFiles).toContain(WRITER_FILE);
  });

  it("the insert patterns recognise the real writers they exclude (the repository's Drizzle insert, 0046's SQL seed)", () => {
    const repo = stripComments(
      readFileSync("db/repositories/billing/bill-template-version.ts", "utf8"),
    );
    expect(DRIZZLE_LAYOUT_INSERT.test(repo)).toBe(true);
    const migrations = readdirSync(resolve(ROOT, "db/migrations")).filter((f) =>
      f.startsWith("0046"),
    );
    expect(
      migrations.some((f) =>
        SQL_LAYOUT_INSERT.test(
          readFileSync(resolve(ROOT, "db/migrations", f), "utf8"),
        ),
      ),
    ).toBe(true);
  });

  it("only install-layout-package.ts calls insertLayoutDraft / repointDraftLayout", () => {
    expect(matching((src) => LAYOUT_DRAFT_CALL.test(src))).toEqual([
      WRITER_FILE,
    ]);
  });

  it("no production file inserts a 'layout' bill_template_version row by SQL or Drizzle", () => {
    // The writer goes through the repository, so it matches neither pattern.
    expect(
      matching(
        (src) => SQL_LAYOUT_INSERT.test(src) || DRIZZLE_LAYOUT_INSERT.test(src),
      ),
    ).toEqual([]);
  });

  it("only install-layout-package.ts puts a blob under a layouts/ path", () => {
    expect(
      matching((src) => PUT_OBJECT.test(src) && LAYOUTS_PATH.test(src)),
    ).toEqual([WRITER_FILE]);
  });
});
