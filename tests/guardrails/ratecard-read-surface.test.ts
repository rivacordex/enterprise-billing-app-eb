import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm65-spec I6 — the read-surface guardrails that have no other home: guardrail
// 40 (no cache on the page or the read services), the components/products/
// rate-card ↔ manage import boundary (§7.11, test 14), `formatCurrency` called
// nowhere (test 8), the "Lookup exceptions" card absent in any form (test 15),
// every mutating control absent-not-disabled (test 2), and the version list's
// row_count-only rule (test 9). Pure node:fs static-source assertions — same
// shape as product-module-boundaries.test.ts.
const REPO_ROOT = path.resolve(__dirname, "../..");

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) files.push(...collectFiles(entryPath));
    else if (entry.isFile()) files.push(entryPath);
  }
  return files;
}

// Strip `//` line comments and `/* */` block comments so an explanatory comment
// naming a banned construct (every one of these files documents "no cache",
// "never formatCurrency", etc.) never trips a substring scan — the same
// comment-stripping the guardrail-13 baseline uses before banning an identifier.
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
}

const RATE_CARD_PAGE_DIR = path.join(
  REPO_ROOT,
  "app",
  "(app)",
  "products",
  "rate-card",
);
const RATE_CARD_SERVICE_DIR = path.join(
  REPO_ROOT,
  "services",
  "product",
  "ratecard",
);
const RATE_CARD_COMPONENT_DIR = path.join(
  REPO_ROOT,
  "components",
  "products",
  "rate-card",
);
const RATE_CARD_MANAGE_DIR = path.join(
  REPO_ROOT,
  "components",
  "products",
  "manage",
);

// The two read services pm65 owns (the mutation services in this folder —
// upload/activate/rollback — are not read paths and are out of scope here).
const READ_SERVICE_FILES = [
  path.join(RATE_CARD_SERVICE_DIR, "list-versions.ts"),
  path.join(RATE_CARD_SERVICE_DIR, "get-version-rows.ts"),
];

const RATE_CARD_COMPONENT_FILES = collectFiles(RATE_CARD_COMPONENT_DIR);

describe("rate-card read surface (pm65 guardrails)", () => {
  // Guardrail 40 (Inv. #59, §1.44): no cache wraps any card read — not in the
  // page, not in the read services. The ACTIVE version changes at any
  // activation/rollback, so any cached copy is stale the moment it is taken.
  it("guardrail 40 — no cache wrapper in the page or the read services", () => {
    const filesToScan = [
      ...collectFiles(RATE_CARD_PAGE_DIR),
      ...READ_SERVICE_FILES,
    ];
    expect(filesToScan.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of filesToScan) {
      const code = stripComments(fs.readFileSync(file, "utf8"));
      if (
        /\bunstable_cache\b/.test(code) ||
        /unstable_cacheLife|unstable_cacheTag/.test(code) ||
        /export\s+const\s+revalidate\b/.test(code) ||
        /\brevalidate\s*[:=]/.test(code) ||
        // React `cache(` — a bare `cache(...)` call (the import would be
        // `import { cache } from "react"`). The page's `getAppName` is
        // React.cached in app-config-read.service.ts, NOT here, so no rate-card
        // file calls `cache(` itself.
        /(?<![.\w])cache\s*\(/.test(code)
      ) {
        offenders.push(path.relative(REPO_ROOT, file));
      }
    }
    expect(offenders).toEqual([]);
  });

  it("guardrail 40 — the page is force-dynamic", () => {
    const src = fs.readFileSync(
      path.join(RATE_CARD_PAGE_DIR, "page.tsx"),
      "utf8",
    );
    expect(src).toMatch(/export\s+const\s+dynamic\s*=\s*["']force-dynamic["']/);
  });

  // §7.11 / test 14 — the two sibling folders are isolated: rate-card imports
  // nothing from manage/, and manage/ imports nothing from rate-card/.
  function extractImportSpecifiers(source: string): string[] {
    const re =
      /(?:import|export)(?:(?!from)[^'";])*from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
    return [...source.matchAll(re)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? "",
    );
  }

  it("components/products/rate-card imports nothing from manage/, and manage/ imports nothing from rate-card/", () => {
    const rateCardImportingManage = RATE_CARD_COMPONENT_FILES.filter((file) =>
      extractImportSpecifiers(fs.readFileSync(file, "utf8")).some((s) =>
        /(^|\/)components\/products\/manage(\/|$)/.test(s),
      ),
    );
    const manageImportingRateCard = collectFiles(RATE_CARD_MANAGE_DIR).filter(
      (file) =>
        extractImportSpecifiers(fs.readFileSync(file, "utf8")).some((s) =>
          /(^|\/)components\/products\/rate-card(\/|$)/.test(s),
        ),
    );
    expect(
      rateCardImportingManage.map((f) => path.relative(REPO_ROOT, f)),
    ).toEqual([]);
    expect(
      manageImportingRateCard.map((f) => path.relative(REPO_ROOT, f)),
    ).toEqual([]);
  });

  // Test 8 / §1.45 — `formatCurrency` is called NOWHERE on this page: there is
  // no currency column to call it with (Inv. #53). Scans the page, the read
  // services and every rate-card component.
  it("formatCurrency is imported/called nowhere on the rate-card surface", () => {
    const filesToScan = [
      ...collectFiles(RATE_CARD_PAGE_DIR),
      ...READ_SERVICE_FILES,
      ...RATE_CARD_COMPONENT_FILES,
    ];
    const offenders = filesToScan.filter((file) =>
      /\bformatCurrency\b/.test(stripComments(fs.readFileSync(file, "utf8"))),
    );
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Test 15 / D7 — the mockup's ghosted "Lookup exceptions" card is not built
  // in any form. No rate-card file mentions it.
  it('no "Lookup exceptions" card exists in any rate-card file', () => {
    const filesToScan = [
      ...collectFiles(RATE_CARD_PAGE_DIR),
      ...RATE_CARD_COMPONENT_FILES,
    ];
    const offenders = filesToScan.filter((file) =>
      /lookup exceptions/i.test(fs.readFileSync(file, "utf8")),
    );
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Test 2 / D11 — every mutating control is ABSENT, not disabled. pm65 wires no
  // action: no rate-card page or component imports any Server Action, and none
  // renders a form that posts to one. (pm66 builds every mutating control.)
  it("no rate-card page or component wires a mutating Server Action", () => {
    const filesToScan = [
      ...collectFiles(RATE_CARD_PAGE_DIR),
      ...RATE_CARD_COMPONENT_FILES,
    ];
    const offenders = filesToScan.filter((file) => {
      const specs = extractImportSpecifiers(fs.readFileSync(file, "utf8"));
      return specs.some((s) => /(^|\/)actions\/product\//.test(s));
    });
    expect(offenders.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Test 9 / D-A7 — the version list shows row_count as its only count, with no
  // carried_row_count figure and no retired_at column (both were removed in
  // pm57a). The version table references rowCount and neither dropped field.
  it("the version table renders row_count only — no carriedRowCount, no retiredAt", () => {
    const src = stripComments(
      fs.readFileSync(
        path.join(RATE_CARD_COMPONENT_DIR, "rate-card-version-table.tsx"),
        "utf8",
      ),
    );
    expect(src).toContain("rowCount");
    expect(src).not.toContain("carriedRowCount");
    expect(src).not.toContain("retiredAt");
  });
});
