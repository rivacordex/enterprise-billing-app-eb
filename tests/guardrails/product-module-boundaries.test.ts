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
    "update-price.action.ts": "updatePriceAction",
    "delete-price.action.ts": "deletePriceAction",
    "submit-for-testing.action.ts": "submitForTestingAction",
    "return-to-draft.action.ts": "returnToDraftAction",
    "activate-offering.action.ts": "activateOfferingAction",
    "obsolete-offering.action.ts": "obsoleteOfferingAction",
    "retire-offering.action.ts": "retireOfferingAction",
    "delete-offering.action.ts": "deleteOfferingAction",
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
      const exportedFunctionNames = [
        ...source.matchAll(/export\s+async\s+function\s+(\w+)\s*\(/g),
      ].map((match) => match[1]);
      expect(exportedFunctionNames).toEqual([exportName]);
    }
  });

  // pm41 I5/I6. The two modal editors are retired — their content moved into
  // the inline ManageSpecificationsPanel/ManagePricesPanel. A file scan fails CI
  // if either dialog reappears in the manage folder under its old name.
  it("components/products/manage/ contains neither retired dialog (pm41)", () => {
    const manageDir = path.join(REPO_ROOT, "components", "products", "manage");
    const names = fs.readdirSync(manageDir);
    expect(names).not.toContain("specifications-dialog.tsx");
    expect(names).not.toContain("add-price-dialog.tsx");
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

  // Inv. #1 (amended) / code-standards §1.2 / guardrail 2 (re-scoped): the price
  // repository exports EXACTLY three writes plus the one finder — no fourth is
  // ever added — and each mutator (`updatePrice`/`deletePrice`) carries a
  // `DRAFT` status check, the code-shape backstop that mirrors the §3.5 trigger.
  // Structural, string-level; the live-import counterpart is
  // tests/db/product-repository-exports.test.ts, and the DB-side refusal of a
  // non-DRAFT write is proven by tests/db/product-price-writes.integration.test.ts.
  it("the price repository exports exactly findByOfferingIdWithDerivedEnd, insertPrice, updatePrice, deletePrice, and the two mutators check for DRAFT (pm38 D6)", () => {
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
        /^\s{2}(?:async\s+)?([a-zA-Z_$][\w$]*)\s*\(/gm,
      ),
    ].map((match) => match[1] ?? "");

    expect(methodNames.sort()).toEqual(
      [
        "deletePrice",
        "findByOfferingIdWithDerivedEnd",
        "insertPrice",
        "updatePrice",
      ].sort(),
    );

    // Each mutator's own body refuses a non-DRAFT parent. The methods delegate
    // the locked parent read to `lockParentStatus`, but the DRAFT decision
    // (`!== "DRAFT"` → OFFERING_NOT_DRAFT) lives in each method body itself.
    for (const method of ["updatePrice", "deletePrice"]) {
      const body =
        source.match(
          new RegExp(`async ${method}\\([\\s\\S]*?\\n  \\},`),
        )?.[0] ?? "";
      expect(body).toContain('"DRAFT"');
      expect(body).toContain("OFFERING_NOT_DRAFT");
    }
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
    "update-price.ts",
    "delete-price.ts",
    "submit-for-testing.ts",
    "return-to-draft.ts",
    "activate-offering.ts",
    "obsolete-offering.ts",
    "retire-offering.ts",
    "delete-offering.ts",
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

  // pm39 D6/I8. The fetch-everything page's nine helpers/types are deleted for
  // good; a string-level scan of the rewritten page fails CI if any is
  // reintroduced under the same name (leaving one in place invites the next
  // agent to call it).
  it("manage-products/page.tsx contains none of pm39's nine deleted identifiers", () => {
    const source = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "app",
        "(app)",
        "products",
        "manage-products",
        "page.tsx",
      ),
      "utf8",
    );
    const DELETED_IDENTIFIERS = [
      "fetchAllForStatus",
      "fetchAllOfferingRows",
      "fetchSpecificationsByOfferingId",
      "mapWithConcurrencyLimit",
      "groupIntoFamilies",
      "selectPrimary",
      "resolveFamilyId",
      "MAX_COMBINED_ROWS",
      "OfferingFamilyRow",
    ];
    const present = DELETED_IDENTIFIERS.filter((id) => source.includes(id));
    expect(present).toEqual([]);
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
  const WRITE_SURFACE_DIRS = [
    path.join(REPO_ROOT, "actions", "product"),
    path.join(REPO_ROOT, "components", "products", "manage"),
  ].map((p) => p.replace(/\\/g, "/"));
  const WRITE_SURFACE_SERVICE_FILES = [...PRODUCT_WRITE_SERVICE_FILES].map(
    (f) =>
      path
        .join(REPO_ROOT, "services", "product", f)
        .replace(/\.ts$/, "")
        .replace(/\\/g, "/"),
  );

  // Extracts every module specifier this file references — static
  // import/export-from declarations and dynamic import() calls alike —
  // rather than scanning raw text, so an unrelated string that happens to
  // contain a forbidden substring (or a barrel re-export naming its target
  // in a shape a substring scan wouldn't catch) is handled correctly either
  // way.
  function extractImportSpecifiers(source: string): string[] {
    const re =
      /(?:import|export)(?:(?!from)[^'";])*from\s*["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)|import\s*["']([^"']+)["']/g;
    return [...source.matchAll(re)].map(
      (match) => match[1] ?? match[2] ?? match[3] ?? "",
    );
  }

  // Resolves a specifier the way the app's own module resolution would
  // (`@/*` alias to repo root, `.`/`..` relative to the importing file) —
  // returns null for bare package specifiers, which can never point at this
  // codebase's own write surface.
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

  function targetsWriteSurface(resolvedPath: string): boolean {
    const noExt = resolvedPath.replace(/\.(ts|tsx)$/, "");
    if (
      WRITE_SURFACE_DIRS.some(
        (dir) => noExt === dir || noExt.startsWith(`${dir}/`),
      )
    ) {
      return true;
    }
    return WRITE_SURFACE_SERVICE_FILES.includes(noExt);
  }

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
      return extractImportSpecifiers(content).some((specifier) => {
        const resolved = resolveSpecifier(specifier, filePath);
        return resolved !== null && targetsWriteSurface(resolved);
      });
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
  // Reshaped by pm46-spec D2/I5 — the first change to this list since pm02.
  // `priceType`/`pricingModel`/`amount`/`pricingCharacteristics` leave;
  // `componentType`/`priceComponent` arrive.
  const PRICE_COLUMNS = [
    "productOfferingPriceId",
    "productOfferingId",
    "name",
    "componentType",
    "priceComponent",
    "recurringChargePeriodLength",
    "recurringChargePeriodType",
    "unitOfMeasure",
    "currency",
    "glCode",
    "policy",
    "startDateTime",
    "createdAt",
  ].sort();

  // Isolates the full `product.table("...", { ... }, (t) => [ ... ]);` call
  // for one table — both the column-def object and the index/check callback
  // — so index/column assertions can be scoped to that one table's block
  // instead of a repository-wide `source.toContain`, which a comment or an
  // unrelated table's index could also satisfy.
  function extractTableBlock(source: string, tableVarName: string): string {
    const tableMatch = source.match(
      new RegExp(
        `export const ${tableVarName} = product\\.table\\(\\s*"[a-z_]+",[\\s\\S]*?\\n\\);`,
      ),
    );
    expect(tableMatch).not.toBeNull();
    return tableMatch?.[0] ?? "";
  }

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

    const offeringTableBlock = extractTableBlock(source, "productOffering");
    expect(offeringTableBlock).toContain("product_offering_family_idx");
  });

  // Guardrail 13 (constraint baseline) — pm35-spec I5, re-baselined by
  // pm46-spec I5.3. Sits *beside* the column-diff test above. Freezes: the
  // five enum members in lifecycle order, and the cascade direction on the
  // child FKs (both untouched by pm46).
  it("db/schema/product.ts + 0006 freeze the five-value enum and the cascade child FKs (pm35 D3/D5)", () => {
    const schemaSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "product.ts"),
      "utf8",
    );
    const migrationSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "migrations", "0006_product.sql"),
      "utf8",
    );

    const EXPECTED_ENUM = ["DRAFT", "TESTING", "ACTIVE", "OBSOLETE", "RETIRED"];

    // 1. Enum members in lifecycle (declaration) order — the array literal.
    const enumMatch = schemaSource.match(
      /product\.enum\(\s*"lifecycle_status",\s*\[([\s\S]*?)\]/,
    );
    expect(enumMatch).not.toBeNull();
    const enumMembers = [...(enumMatch?.[1] ?? "").matchAll(/"([A-Z]+)"/g)].map(
      (m) => m[1],
    );
    expect(enumMembers).toEqual(EXPECTED_ENUM);

    // 2. Both child FKs cascade; the self-referencing family FK still restricts.
    const specBlock = extractTableBlock(schemaSource, "productSpecifications");
    const priceBlock = extractTableBlock(schemaSource, "productOfferingPrice");
    expect(specBlock).toContain('onDelete: "cascade"');
    expect(priceBlock).toContain('onDelete: "cascade"');
    const offeringBlock = extractTableBlock(schemaSource, "productOffering");
    expect(offeringBlock).toContain('onDelete: "restrict"'); // familyOfferingId

    // 3. The SQL of record agrees with the Drizzle mirror.
    expect(migrationSource).toContain(
      "AS ENUM('DRAFT', 'TESTING', 'ACTIVE', 'OBSOLETE', 'RETIRED')",
    );
    // Both child-table FK ALTERs carry ON DELETE cascade (2 occurrences); the
    // family FK is inline on product_offering and stays restrict, untouched.
    const cascadeCount = (migrationSource.match(/ON DELETE cascade/g) ?? [])
      .length;
    expect(cascadeCount).toBe(2);
  });

  // Guardrail 13 (component-envelope baseline) — pm46-spec I5.2/I5.3/I5.4.
  // Freezes the reshaped price table: the six per-component-type CHECKs, the
  // `pricing_steps_ok` helper, the `NULLS NOT DISTINCT` unique constraint, the
  // component_type index, the absence of the four dropped columns/CHECK names
  // (plus the two necessarily-dropped `price_type`-keyed CHECKs — see the
  // progress tracker's pm46 deviation note), and the absence of any backfill
  // artifact (D9) — in both the SQL of record and the Drizzle mirror.
  it("db/schema/product.ts + 0006/0007 freeze the reshaped price-component envelope (pm46 D2/D3/D6)", () => {
    const schemaSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "product.ts"),
      "utf8",
    );
    const migrationSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "migrations", "0006_product.sql"),
      "utf8",
    );
    const constraintsFixSource = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "db",
        "migrations",
        "0007_product_constraints_fix.sql",
      ),
      "utf8",
    );

    const NEW_CHECKS = [
      "product_offering_price_component_type_check",
      "product_offering_price_envelope_type_check",
      "product_offering_price_usage_rate_check",
      "product_offering_price_flat_fee_check",
      "product_offering_price_capacity_commitment_check",
      "product_offering_price_capacity_motivation_check",
    ];
    const DROPPED_CHECKS = [
      "product_offering_price_type_check",
      "product_offering_price_pricing_model_check",
      "product_offering_price_amount_xor_tiers_check",
      "product_offering_price_amount_check",
      "product_offering_price_recurring_period_check",
      "product_offering_price_usage_unit_check",
    ];
    const DROPPED_COLUMNS = [
      "price_type",
      "pricing_model",
      "pricing_characteristics",
    ];

    const priceBlock = extractTableBlock(schemaSource, "productOfferingPrice");

    // 1. The six new CHECKs exist in both the SQL of record and the mirror.
    for (const name of NEW_CHECKS) {
      expect(migrationSource).toContain(name);
      expect(priceBlock).toContain(name);
    }

    // 2. None of the ten dropped CHECK names survive anywhere under
    // db/migrations/** (0006, 0007) or the Drizzle mirror.
    for (const name of DROPPED_CHECKS) {
      expect(migrationSource).not.toContain(name);
      expect(constraintsFixSource).not.toContain(name);
      expect(priceBlock).not.toContain(name);
    }

    // 3. The dropped columns appear in neither the SQL price-table body nor
    // the Drizzle mirror. `amount` is checked as a whole-word column
    // declaration (`"amount"` / `amount:`) so it doesn't false-positive on
    // `committedQuantity`/`ratePerUnit` money-string predicates that mention
    // amounts in prose or on JSON keys like `params.amount`.
    for (const name of DROPPED_COLUMNS) {
      expect(migrationSource).not.toContain(`"${name}"`);
      expect(priceBlock).not.toMatch(new RegExp(`\\b${name}:`));
    }
    expect(migrationSource).not.toMatch(/"amount"\s+numeric/);
    expect(priceBlock).not.toMatch(/\bamount:\s*numeric/);

    // 4. component_type/price_component exist, NOT NULL, in both homes.
    expect(migrationSource).toMatch(/"component_type" text NOT NULL/);
    expect(migrationSource).toMatch(/"price_component" jsonb NOT NULL/);
    expect(priceBlock).toContain(
      'componentType: text("component_type").notNull()',
    );
    expect(priceBlock).toContain(".$type<PricingComponent>()");

    // 5. The IMMUTABLE helper function exists, declared before the table.
    const fnIndex = migrationSource.indexOf(
      "CREATE FUNCTION product.pricing_steps_ok",
    );
    const tableIndex = migrationSource.indexOf(
      'CREATE TABLE "product"."product_offering_price"',
    );
    expect(fnIndex).toBeGreaterThan(-1);
    expect(tableIndex).toBeGreaterThan(-1);
    expect(fnIndex).toBeLessThan(tableIndex);
    expect(migrationSource).toContain("LANGUAGE sql IMMUTABLE");

    // 6. The uniqueness rekey — a UNIQUE constraint (not a unique index)
    // carrying NULLS NOT DISTINCT — in both homes; the old index is gone.
    expect(migrationSource).toContain(
      'ADD CONSTRAINT "product_offering_price_component_start_unique" UNIQUE NULLS NOT DISTINCT',
    );
    expect(migrationSource).not.toContain(
      "product_offering_price_type_start_unique",
    );
    expect(priceBlock).toContain(
      "product_offering_price_component_start_unique",
    );
    expect(priceBlock).toContain(".nullsNotDistinct()");
    expect(priceBlock).not.toContain(
      "product_offering_price_type_start_unique",
    );

    // 7. The component_type index exists in both homes; the offering index
    // (untouched) survives beside it.
    expect(migrationSource).toContain(
      "product_offering_price_component_type_idx",
    );
    expect(priceBlock).toContain("product_offering_price_component_type_idx");
    expect(migrationSource).toContain("product_offering_price_offering_idx");
    expect(priceBlock).toContain("product_offering_price_offering_idx");

    // 8. D9 — no backfill/data-fix/relabelling artifact exists anywhere under
    // db/migrations/** or scripts/**.
    const BACKFILL_PATTERN = /backfill|data-?fix|migrate-price/i;
    const migrationsDir = path.join(REPO_ROOT, "db", "migrations");
    const scriptsDir = path.join(REPO_ROOT, "scripts");
    const offendingFiles = [
      ...collectFiles(migrationsDir),
      ...collectFiles(scriptsDir),
    ].filter((f) => BACKFILL_PATTERN.test(path.basename(f)));
    expect(offendingFiles.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Guardrail 8 + 24 (constraint/trigger backstop) — pm36-spec I5. Freezes the
  // shape 0040_product_family_guards.sql ships: the two expression unique
  // indexes (one open, one ACTIVE per family), the child_write_requires_draft
  // trigger function, and its two BEFORE INSERT OR UPDATE OR DELETE triggers.
  // The function and triggers have no Drizzle representation, so 0040 is the
  // SQL of record; db/schema/product.ts mirrors only the two indexes. The
  // journal must carry 0040 after 0039 (a forward migration, never an edit to
  // an applied file — db/migrations/README.md).
  it("0040 + db/schema/product.ts freeze the family-uniqueness indexes and the DRAFT-guard trigger (pm36 D1/D3)", () => {
    const migrationSource = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "db",
        "migrations",
        "0040_product_family_guards.sql",
      ),
      "utf8",
    );
    const schemaSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "product.ts"),
      "utf8",
    );

    const INDEX_NAMES = [
      "product_offering_one_active_per_family",
      "product_offering_one_open_per_family",
    ];
    const TRIGGER_NAMES = [
      "product_specifications_draft_guard",
      "product_offering_price_draft_guard",
    ];

    // 1. The migration carries both indexes, the function and both triggers.
    for (const name of INDEX_NAMES) {
      expect(migrationSource).toContain(name);
    }
    expect(migrationSource).toContain("child_write_requires_draft");
    for (const name of TRIGGER_NAMES) {
      expect(migrationSource).toContain(name);
    }

    // 2. The Drizzle mirror declares both unique indexes (and only these two —
    // the function/triggers deliberately have no schema representation).
    const offeringBlock = extractTableBlock(schemaSource, "productOffering");
    for (const name of INDEX_NAMES) {
      expect(offeringBlock).toContain(name);
    }

    // 3. The journal carries a 0040 entry whose `when` is greater than 0039's —
    // the ordering the migrator actually gates on (README: it applies an entry
    // only when its `when` exceeds the last-applied one), so a forward migration
    // must sort after 0039. (This asserts the ordering, not that every prior
    // entry is byte-unchanged.)
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "db", "migrations", "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: { tag: string; when: number }[] };
    const entry = journal.entries.find(
      (e) => e.tag === "0040_product_family_guards",
    );
    const prior = journal.entries.find(
      (e) => e.tag === "0039_customer_bill_line",
    );
    expect(entry).toBeDefined();
    expect(prior).toBeDefined();
    expect(entry!.when).toBeGreaterThan(prior!.when);
  });

  // Guardrail 13, re-baselined a THIRD time (pm57-spec I3/D1-D5) — the two
  // new rate-card tables, both partial unique indexes on ratecard_version,
  // the RV2 row-key uniqueness constraint, the cascade FK, and the as-of
  // index, in both the SQL of record (0041) and the Drizzle mirror. Exact
  // diff, not a removal. Guardrail 39 (one ACTIVE per card, enforced by the
  // index — Inv. #45) is proven live against Postgres in
  // tests/db/product-ratecard-schema.integration.test.ts; this file asserts
  // only the static shape, matching every other guardrail-13 baseline here.
  it("0041 + db/schema/product.ts freeze the rate-card schema (pm57 D1-D5)", () => {
    const migrationSource = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "db",
        "migrations",
        "0041_ratecard_ran_usage_lkp.sql",
      ),
      "utf8",
    );
    const schemaSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "product.ts"),
      "utf8",
    );

    const NAMES = [
      "ratecard_version",
      "ratecard_ran_usage_lkp",
      "ratecard_version_card_name_version_num_unique",
      "ratecard_version_one_active_per_card",
      "ratecard_version_one_draft_per_card",
      "ratecard_ran_usage_lkp_row_key_unique",
      "ratecard_ran_usage_lkp_as_of_idx",
    ];
    for (const name of NAMES) {
      expect(migrationSource).toContain(name);
      expect(schemaSource).toContain(name);
    }

    // The cascade FK on the child table, and no FK anywhere on
    // lkp_subscriber_ref_id (RC14, Inv. #57).
    expect(migrationSource).toMatch(
      /FOREIGN KEY \("ratecard_version_id"\) REFERENCES "product"\."ratecard_version"/,
    );
    expect(migrationSource).toContain("ON DELETE cascade");
    expect(migrationSource).not.toMatch(
      /lkp_subscriber_ref_id["`)\s]*REFERENCES/i,
    );

    // No capacity column, no currency column on either table (RC4, Inv. #53).
    expect(migrationSource.toLowerCase()).not.toContain("capacity");
    expect(migrationSource.toLowerCase()).not.toContain("currency");

    // ULID default on the high-volume child; padded-sequence default on the
    // version header — the two conventions deliberately sitting side by
    // side (code-standards §6.24).
    expect(migrationSource).toContain("core.generate_ulid()");
    expect(migrationSource).toContain(
      "'RCV' || lpad(nextval('product.ratecard_version_seq')::text, 8, '0')",
    );

    // G-RC3 is open at authoring time (I6 split) — no PERMISSIONS row ships
    // in this migration. A follow-up migration adds it once the permission
    // name clears.
    expect(migrationSource.toUpperCase()).not.toContain(
      "INSERT INTO CORE.PERMISSIONS",
    );

    // The journal carries a 0041 entry sorting after 0040's.
    const journal = JSON.parse(
      fs.readFileSync(
        path.join(REPO_ROOT, "db", "migrations", "meta", "_journal.json"),
        "utf8",
      ),
    ) as { entries: { tag: string; when: number }[] };
    const entry = journal.entries.find(
      (e) => e.tag === "0041_ratecard_ran_usage_lkp",
    );
    const prior = journal.entries.find(
      (e) => e.tag === "0040_product_family_guards",
    );
    expect(entry).toBeDefined();
    expect(prior).toBeDefined();
    expect(entry!.when).toBeGreaterThan(prior!.when);
  });

  // pm36-spec Dependencies (Grants). The trigger runs as invoker and its
  // internal SELECT reads product.product_offering; rating_runtime and
  // billrun_runtime hold SELECT on the product read tables but must never gain
  // INSERT/UPDATE/DELETE on either product child table — a write grant there
  // would let the trigger's SELECT run under a role lacking SELECT on the
  // parent, surfacing as an opaque trigger failure. A future grant that lets
  // either engine role write a product child table fails CI here.
  it("rating/billrun bootstrap grants no write (INSERT/UPDATE/DELETE) on either product child table", () => {
    const WRITE = /\b(INSERT|UPDATE|DELETE|TRUNCATE|ALL)\b/i;
    // A write privilege reaches a product child table three ways, all scoped to
    // the product schema: naming the table, a schema-wide ALL TABLES grant, or a
    // default-privilege grant on future product tables. All three are covered so
    // the guardrail cannot be sidestepped by the un-named grant forms; SELECT-
    // only grants (the roles' legitimate product reads) match none of them.
    const NAMES_CHILD_TABLE =
      /product"?\.\s*"?(product_specifications|product_offering_price)"?/i;
    const ALL_TABLES_IN_PRODUCT = /ALL\s+TABLES\s+IN\s+SCHEMA\s+"?product"?/i;
    const IN_SCHEMA_PRODUCT = /IN\s+SCHEMA\s+"?product"?/i;

    function writeGrantsOnProductChildTables(sqlText: string): string[] {
      // Split into statements on the breakpoint markers and semicolons; strip
      // line comments so a `--` note mentioning a table never trips the match.
      const statements = sqlText
        .split(/-->\s*statement-breakpoint|;/)
        .map((s) =>
          s
            .split("\n")
            .filter((line) => !line.trim().startsWith("--"))
            .join("\n")
            .trim(),
        );
      const offenders: string[] = [];
      for (const stmt of statements) {
        // Plain GRANT: the privilege list sits between GRANT and ON.
        if (/^GRANT\b/i.test(stmt)) {
          const priv = stmt.match(/^GRANT\s+([\s\S]*?)\bON\b/i)?.[1] ?? "";
          if (!WRITE.test(priv)) continue;
          if (
            NAMES_CHILD_TABLE.test(stmt) ||
            ALL_TABLES_IN_PRODUCT.test(stmt)
          ) {
            offenders.push(stmt.replace(/\s+/g, " ").slice(0, 100));
          }
          continue;
        }
        // ALTER DEFAULT PRIVILEGES … IN SCHEMA "product" … GRANT <write> ON TABLES
        // silently grants writes on every future product table, child tables
        // included — a write grant by another name.
        if (
          /^ALTER\s+DEFAULT\s+PRIVILEGES\b/i.test(stmt) &&
          IN_SCHEMA_PRODUCT.test(stmt) &&
          /\bON\s+TABLES\b/i.test(stmt)
        ) {
          const priv = stmt.match(/\bGRANT\s+([\s\S]*?)\bON\b/i)?.[1] ?? "";
          if (WRITE.test(priv)) {
            offenders.push(stmt.replace(/\s+/g, " ").slice(0, 100));
          }
        }
      }
      return offenders;
    }

    for (const fileName of ["rating-db-roles.sql", "billrun-db-roles.sql"]) {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "db", "bootstrap", fileName),
        "utf8",
      );
      expect(writeGrantsOnProductChildTables(source)).toEqual([]);
    }
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
    const expectedFile = path.join(
      REPO_ROOT,
      "services",
      "product",
      "delete-specification.ts",
    );
    expect(fs.existsSync(expectedFile)).toBe(true);

    const countCallSites = (filePath: string): number =>
      (
        fs
          .readFileSync(filePath, "utf8")
          .match(/productSpecificationRepository\.deleteSpecification\(/g) ?? []
      ).length;

    expect(countCallSites(expectedFile)).toBe(1);

    const scanRoots = [
      path.join(REPO_ROOT, "services", "product"),
      path.join(REPO_ROOT, "components", "products"),
      path.join(REPO_ROOT, "actions", "product"),
    ];
    const offending = scanRoots
      .flatMap(collectFiles)
      .filter((f) => f !== expectedFile)
      .filter((f) => countCallSites(f) > 0);

    expect(offending.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });
});
