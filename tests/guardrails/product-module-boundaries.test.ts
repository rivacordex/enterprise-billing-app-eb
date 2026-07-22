import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// pm09-spec §3.3 — the module's ship-gate guardrail sweep. Turns the v1
// negative-space invariants (no mutation surface, no new audited path,
// no forbidden route/action shape) into permanent, executable CI facts
// rather than prose a future change could silently violate. Pure
// node:fs/node:path + static-source assertions — no jsdom, no DB — same
// shape as pm01's route-manifest.test.ts, so it runs in the fast unit suite.
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

describe("product module boundaries (pm09 ship-gate sweep)", () => {
  // Inv. #11 / code-standards §7.2: v1 adds no mutation surface, and the
  // module owns no server actions.
  it("has no actions/product/ folder", () => {
    expect(fs.existsSync(path.join(REPO_ROOT, "actions", "product"))).toBe(
      false,
    );
  });

  // code-standards §5.1/§5.3: v1 exposes no product route handler — every
  // read goes through the guarded RSC page, never an API route.
  it("has no app/api/product* path", () => {
    const apiDir = path.join(REPO_ROOT, "app", "api");
    const offending = collectFiles(apiDir)
      .map((filePath) => path.relative(apiDir, filePath))
      .filter((relativePath) =>
        relativePath
          .split(path.sep)
          .some((segment) => /^product/.test(segment)),
      );

    expect(offending).toEqual([]);
  });

  // Inv. #1 / code-standards §1.2: the price repository permanently exports
  // no update*/delete* — the only write the CRUD fast-follow may ever add
  // is insertPrice. Structural, string-level; duplicates pm03's runtime
  // export-shape assert deliberately so the ship gate re-checks it
  // module-wide from source, not just via a live import.
  it("the price repository's exported methods include no update*/delete* (insertPrice excepted)", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "db", "repositories", "product-offering-price.ts"),
      "utf8",
    );
    const objectBody = source.match(
      /productOfferingPriceRepository\s*=\s*\{([\s\S]*)\n\};/,
    );
    expect(objectBody).not.toBeNull();

    const methodNames = [
      ...(objectBody?.[1] ?? "").matchAll(
        /^\s*(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm,
      ),
    ].map((match) => match[1] ?? "");
    expect(methodNames.length).toBeGreaterThan(0);

    const forbidden = methodNames.filter((name) =>
      /^(update|delete|insert(?!Price\b))/.test(name),
    );
    expect(forbidden).toEqual([]);
  });

  // Inv. #7 / code-standards §1.3: reads are not audited. No product read
  // path (service, repository, page, or component) may import the audit
  // write path — the AUDIT_LOG table gains no row from viewing the catalog.
  // Phase 2 (pm11+) adds write services under services/product/ that
  // legitimately import the audit-write path (create/update/branch/activate/
  // retire offerings, per prodmgmt-architecture-phase2 §5) — those are
  // excluded by name so this guardrail keeps checking only the read services
  // (list-offerings.ts, get-offering-detail.ts), not the whole directory.
  const PRODUCT_WRITE_SERVICE_FILES = new Set([
    "create-offering.ts",
    "update-offering.ts",
    "add-specification.ts",
    "update-specification.ts",
    "delete-specification.ts",
    "insert-price.ts",
    "activate-offering.ts",
    "retire-offering.ts",
  ]);

  it("no product read path imports the audit-log write path", () => {
    const productServiceFiles = collectFiles(
      path.join(REPO_ROOT, "services", "product"),
    ).filter(
      (filePath) => !PRODUCT_WRITE_SERVICE_FILES.has(path.basename(filePath)),
    );
    const scanRoots = [
      path.join(REPO_ROOT, "app", "(app)", "products"),
      path.join(REPO_ROOT, "components", "products"),
    ];
    const productRepoFiles = collectFiles(
      path.join(REPO_ROOT, "db", "repositories"),
    ).filter((filePath) => path.basename(filePath).startsWith("product-"));

    const filesToScan = scanRoots
      .flatMap(collectFiles)
      .concat(productServiceFiles, productRepoFiles);
    expect(filesToScan.length).toBeGreaterThan(0);

    const offending = filesToScan.filter((filePath) => {
      const content = fs.readFileSync(filePath, "utf8");
      return (
        content.includes("audit.repository") ||
        content.includes("insertAuditEvent") ||
        content.includes("AUDIT_LOG")
      );
    });

    expect(offending.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // build-plan visible result / guardrail 7 extension: the rename-invariance
  // guard consciously accounts for the module's one new route rather than
  // flagging it as unplanned — the frozen manifest names it exactly once.
  it('the frozen route manifest includes "/products/product-offering" exactly once', () => {
    const routeManifestSource = fs.readFileSync(
      path.join(REPO_ROOT, "tests", "app", "route-manifest.test.ts"),
      "utf8",
    );
    const manifestMatch = routeManifestSource.match(
      /const ROUTE_MANIFEST = \[([\s\S]*?)\] as const;/,
    );
    expect(manifestMatch).not.toBeNull();

    const occurrences = (
      manifestMatch?.[1]?.match(/"\/products\/product-offering"/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });
});
