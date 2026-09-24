import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  capacityCommitmentComponentSchema,
  capacityMotivationComponentSchema,
  flatFeeComponentSchema,
  negotiatedOverrideComponentSchema,
  persistablePricingComponentSchema,
  usageRateComponentSchema,
} from "@/validation/product/pricing-component.schema";

// pm56-spec (ship gate, Part 4 final unit) — the four guardrails the Pricing
// Components update adds (code-standards §9, "New with the pricing update").
// This file's own boundary is `tests/guardrails/**`: it asserts, it does not
// re-implement (pm45 D1 precedent) — each case either checks a structural
// fact directly or names the integration suite that already behaviourally
// proves it, so nothing here duplicates tests/db/product-price-components
// .integration.test.ts or tests/validation/pricing-component.schema.test.ts.
const REPO_ROOT = path.resolve(__dirname, "../..");

function collectFiles(dir: string): string[] {
  if (!fs.existsSync(dir)) return [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === ".next") continue;
      files.push(...collectFiles(entryPath));
    } else if (/\.(ts|tsx)$/.test(entry.name)) {
      files.push(entryPath);
    }
  }
  return files;
}

// Strips `//` line comments and `/* */` block comments so a doc comment that
// *names* a deleted identifier to explain its absence — e.g. types/product.ts's
// "Deleted: PricingModel and PriceType" note — is not itself flagged as
// residue. What remains is real code: an import, a property access, a type
// reference or a string literal (a `"tiered"` literal IS residue and is kept).
//
// This is a single-pass scanner rather than two blind regexes because the
// blind form strips `//` and `/* */` *inside* string literals and URLs too
// (`"https://…"` → truncated at the `//`), which silently hides real residue
// after such a sequence on the same line. The scanner tracks string state and
// only treats `//`/`/*` as a comment in code context, so a token after a URL
// or inside a string is still seen. Known, accepted limit: a regex literal
// containing an unescaped `//` or `/*` can still be misread as a comment — rare,
// and the residue patterns are unlikely to co-occur with one; the blind form
// had the same gap and worse.
function stripComments(source: string): string {
  let out = "";
  let i = 0;
  const n = source.length;
  while (i < n) {
    const c = source[i];
    const next = source[i + 1];
    // Line comment — drop to end of line, keep the newline.
    if (c === "/" && next === "/") {
      i += 2;
      while (i < n && source[i] !== "\n") i++;
      continue;
    }
    // Block comment — drop through `*/`, preserving interior newlines.
    if (c === "/" && next === "*") {
      i += 2;
      while (i < n && !(source[i] === "*" && source[i + 1] === "/")) {
        if (source[i] === "\n") out += "\n";
        i++;
      }
      i += 2;
      continue;
    }
    // String literal (single/double/template) — copy verbatim, honouring
    // escapes, so `//` and `/*` inside a string or URL are never mistaken for
    // a comment and a residue token inside a string is preserved.
    if (c === '"' || c === "'" || c === "`") {
      const quote = c;
      out += c;
      i++;
      while (i < n) {
        const s = source[i];
        out += s;
        if (s === "\\") {
          if (i + 1 < n) out += source[i + 1];
          i += 2;
          continue;
        }
        i++;
        if (s === quote) break;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

describe("pricing-component guardrails (pm56 ship gate, code-standards §9)", () => {
  // Guardrail 31 — "Tiered is gone." I1.1: a grep across the repository
  // (excluding node_modules/.git) for the six named patterns, comments
  // stripped so this test's own pattern list and types/product.ts's "what
  // was deleted" doc comment don't self-trigger. Scoped to `app/`,
  // `components/`, `db/`, `services/`, `validation/`, `types/`, `tests/` —
  // the D1/Inv. #41 surface — rather than the whole repo, so an unrelated
  // module's own vocabulary (e.g. billing's own "tiered" concept, if any)
  // can't false-positive this guardrail.
  it("guardrail 31 — no tiered/pricing_model/PriceType residue in code (Inv. #41)", () => {
    const PATTERNS: [name: string, re: RegExp][] = [
      ["pricing_model (snake_case)", /\bpricing_model\b/],
      ["pricingModel (identifier)", /\bpricingModel\b/],
      ["PricingModel (type)", /\bPricingModel\b/],
      ["'tiered' / \"tiered\" literal", /(['"])tiered\1/],
      ["tierSchema", /\btierSchema\b/],
      [
        "tieredPricingCharacteristicsSchema",
        /\btieredPricingCharacteristicsSchema\b/,
      ],
      ["TieredPricingCharacteristics", /\bTieredPricingCharacteristics\b/],
      // PriceType is a distinct deleted identifier from PricingModel
      // (code-standards §2.1) — both must resolve to nothing (Inv. #38/#41).
      // `OverridePriceType` (types/ordering.ts, the ordering module's own,
      // never-deleted vocabulary) and `EnvelopePriceType`/`envelopePriceType`
      // (the envelope's own surviving axis) must NOT match this pattern —
      // the word-boundary + exact-case regex excludes both.
      ["PriceType (type)", /(?<!Override|Envelope|envelope)\bPriceType\b/],
    ];

    const SCAN_ROOTS = [
      "app",
      "components",
      "db",
      "services",
      "validation",
      "types",
      "tests",
    ].map((d) => path.join(REPO_ROOT, d));

    // pm56a/I3 (D3) — exclude `tests/guardrails/**` from the walk, a
    // deliberate §7.10 deviation from pm56-spec D1's literal `tests/` root.
    // A sibling guardrail that *names* a dropped token to assert its absence
    // (e.g. product-module-boundaries.test.ts's DROPPED_COLUMNS/DROPPED_CHECKS
    // arrays) is the enforcement layer, not residue — scanning the guardrails
    // for the vocabulary they enforce is a category error that would keep this
    // gate red forever. NOT a §6.9 relaxation: the assertion and pattern list
    // are unchanged, and real residue (production code + any non-guardrail
    // fixture) is still caught. This file lives under that dir, so this also
    // subsumes the former self-exclusion.
    const GUARDRAILS_DIR = path.join(REPO_ROOT, "tests", "guardrails");
    const offenders: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of collectFiles(root)) {
        if (path.resolve(file).startsWith(GUARDRAILS_DIR + path.sep)) continue;
        const stripped = stripComments(fs.readFileSync(file, "utf8"));
        for (const [name, re] of PATTERNS) {
          if (re.test(stripped)) {
            offenders.push(`${path.relative(REPO_ROOT, file)} — ${name}`);
          }
        }
      }
    }

    // KNOWN, FLAGGED, NOT FIXED HERE. After pm56a swept the pre-pm46 test
    // fixtures and excluded the guardrails dir (above), the ONLY residue this
    // scan still finds is the New Order Wizard chain —
    // `components/products/ordering/{new-order-wizard,override-price-fields,
    // wizard-step-offer,wizard-form-types}` and its co-located test
    // `tests/components/new-order-wizard.test.tsx` — which still read the
    // deleted `PriceCard.pricingModel`/`.priceType`/`.amount` and the deleted
    // `PriceType` import (the same 12 files/12 errors `tsc --noEmit` names).
    // That chain is production code owned by **pm56b** and needs a fresh G-G
    // grant, so this guardrail asserts the real, still-incomplete state rather
    // than excluding it to appear green (workflow §6.9 — never relax a gate to
    // pass); it turns green when pm56b lands. See `specs/pm56a-fixture-sweep.md`
    // / `specs/pm56b-ordering-wizard-rekey.md` and the Part 4 hand-off register.
    expect(offenders.sort()).toEqual([]);
  });

  // Guardrail 32 — "Envelope strictness" (Inv. #31), Zod half. Every one of
  // the five branches is declared with `z.strictObject`, not `z.object` —
  // asserted both structurally (the declaration in the source file) and
  // behaviourally (an unknown key on each branch is live-rejected here,
  // using the real, imported schemas — no DB needed for this half). The
  // per-case unknown-key rejection matrix already lives in
  // tests/validation/pricing-component.schema.test.ts (pm47) — this does not
  // repeat that file's fixtures, it re-derives one minimal case per branch
  // independently so this guardrail does not silently pass if that file's
  // suite is ever deleted or its cases narrowed.
  it("guardrail 32 — every envelope branch is a strictObject and rejects an unknown key (Inv. #31)", () => {
    const schemaSource = fs.readFileSync(
      path.join(
        REPO_ROOT,
        "validation",
        "product",
        "pricing-component.schema.ts",
      ),
      "utf8",
    );
    for (const branch of [
      "usageRateComponentSchema",
      "flatFeeComponentSchema",
      "capacityCommitmentComponentSchema",
      "capacityMotivationComponentSchema",
      "negotiatedOverrideComponentSchema",
    ]) {
      const decl = schemaSource.match(
        new RegExp(
          `export const ${branch} = z\\s*\\n?\\s*\\.strictObject\\(|export const ${branch} = z\\.strictObject\\(`,
        ),
      );
      expect(
        decl,
        `${branch} must be declared with z.strictObject`,
      ).not.toBeNull();
    }

    const minimalValid = {
      usage_rate: usageRateComponentSchema,
      flat_fee: flatFeeComponentSchema,
      capacity_commitment: capacityCommitmentComponentSchema,
      capacity_motivation: capacityMotivationComponentSchema,
      negotiated_override: negotiatedOverrideComponentSchema,
    };
    const VALID_VALUES: Record<string, Record<string, unknown>> = {
      usage_rate: {
        "@type": "usage_rate",
        specVersion: 1,
        plaSpecId: null,
        priceType: "usage",
        appliesAt: "rating",
        basis: "quantity",
        boundTo: { unitOfMeasure: "EA" },
        params: { ratePerUnit: "1", rateCardLookUp: null },
      },
      flat_fee: {
        "@type": "flat_fee",
        specVersion: 1,
        plaSpecId: null,
        priceType: "oneTime",
        appliesAt: "billing",
        basis: "flat",
        boundTo: null,
        params: { amount: "1" },
      },
      capacity_commitment: {
        "@type": "capacity_commitment",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_COMMITMENT",
        priceType: "commitment",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: "EA" },
        params: { committedQuantity: 1 },
      },
      capacity_motivation: {
        "@type": "capacity_motivation",
        specVersion: 1,
        plaSpecId: "PLA_CAPACITY_MOTIVATION",
        priceType: "discount",
        appliesAt: "post_aggregation",
        basis: "quantity",
        boundTo: { unitOfMeasure: "EA" },
        params: { steps: [{ aboveQuantity: 1, ratePerUnit: "1" }] },
      },
      negotiated_override: {
        "@type": "negotiated_override",
        specVersion: 1,
        plaSpecId: null,
        priceType: "discount",
        appliesAt: "rating",
        basis: "quantity",
        boundTo: { priceType: "usage", unitOfMeasure: "EA" },
        params: { ratePerUnit: "1" },
      },
    };

    for (const [type, schema] of Object.entries(minimalValid)) {
      const value = VALID_VALUES[type]!;
      expect(
        schema.safeParse(value).success,
        `${type} baseline must parse`,
      ).toBe(true);
      expect(
        schema.safeParse({ ...value, unexpectedField: "x" }).success,
        `${type} must reject an unknown top-level key`,
      ).toBe(false);
    }

    // The DB layer cannot independently prove "an unknown key is rejected" —
    // Postgres JSONB has no schema, so a per-component_type CHECK can only
    // assert the presence/type of the fields it names; it is structurally
    // unable to refuse the presence of an *extra* one. What the DB CHECK
    // does prove independently of Zod — a wrong-typed or missing required
    // field on a raw SQL write, bypassing Zod entirely, for all four
    // persistable branches — is already the 28-case matrix in
    // tests/db/product-price-component-constraints.integration.test.ts
    // (pm46 I4), re-run live by this ship gate (see the evidence table) and
    // referenced here rather than duplicated (pm45 D1). This is a necessary
    // narrowing of D1's literal "the DB CHECK refuses the same malformed
    // object" for the unknown-key case specifically — flagged, not silent.
  });

  // Guardrail 33 — "Cross-component validity" (VI3/VI4/VI5). Structural: all
  // three price-write services call `validateOfferingComponents` after their
  // DRAFT gate, so a refusal is always proven at the action/service
  // boundary, never the validator in isolation (pm56-spec I1.3). The three
  // typed codes reaching a caller live-DB, through insert/update/delete, are
  // already proven in tests/db/product-price-components.integration.test.ts
  // (pm49) — referenced, not re-implemented, and re-run by this ship gate.
  it("guardrail 33 — all three price-write services import + call validateOfferingComponents exactly once, and no VI3-VI5 copy exists elsewhere (structural; the after-DRAFT-gate ordering and typed codes are proven live in product-price-components.integration.test.ts)", () => {
    for (const file of [
      "insert-price.ts",
      "update-price.ts",
      "delete-price.ts",
    ]) {
      const source = fs.readFileSync(
        path.join(REPO_ROOT, "services", "product", file),
        "utf8",
      );
      expect(source, `${file} must import validateOfferingComponents`).toMatch(
        /import\s*\{[^}]*validateOfferingComponents[^}]*\}\s*from/,
      );
      expect(
        (source.match(/validateOfferingComponents\(/g) ?? []).length,
        `${file} must call validateOfferingComponents exactly once`,
      ).toBe(1);
    }

    // The validator itself takes `tx` first (code-standards §2.14) — a
    // second textual copy of VI3-VI5's logic anywhere else is drift
    // (§2.16); confirm the one exported function lives in exactly one file.
    const validatorFile = path.join(
      REPO_ROOT,
      "services",
      "product",
      "validate-offering-components.ts",
    );
    expect(fs.existsSync(validatorFile)).toBe(true);
    const validatorSource = fs.readFileSync(validatorFile, "utf8");
    expect(validatorSource).toMatch(
      /export\s+(?:async\s+function|const)\s+validateOfferingComponents\s*[=(]/,
    );
    // `tx` is the first parameter (code-standards §2.14) — anchored to the
    // declaration and tolerant of the signature's formatting (multi-line or
    // single-line, `function` or arrow/async), so a purely cosmetic reformat
    // of a still-correct signature does not falsely fail this gate.
    expect(
      validatorSource.match(
        /validateOfferingComponents\s*(?:=\s*(?:async\s*)?)?\(\s*tx\s*[:,)]/,
      ),
      "validateOfferingComponents must take tx as its first parameter (§2.14)",
    ).not.toBeNull();

    const otherServiceFiles = collectFiles(
      path.join(REPO_ROOT, "services", "product"),
    ).filter((f) => path.basename(f) !== "validate-offering-components.ts");
    const declaresOwnCopy = otherServiceFiles.filter((f) =>
      /MODIFIER_WITHOUT_BASE_RATE['"]?\s*:/.test(fs.readFileSync(f, "utf8")),
    );
    expect(declaresOwnCopy.map((f) => path.relative(REPO_ROOT, f))).toEqual([]);
  });

  // Guardrail 34 — "The override is untouched" (Inv. #39). The physical
  // shape assertion (insert-only export surface: no update*/delete*) already
  // lives in tests/db/ordering-repository-exports.test.ts (pm26, DB-free,
  // referenced not duplicated). This guardrail adds the column-shape half —
  // one row per (order_item, price_type), scalar amount + currency, via the
  // schema source of record — and the persistablePricingComponentSchema
  // type-level exclusion of negotiated_override.
  it("guardrail 34 — order_item_price_override keeps its frozen shape (Inv. #16/#39)", () => {
    const schemaSource = fs.readFileSync(
      path.join(REPO_ROOT, "db", "schema", "ordering.ts"),
      "utf8",
    );
    const tableMatch = schemaSource.match(
      /orderItemPriceOverride = ordering\.table\(\s*"order_item_price_override",\s*\{([\s\S]*?)\n {2}\},/,
    );
    expect(tableMatch).not.toBeNull();
    const columnNames = [
      ...(tableMatch?.[1] ?? "").matchAll(/^\s{4}(\w+):/gm),
    ].map((m) => m[1]);
    // Exactly the scalar shape — no `params`, no `componentType`, no
    // `priceComponent` JSONB ever added here (Inv. #16/#39 — the override is
    // never reshaped into the envelope, PC9).
    expect(columnNames).toEqual(
      expect.arrayContaining(["amount", "currency", "priceType"]),
    );
    expect(columnNames).not.toContain("componentType");
    expect(columnNames).not.toContain("priceComponent");
    expect(columnNames).not.toContain("params");
    expect(schemaSource).toContain(
      "order_item_price_override_item_type_unique",
    );

    // negotiated_override is a branch of PricingComponent (the TMF
    // projection) but is excluded from persistablePricingComponentSchema —
    // proven behaviourally here (a valid negotiated_override envelope is
    // rejected by the persistable union), not merely by the schema existing
    // (pm47-spec D3).
    expect(negotiatedOverrideComponentSchema).toBeDefined();
    const validNegotiatedOverride = {
      "@type": "negotiated_override",
      specVersion: 1,
      plaSpecId: null,
      priceType: "discount",
      appliesAt: "rating",
      basis: "quantity",
      boundTo: { priceType: "usage", unitOfMeasure: "EA" },
      params: { ratePerUnit: "1" },
    };
    expect(
      negotiatedOverrideComponentSchema.safeParse(validNegotiatedOverride)
        .success,
    ).toBe(true);
    expect(
      persistablePricingComponentSchema.safeParse(validNegotiatedOverride)
        .success,
    ).toBe(false);
  });
});
