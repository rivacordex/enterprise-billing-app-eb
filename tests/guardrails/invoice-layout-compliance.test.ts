import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPLIANCE_SECTION_KEYS,
  lintLayoutTemplates,
  PROBE_RENDER_INPUT,
  requiredProbeValues,
  staticComplianceProblems,
} from "@/services/billing/invoice-template/compliance";
import {
  compileInvoiceTemplate,
  executeInvoiceTemplate,
} from "@/services/billing/invoice-template/compile";
import { layoutFilesFromVerified } from "@/services/billing/invoice-template/generate";
import { buildIndex } from "@/scripts/invoice-templates/write-checksums";
import { layoutManifestSchema } from "@/validation/billing/layout-manifest.schema";

// bm76-spec §6 / code-standards guardrail item 72, STATIC tier (Inv #63) —
// DB-free and Chromium-free, so it runs in plain CI. Every seeded layout
// package passes the package lint and the static compliance check (generate
// with Payment on and off → strict compile → execute against the probe → each
// required value in its section's HTML). The INVTPL-BASIC-A4 reference never
// drifts from its checksums. Each negative fixture, built in memory from
// Standard's files, fails with its code and names its section. The visible
// tier is compliance-visible.e2e.test.ts (RUN_CHROMIUM_E2E=1).

const REPO_ROOT = process.cwd();
const SEED_ROOT = path.join(REPO_ROOT, "db/seeds/invoice-templates");
const STANDARD_DIR = "INVTPL-STD-A4/v1";

function packageDirs(): string[] {
  return readdirSync(SEED_ROOT)
    .filter((name) => name.startsWith("INVTPL-"))
    .flatMap((name) =>
      readdirSync(path.join(SEED_ROOT, name))
        .filter((v) => v.startsWith("v"))
        .map((v) => `${name}/${v}`),
    )
    .filter((dir) => statSync(path.join(SEED_ROOT, dir)).isDirectory())
    .sort();
}

// Every file of a package as text, keyed by its package-relative path. Fonts
// (binary) are skipped: no rule reads them.
function packageText(dir: string): Record<string, string> {
  const root = path.join(SEED_ROOT, dir);
  const out: Record<string, string> = {};
  const walk = (abs: string): void => {
    for (const entry of readdirSync(abs)) {
      const child = path.join(abs, entry);
      if (statSync(child).isDirectory()) {
        walk(child);
      } else if (!entry.endsWith(".woff2")) {
        const rel = path.relative(root, child).split(path.sep).join("/");
        out[rel] = readFileSync(child, "utf8");
      }
    }
  };
  walk(root);
  return out;
}

function layoutOf(files: Readonly<Record<string, string>>) {
  return layoutFilesFromVerified(
    new Map(Object.entries(files).map(([k, v]) => [k, Buffer.from(v)])),
  );
}

// Standard's files with one file's text replaced (a literal, single swap).
function standardWith(
  file: string,
  from: string,
  to: string,
): Record<string, string> {
  const files = packageText(STANDARD_DIR);
  const source = files[file]!;
  expect(source).toContain(from);
  return { ...files, [file]: source.replace(from, to) };
}

describe("guardrail 72 (static tier) — layout compliance, plain CI", () => {
  it("discovers exactly the two seeded layout packages", () => {
    expect(packageDirs()).toEqual(["INVTPL-BASIC-A4/v1", "INVTPL-STD-A4/v1"]);
  });

  describe.each(packageDirs().map((d) => [d]))("%s", (dir) => {
    const files = packageText(dir);

    it("passes the package lint", () => {
      expect(lintLayoutTemplates(files)).toEqual([]);
    });

    it("parses with layoutManifestSchema", () => {
      expect(() =>
        layoutManifestSchema.parse(JSON.parse(files["manifest.json"]!)),
      ).not.toThrow();
    });

    it("is statically compliant", () => {
      expect(staticComplianceProblems(layoutOf(files)).problems).toEqual([]);
    });
  });

  it("INVTPL-BASIC-A4/v1's checksums.json matches its files", () => {
    const dir = path.join(SEED_ROOT, "INVTPL-BASIC-A4/v1");
    expect(readFileSync(path.join(dir, "checksums.json"))).toEqual(
      buildIndex(dir).bytes,
    );
  });

  it.each([
    [
      "the TIN removed from header",
      standardWith(
        "partials/header.hbs",
        '<div class="mono">TIN {{company.tin}}</div>',
        "",
      ),
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
      "header",
    ],
    [
      "the invoice number commented out",
      standardWith(
        "partials/identification.hbs",
        "{{#if invoice.number}}{{invoice.number}}",
        "{{#if invoice.number}}<!-- {{invoice.number}} -->",
      ),
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
      "identification",
    ],
    [
      "the taxSummary section deleted",
      {
        ...packageText(STANDARD_DIR),
        "partials/taxSummary.hbs": "",
      },
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
      "taxSummary",
    ],
    [
      "amountDue printing the subtotal instead",
      standardWith(
        "partials/amountDue.hbs",
        "{{money totals.amountDue}}",
        "{{totals.subtotalExclTax}}",
      ),
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
      "amountDue",
    ],
    [
      "a {{customer.nmae}} typo",
      standardWith(
        "partials/billTo.hbs",
        "<div>{{customer.name}}</div>",
        "<div>{{customer.nmae}}</div>",
      ),
      "COMPILE_FAILED",
      "nmae",
    ],
  ])("%s fails", (_name, files, code, names) => {
    const { problems } = staticComplianceProblems(layoutOf(files));
    expect(problems).toContainEqual(
      expect.objectContaining({
        code,
        message: expect.stringContaining(names),
      }),
    );
  });

  it("requiredProbeValues() carries the amount due exactly as {{money totals.amountDue}} renders it", () => {
    const rendered = executeInvoiceTemplate(
      compileInvoiceTemplate("{{money totals.amountDue}}"),
      PROBE_RENDER_INPUT,
    ).trim();
    expect(requiredProbeValues()).toContainEqual({
      section: "amountDue",
      label: "the amount due",
      text: rendered,
    });
  });

  it("covers the seven compliance sections; only payment is optional", () => {
    expect([...COMPLIANCE_SECTION_KEYS]).toEqual([
      "header",
      "identification",
      "billTo",
      "chargeSummary",
      "taxSummary",
      "amountDue",
      "chargeDetails",
    ]);
  });

  it("compliance.ts imports no I/O module (the editor snapshots it verbatim)", () => {
    const source = readFileSync(
      path.join(REPO_ROOT, "services/billing/invoice-template/compliance.ts"),
      "utf8",
    );
    const specifiers = [...source.matchAll(/from\s+"([^"]+)"/g)].map(
      (m) => m[1]!,
    );
    expect(specifiers.length).toBeGreaterThan(0);
    for (const spec of specifiers) {
      expect(spec).not.toMatch(
        /(?:^|\/)load$|blob-store|render-invoice|^(?:node:)?fs(?:\/|$)|^@\/db(?:\/|$)/,
      );
    }
  });
});
