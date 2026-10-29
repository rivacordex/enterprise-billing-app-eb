import { existsSync, readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import { TEMPLATE_KINDS } from "@/types/billing";
import { listSourceFiles } from "@/tests/helpers/list-source-files";

// bm88-spec §9 — the bm62 invoice CSV and its CSV template machinery are
// retired (migration 0055): no CSV stamp, no CSV loader and no `csv` template
// kind may come back in production code. A DB-free static-source scan. The
// migrations that created and removed them (0046, 0048, 0051, 0053, 0055) sit
// under db/migrations, outside the scanned directories. The invoice CSV the
// business wants is the reporting extract, built outside this app.

const SOURCE_DIRS = [
  "services",
  "app",
  "components",
  "db/repositories",
  "types",
];

const FORBIDDEN: { label: string; pattern: RegExp }[] = [
  { label: "refCsvTemplateVersionId", pattern: /refCsvTemplateVersionId/ },
  {
    label: "ref_csv_template_version_id",
    pattern: /ref_csv_template_version_id/,
  },
  { label: "loadCsvMap", pattern: /loadCsvMap/ },
  // "csv" as a template kind: `kind: "csv"`, `kind === 'csv'`, `kind = 'csv'`
  // (SQL) and the like. Other CSV outputs (`report_csv`, `text/csv`) are not
  // template kinds and do not match.
  {
    label: '"csv" as a template kind',
    pattern: /\bkind\b\s*(?::|={1,3}|!==?|<>)\s*["'`]csv["'`]/,
  },
];

describe("bm88 — no invoice CSV template machinery", () => {
  const files = SOURCE_DIRS.flatMap(listSourceFiles);

  it.each([
    "app/(app)/billing/bill-runs/[runId]/stored-invoice/[banId]/csv/route.ts",
    "services/billing/invoice-template/invoice-csv.ts",
  ])("the retired file %s is absent", (file) => {
    expect(existsSync(file)).toBe(false);
  });

  it("scans a non-empty source tree", () => {
    expect(files.length).toBeGreaterThan(0);
  });

  it.each(FORBIDDEN)("no production file contains $label", ({ pattern }) => {
    const matching = files
      .filter((file) => pattern.test(readFileSync(file, "utf8")))
      .sort();
    expect(matching).toEqual([]);
  });

  it("the template kinds are layout and generated only", () => {
    expect([...TEMPLATE_KINDS]).toEqual(["layout", "generated"]);
  });
});
