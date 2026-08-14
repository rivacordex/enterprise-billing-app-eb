import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm34-spec §Implementation-2 — the Update guardrail sweep's own new
// structural coverage (guardrails 19-21; §9 of prodmgmt-code-standards.md).
// Guardrails 15 (insert-only surfaces) and 18-structural (write-once core)
// already live permanently in tests/db/ordering-repository-exports.test.ts
// (pm26); the action-file-set-exact half of guardrail 19 already lives in
// tests/guardrails/ordering-module-boundaries.test.ts and
// inventory-module-boundaries.test.ts (EXPECTED_ORDERING_ACTION_FILES /
// EXPECTED_INVENTORY_ACTION_FILES); the db/schema/product.ts byte-identical
// half of guardrail 19 already lives in
// tests/guardrails/product-module-boundaries.test.ts (unchanged by this
// unit — pm25-33 never touched that file, confirmed by this same sweep's
// own read of it). None of those are duplicated here — this file adds only
// what genuinely has no home yet: the app/api absence check for the two new
// schemas' route-shape, the View Product write-surface re-check extended to
// ordering/inventory, the no-cycle-column schema introspection, and the
// route-manifest occurrence check for the two new routes. Pure
// node:fs/node:path + static-source assertions — no jsdom, no DB — same
// shape as product-module-boundaries.test.ts.
const REPO_ROOT = path.resolve(__dirname, "../..");

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];

  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);

    if (entry.isDirectory()) {
      files.push(...collectFiles(entryPath));
    } else if (entry.isFile()) {
      files.push(entryPath);
    }
  }

  return files;
}

