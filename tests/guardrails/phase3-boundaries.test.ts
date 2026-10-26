import { readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, relative, resolve, sep } from "node:path";

import { describe, expect, it } from "vitest";

// bm68-spec §5 / billmgmt-code-standards.md guardrail item 66 — the Invoice
// Template Phase 3 boundaries (D46, D31), as a DB-free static-source test:
//
//   1. Neither copy of the processing flow builds `appendix` into
//      `additional_info` or carries the `CAPACITY_APPENDIX_OVER_LIMIT` guard
//      (bm68 removed both, D31).
//   2. `invoice-render-input.ts` has no `rating.` reference (the detail read is
//      `rated-lines.repository.ts`'s job).
//   3. No file under `services/billing/**` or `actions/billing/**` imports
//      `services/accounts/**` or `actions/accounts/**` (D46), except the
//      ledger posting path below.
//   4. No billing file writes `billing_account` (D46: read at run start only),
//      except one pinned site: the bm83 retire switch in `template-types.ts`
//      (Invoice Template Types guardrail 79; superseded-rules table).

const ROOT = process.cwd();

const FLOW_FILES = [
  "workflow-management/flows/bill-run-processor/bill_run_processing.template.yml",
  "workflow-management/flows/bill-run-processor/local-dev/bill_run_processing.yml",
];

const BILLING_SOURCE_DIRS = [
  "services/billing",
  "actions/billing",
  "db/repositories/billing",
];

// The one sanctioned billing → Accounts dependency: posting reuses the Accounts
// document engine (`postDocument`, INV) and its money helpers inside the
// posting transaction (billmgmt-architecture.md §Stack "Ledger posting —
// reused, not owned", Inv #6; bm09/bm11). It predates Phase 3 and is not
// Customer Management. Pinned exactly so the exemption cannot grow silently,
// and checked to still exist so it cannot go stale.
const ALLOWED_ACCOUNTS_IMPORTS: Readonly<Record<string, readonly string[]>> = {
  "services/billing/post-run.ts": [
    "services/accounts/money",
    "services/accounts/post-document",
  ],
};

function read(path: string): string {
  return readFileSync(resolve(ROOT, path), "utf8");
}

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      const child = resolve(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (/\.tsx?$/.test(entry) && !/\.test\.tsx?$/.test(entry)) {
        out.push(relative(ROOT, child).split(sep).join("/"));
      }
    }
  };
  walk(resolve(ROOT, dir));
  return out;
}

// Drop SQL `--` comments and whole-line YAML `#` comments, leaving the
// executable SQL and YAML keys. A comment may still explain the removal.
function stripFlowComments(source: string): string {
  return source
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .map((line) => line.replace(/(^|\s)--(\s.*)?$/, "$1"))
    .join("\n");
}

