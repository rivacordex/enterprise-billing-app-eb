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
  // pm19-spec §2.5/§3.6, closed out by pm24-spec §2.3/§3.2. Supersedes the
  // v1 "folder must not exist" assertion — pm19 is the unit that creates it.
  // pm20–pm23 each appended their own action file to this array as they
  // landed; pm24 takes over ownership of this assertion for good now that
  // all eight files exist (matching code-standards-phase2 §7's full file
  // tree), extending the check from "the right file set exists" to "each
  // file exports exactly the one function its own spec promised."
  const PRODUCT_ACTION_FILES: Record<string, string> = {
    "create-offering.action.ts": "createOfferingAction",
    "update-offering.action.ts": "updateOfferingAction",
    "create-specification.action.ts": "createSpecificationAction",
    "update-specification.action.ts": "updateSpecificationAction",
    "delete-specification.action.ts": "deleteSpecificationAction",
    "insert-price.action.ts": "insertPriceAction",
    "activate-offering.action.ts": "activateOfferingAction",
    "retire-offering.action.ts": "retireOfferingAction",
  };

  it("actions/product/ exists and exports exactly this phase's action set", () => {
    const actionsDir = path.join(REPO_ROOT, "actions", "product");
    expect(fs.existsSync(actionsDir)).toBe(true);

    const actualFiles = fs
      .readdirSync(actionsDir)
      .filter((name) => name.endsWith(".action.ts"))
      .sort();
    expect(actualFiles).toEqual(Object.keys(PRODUCT_ACTION_FILES).sort());

    for (const [fileName, exportName] of Object.entries(PRODUCT_ACTION_FILES)) {
      const source = fs.readFileSync(path.join(actionsDir, fileName), "utf8");
      const matches = source.match(
        new RegExp(`export async function ${exportName}\\(`, "g"),
      );
      expect(matches?.length ?? 0).toBe(1);
    }
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

  // Guardrail 12 (code-standards-phase2 §9). pm18 already added the route
  // itself to ROUTE_MANIFEST (confirmed via pm24-spec §3.1's pre-flight
  // audit — grep found it present); this assertion is the sweep file's own
  // re-check of the manifest's content, module-wide, mirroring the
  // "/products/product-offering" assertion above.
  it('the frozen route manifest includes "/products/manage-products" exactly once', () => {
    const routeManifestSource = fs.readFileSync(
      path.join(REPO_ROOT, "tests", "app", "route-manifest.test.ts"),
      "utf8",
    );
    const manifestMatch = routeManifestSource.match(
      /const ROUTE_MANIFEST = \[([\s\S]*?)\] as const;/,
    );
    expect(manifestMatch).not.toBeNull();

    const occurrences = (
      manifestMatch?.[1]?.match(/"\/products\/manage-products"/g) ?? []
    ).length;
    expect(occurrences).toBe(1);
  });

  // Guardrail 11 (code-standards-phase2 §9). View Product's own components
  // (components/products/*.tsx, excluding the manage/ subfolder — that's
  // write-capable UI by design, prodmgmt-architecture-phase2 §2) and the
  // View Product page tree must import nothing that could mutate product
  // data. Structural, string-level — same style as guardrail 4 above.
  const FORBIDDEN_IMPORT_SUBSTRINGS = [
    "@/actions/product",
    "@/components/products/manage",
    ...[...PRODUCT_WRITE_SERVICE_FILES].map(
      (f) => `@/services/product/${f.replace(/\.ts$/, "")}`,
    ),
  ];

  it("View Product imports nothing from the write surface", () => {
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
      return FORBIDDEN_IMPORT_SUBSTRINGS.some((needle) =>
        content.includes(needle),
      );
    });

    expect(offending.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Guardrail 13. Frozen Phase-1 baselines (prodmgmt-architecture-phase2 §3:
  // family_offering_id is the *only* schema addition this phase makes).
  const PHASE1_OFFERING_COLUMNS = [
    "productOfferingId",
    "name",
    "isBundle",
    "isSellable",
    "billingOnly",
    "lifecycleStatus",
    "version",
    "lastModified",
    "lastEditedBy",
  ].sort();
  const SPECIFICATIONS_COLUMNS = [
    "productSpecId",
    "refProductOfferingId",
    "name",
    "isMandatory",
    "isDefault",
    "defaultValue",
    "productSpecCharacteristics",
  ].sort();
  const PRICE_COLUMNS = [
    "productOfferingPriceId",
    "productOfferingId",
    "name",
    "priceType",
    "recurringChargePeriodLength",
    "recurringChargePeriodType",
    "unitOfMeasure",
    "amount",
    "currency",
    "glCode",
    "pricingModel",
    "policy",
    "pricingCharacteristics",
    "startDateTime",
    "createdAt",
  ].sort();

  function extractTableColumnNames(
    source: string,
    tableVarName: string,
  ): string[] {
    const tableMatch = source.match(
      new RegExp(
        `export const ${tableVarName} = product\\.table\\(\\s*"[a-z_]+",\\s*\\{([\\s\\S]*?)\\n  \\},`,
      ),
    );
    expect(tableMatch).not.toBeNull();
    return [...(tableMatch?.[1] ?? "").matchAll(/^\s{4}(\w+):/gm)]
      .map((m) => m[1] ?? "")
      .sort();
  }

  it("db/schema/product.ts diffs from Phase 1 by exactly family_offering_id + its index", () => {
    const source = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "product.ts"),
      "utf8",
    );

    const offeringColumns = extractTableColumnNames(source, "productOffering");
    expect(offeringColumns).toEqual(
      [...PHASE1_OFFERING_COLUMNS, "familyOfferingId"].sort(),
    );

    expect(extractTableColumnNames(source, "productSpecifications")).toEqual(
      SPECIFICATIONS_COLUMNS,
    );
    expect(extractTableColumnNames(source, "productOfferingPrice")).toEqual(
      PRICE_COLUMNS,
    );

    expect(source).toContain("product_offering_family_idx");
  });

  // Guardrail 10 (code-standards-phase2 §9), closing pm14's own open item
  // (pm14-spec's closing line explicitly left open whether this becomes
  // "asserted structurally" or stays "by construction"). Does not re-verify
  // the *behavior* — tests/db/product-repositories.integration.test.ts's own
  // branch-first-when-ACTIVE tests do that — this verifies the *shape*:
  // exactly one call site exists for the repository's delete method, and it
  // is delete-specification.ts's own branch-first-routed service.
  //
  // Deliberately dot-qualified only (`productSpecificationRepository.
  // deleteSpecification(`), not a bare-name match: the repository is only
  // ever accessed through its `productSpecificationRepository` object
  // (never destructured elsewhere in this codebase), so a bare-name check
  // would also match `actions/product/delete-specification.action.ts`
  // calling the *service* function of the same name — a legitimate,
  // expected call site, not a repository-layer violation.
  it("productSpecificationRepository.deleteSpecification has exactly one call site (delete-specification.ts)", () => {
    const scanRoots = [
      path.join(REPO_ROOT, "services", "product"),
      path.join(REPO_ROOT, "components", "products"),
      path.join(REPO_ROOT, "actions", "product"),
    ];
    const callSites = scanRoots
      .flatMap(collectFiles)
      .filter((f) => path.basename(f) !== "delete-specification.ts")
      .filter((f) =>
        /productSpecificationRepository\.deleteSpecification\(/.test(
          fs.readFileSync(f, "utf8"),
        ),
      );

    expect(callSites.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });
});