describe("ordering + inventory ship-gate sweep (pm34)", () => {
  // Guardrail 19 (code-standards §9), architecture §1/§5: no Route Handler
  // ever exists for either new schema, same permanent rule as
  // app/api/product* (code-standards §5.1/§5.3, product-module-boundaries.
  // test.ts's own check — re-derived here for the two new prefixes since
  // that file only ever scanned for "product").
  it("has no app/api/ordering* or app/api/inventory* path", () => {
    const apiDir = path.join(REPO_ROOT, "app", "api");
    const offending = collectFiles(apiDir)
      .map((filePath) => path.relative(apiDir, filePath))
      .filter((relativePath) =>
        relativePath
          .split(path.sep)
          .some((segment) => /^(ordering|inventory)/.test(segment)),
      );

    expect(offending).toEqual([]);
  });

  // Guardrail 19 continued: View Product (components/products/*.tsx,
  // excluding manage/ordering/inventory subfolders, plus its page tree)
  // imports nothing from the Ordering update's write surface either —
  // product-module-boundaries.test.ts's own "write surface" check predates
  // actions/ordering, actions/inventory, and components/products/ordering|
  // inventory, so it can't see them; this is the same technique pointed at
  // the two new directories.
  const ORDERING_INVENTORY_WRITE_SURFACE_DIRS = [
    path.join(REPO_ROOT, "actions", "ordering"),
    path.join(REPO_ROOT, "actions", "inventory"),
    path.join(REPO_ROOT, "components", "products", "ordering"),
    path.join(REPO_ROOT, "components", "products", "inventory"),
    path.join(REPO_ROOT, "services", "ordering"),
    path.join(REPO_ROOT, "services", "inventory"),
  ].map((p) => p.replace(/\\/g, "/"));

  function extractImportSpecifiers(source: string): string[] {
    const re =
      /(?:import|export)(?:(?!from)[^'";])*from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
    return [...source.matchAll(re)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? "",
    );
  }

  function resolveSpecifier(
    specifier: string,
    fromFile: string,
  ): string | null {
    if (specifier.startsWith("@/")) {
      return path.join(REPO_ROOT, specifier.slice(2)).replace(/\\/g, "/");
    }
    if (specifier.startsWith(".")) {
      return path
        .resolve(path.dirname(fromFile), specifier)
        .replace(/\\/g, "/");
    }
    return null;
  }

  function targetsOrderingInventoryWriteSurface(resolvedPath: string): boolean {
    const noExt = resolvedPath.replace(/\.(ts|tsx)$/, "");
    return ORDERING_INVENTORY_WRITE_SURFACE_DIRS.some(
      (dir) => noExt === dir || noExt.startsWith(`${dir}/`),
    );
  }

  it("View Product imports nothing from the Ordering update's write surface", () => {
    const viewProductPageFiles = collectFiles(
      path.join(REPO_ROOT, "app", "(app)", "products", "product-offering"),
    );
    const readOnlyComponentFiles = fs
      .readdirSync(path.join(REPO_ROOT, "components", "products"), {
        withFileTypes: true,
      })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".tsx"))
      .map((entry) =>
        path.join(REPO_ROOT, "components", "products", entry.name),
      );

    const filesToScan = [...viewProductPageFiles, ...readOnlyComponentFiles];
    expect(filesToScan.length).toBeGreaterThan(0);

    const offending = filesToScan.filter((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      return extractImportSpecifiers(content).some((specifier) => {
        const resolved = resolveSpecifier(specifier, filePath);
        return (
          resolved !== null && targetsOrderingInventoryWriteSurface(resolved)
        );
      });
    });

    expect(offending.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Guardrail 20 (code-standards §9), architecture Inv. #20: cycle/frequency
  // live on the BAN (billing.bill_cycle), never on ordering.*/inventory.* —
  // schema introspection over the Drizzle source (same column-name-set
  // technique as product-module-boundaries.test.ts's schema-diff check,
  // applied as a substring scan since this guardrail wants "no such column
  // anywhere," not an exact set).
  it("no ordering.*/inventory.* column name matches %cycle%/%frequency%", () => {
    const orderingSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "ordering.ts"),
      "utf8",
    );
    const inventorySource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "inventory.ts"),
      "utf8",
    );

    // Column defs are `columnName: pgType("column_name")...` — matches the
    // snake_case string literal Postgres actually sees, not the camelCase TS
    // identifier, so a name like `refBillCycleId` (a *reference* to another
    // schema's cycle, not a cycle/frequency column of this schema's own)
    // isn't what this scans; it scans the literal column-name strings this
    // schema defines. There are none matching billing's own bill_cycle here
    // since ordering/inventory hold no such reference (architecture §3).
    const columnNamePattern = /"\s*([a-z_]+)\s*"/g;
    for (const [label, source] of [
      ["ordering.ts", orderingSource],
      ["inventory.ts", inventorySource],
    ] as const) {
      const columnNames = [...source.matchAll(columnNamePattern)].map(
        (m) => m[1] ?? "",
      );
      const offending = columnNames.filter((name) =>
        /cycle|frequency/i.test(name),
      );
      expect(
        offending,
        `${label} column names: ${columnNames.join(", ")}`,
      ).toEqual([]);
    }
  });

  // Guardrail 21 (code-standards §9), same technique as
  // product-module-boundaries.test.ts's own two route-manifest checks,
  // applied to both Ordering-update routes.
  it.each(["/products/orders", "/products/subscriptions"])(
    'the frozen route manifest includes "%s" exactly once',
    (route) => {
      const routeManifestSource = fs.readFileSync(
        path.join(REPO_ROOT, "tests", "app", "route-manifest.test.ts"),
        "utf8",
      );
      const manifestMatch = routeManifestSource.match(
        /const ROUTE_MANIFEST = \[([\s\S]*?)\] as const;/,
      );
      expect(manifestMatch).not.toBeNull();

      const escaped = route.replace(/\//g, "\\/");
      const occurrences = (
        manifestMatch?.[1]?.match(new RegExp(`"${escaped}"`, "g")) ?? []
      ).length;
      expect(occurrences).toBe(1);
    },
  );
});