// Every module specifier a file imports (static, re-export, dynamic), resolved
// to a repo-relative path without extension. Bare package specifiers are kept
// as written (they never start with `services/` or `actions/`).
function importedPaths(file: string, source: string): string[] {
  const specifiers = [
    ...source.matchAll(/\bfrom\s*["']([^"']+)["']/g),
    ...source.matchAll(/\bimport\s*\(?\s*["']([^"']+)["']/g),
    ...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']/g),
  ].map((m) => m[1]!);
  return specifiers.map((spec) => {
    if (spec.startsWith("@/")) return spec.slice(2);
    if (spec.startsWith(".")) {
      return relative(ROOT, resolve(ROOT, dirname(file), spec))
        .split(sep)
        .join("/");
    }
    return spec;
  });
}

function accountsImports(file: string): string[] {
  return importedPaths(file, read(file))
    .filter((p) => /^(services|actions)\/accounts(\/|$)/.test(p))
    .map((p) => p.replace(/\.tsx?$/, ""));
}

describe("Invoice Template Phase 3 boundaries (guardrail item 66, D46, D31)", () => {
  describe("1. the processing flow builds no appendix (bm68, D31)", () => {
    it.each(FLOW_FILES)("%s", (path) => {
      const source = read(path);
      expect(source).not.toContain("CAPACITY_APPENDIX_OVER_LIMIT");
      const code = stripFlowComments(source);
      // No `appendix` key, CTE, column or bm45 temp table left in the SQL.
      expect(code).not.toMatch(/appendix/i);
      expect(code).not.toMatch(/_bm45_/);
    });

    it("the comment stripper keeps executable SQL (non-vacuous)", () => {
      const sample = [
        "          # design note: appendix removed",
        "                -- appendix removed by bm68",
        "                jsonb_build_object('appendix', ct.appendix)",
      ].join("\n");
      expect(stripFlowComments(sample)).toMatch(/'appendix', ct\.appendix/);
      expect(stripFlowComments(sample)).not.toMatch(/removed/);
      // The deployed flow's additional_info build itself survives stripping.
      expect(stripFlowComments(read(FLOW_FILES[1]!))).toMatch(/'summary', \(/);
    });
  });

  it("2. invoice-render-input.ts has no `rating.` reference", () => {
    const source = read("db/repositories/billing/invoice-render-input.ts");
    expect(source).not.toMatch(/\brating\./);
    expect(source).not.toMatch(/@\/db\/schema\/rating/);
  });

  describe("3. billing never imports Customer Management code (D46)", () => {
    const files = ["services/billing", "actions/billing"].flatMap(
      listSourceFiles,
    );

    it("scans a non-empty file set", () => {
      expect(files.length).toBeGreaterThan(20);
      expect(files).toContain("services/billing/post-run.ts");
    });

    it("no services/billing or actions/billing file imports services/accounts or actions/accounts beyond the pinned posting path", () => {
      const offenders: string[] = [];
      for (const file of files) {
        const allowed = ALLOWED_ACCOUNTS_IMPORTS[file] ?? [];
        for (const imported of accountsImports(file)) {
          if (!allowed.includes(imported)) {
            offenders.push(`${file} → ${imported}`);
          }
        }
      }
      expect(offenders).toEqual([]);
    });

    it("the pinned posting exemption is still exactly what post-run.ts imports", () => {
      for (const [file, allowed] of Object.entries(ALLOWED_ACCOUNTS_IMPORTS)) {
        expect([...new Set(accountsImports(file))].sort()).toEqual(
          [...allowed].sort(),
        );
      }
    });

    it("resolves relative and alias specifiers alike (non-vacuous)", () => {
      expect(
        importedPaths(
          "services/billing/x.ts",
          [
            'import { a } from "../accounts/post-document";',
            'import b from "@/actions/accounts/close";',
            'const c = await import("../../actions/accounts/open");',
          ].join("\n"),
        ),
      ).toEqual([
        "services/accounts/post-document",
        "actions/accounts/close",
        "actions/accounts/open",
      ]);
    });
  });

  describe("4. no billing file writes billing_account (D46)", () => {
    const DRIZZLE_WRITE = /\.(insert|update|delete)\(\s*billingAccount\b/;
    const RAW_WRITE =
      /\b(UPDATE|INSERT\s+INTO|DELETE\s+FROM)\s+"?billing"?\s*\.\s*"?billing_account"?(?![\w])/i;

    // bm83 — the one pinned writer: a single Drizzle update inside
    // `retireTemplateType`, and no raw write anywhere in the file.
    const RETIRE_SWITCH = {
      file: "services/billing/invoice-template/template-types.ts",
      fn: "export async function retireTemplateType(",
    };

    function isPinnedRetireSwitch(file: string, source: string): boolean {
      if (file !== RETIRE_SWITCH.file || RAW_WRITE.test(source)) return false;
      const writes = [
        ...source.matchAll(new RegExp(DRIZZLE_WRITE.source, "g")),
      ];
      const start = source.indexOf(RETIRE_SWITCH.fn);
      const end = source.indexOf("\nasync function ", start);
      return (
        writes.length === 1 &&
        writes[0]![1] === "update" &&
        start !== -1 &&
        writes[0]!.index! > start &&
        (end === -1 || writes[0]!.index! < end)
      );
    }

    it("no services/billing, actions/billing or db/repositories/billing file writes billing_account (bar the pinned retire switch)", () => {
      const offenders = BILLING_SOURCE_DIRS.flatMap(listSourceFiles).filter(
        (file) => {
          const source = read(file);
          if (isPinnedRetireSwitch(file, source)) return false;
          return DRIZZLE_WRITE.test(source) || RAW_WRITE.test(source);
        },
      );
      expect(offenders).toEqual([]);
    });

    it("the pinned retire switch still exists and writes billing_account (non-vacuous)", () => {
      const source = read(RETIRE_SWITCH.file);
      expect(DRIZZLE_WRITE.test(source)).toBe(true);
      expect(isPinnedRetireSwitch(RETIRE_SWITCH.file, source)).toBe(true);
    });

    it("the write patterns match both forms (non-vacuous)", () => {
      expect(DRIZZLE_WRITE.test("tx.update(billingAccount).set({})")).toBe(
        true,
      );
      expect(RAW_WRITE.test("UPDATE billing.billing_account SET x = 1")).toBe(
        true,
      );
      expect(
        RAW_WRITE.test('INSERT INTO "billing"."billing_account" (a)'),
      ).toBe(true);
      expect(RAW_WRITE.test("FROM billing.billing_account ba")).toBe(false);
      expect(RAW_WRITE.test("UPDATE billing.billing_account_x SET x = 1")).toBe(
        false,
      );
    });
  });
});
