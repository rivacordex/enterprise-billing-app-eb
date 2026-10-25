import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

import {
  COMPLIANCE_PROBE,
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
      COMPLIANCE_PROBE,
    ).trim();
    expect(requiredProbeValues()).toContainEqual({
      section: "amountDue",
      label: "the amount due",
      text: rendered,
    });
  });

  // Code review fixes (2026-10-25).
  it("COMPLIANCE_PROBE's amount due differs from every other money total; PROBE_RENDER_INPUT is unchanged", () => {
    const { amountDue, ...others } = COMPLIANCE_PROBE.totals;
    expect(Object.values(others)).not.toContain(amountDue);
    expect(COMPLIANCE_PROBE.company).toEqual(PROBE_RENDER_INPUT.company);
    expect(PROBE_RENDER_INPUT.totals.amountDue).toBe("3.00");
  });

  it.each([
    ["the subtotal", "{{money totals.subtotalExclTax}}"],
    ["the gross total", "{{money totals.grossTotal}}"],
    ["the total charges", "{{money totals.totalCharges}}"],
  ])("amountDue printing %s (money-formatted) fails", (_name, swap) => {
    const files = standardWith(
      "partials/amountDue.hbs",
      "{{money totals.amountDue}}",
      swap,
    );
    expect(staticComplianceProblems(layoutOf(files)).problems).toContainEqual(
      expect.objectContaining({
        code: "LAYOUT_MISSING_REQUIRED_BLOCKS",
        message: expect.stringContaining("section amountDue"),
      }),
    );
  });

  it("a footer that fails to execute is COMPILE_FAILED (the footer is probed like load.ts does)", () => {
    const files = standardWith(
      "footer.hbs",
      "{{customer.billingAccountId}}",
      "{{customer.billingAcountId}}",
    );
    expect(staticComplianceProblems(layoutOf(files)).problems).toContainEqual(
      expect.objectContaining({
        code: "COMPILE_FAILED",
        message: expect.stringContaining("footer"),
      }),
    );
  });

  it("a nested <section> inside a compliance section does not cut its text short", () => {
    const files = standardWith(
      "partials/header.hbs",
      "<h1>Invoice</h1>",
      '<section class="brand"><h1>Invoice</h1></section>',
    );
    expect(staticComplianceProblems(layoutOf(files)).problems).toEqual([]);
  });

  it("a compliance section printed twice fails", () => {
    const files = standardWith(
      "partials/taxSummary.hbs",
      "</section>",
      '</section><section class="sec sec--taxSummary sec--full"><p>again</p></section>',
    );
    expect(staticComplianceProblems(layoutOf(files)).problems).toContainEqual(
      expect.objectContaining({
        code: "LAYOUT_MISSING_REQUIRED_BLOCKS",
        message: expect.stringContaining("section taxSummary appears 2 times"),
      }),
    );
  });

  it("hands both probe renders (Payment on, off) to the visible tier", () => {
    const result = staticComplianceProblems(
      layoutOf(packageText(STANDARD_DIR)),
    );
    expect(result.renders).toHaveLength(2);
    expect(result.renders[0]).toBe(result.html);
    expect(result.renders[0]).toContain("sec--payment");
    expect(result.renders[1]).not.toContain("sec--payment");
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
