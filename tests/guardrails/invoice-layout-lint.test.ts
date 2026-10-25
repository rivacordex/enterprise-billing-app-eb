import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import { describe, expect, it } from "vitest";

import {
  hardeningHits,
  lintInvoiceTemplate,
  lintLayoutTemplates,
  typedSupplierHits,
} from "@/services/billing/invoice-template/compliance";
import { KNOWN_HELPERS } from "@/services/billing/invoice-template/helpers";

// bm47-spec §Tests (code-standards Part 2 Styling rule 3, guardrail 50's lint
// half) — delivered by the bm63 sweep. Every `.hbs` seeded under
// `db/seeds/invoice-templates/**` has no external fetch (`<img src="http`,
// `url(http`, `<link`, `@import`), no `<script`, no triple-stash `{{{`, no
// partial `{{>`, and calls only the nine registered helpers (plus Handlebars'
// block built-ins). A bad fixture proves the lint fails. bm76 (Inv #63,
// guardrail 73): the rules live in `compliance.ts`; this file only calls them
// and declares no pattern of its own. It also proves the hardening and the
// typed-supplier rules.
const REPO_ROOT = join(__dirname, "../..");
const SEED_DIR = join(REPO_ROOT, "db/seeds/invoice-templates");
const BAD_FIXTURE = join(
  REPO_ROOT,
  "tests/fixtures/invoice-layout-bad/bad.hbs",
);

function hbsFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return hbsFiles(path);
    return entry.name.endsWith(".hbs") ? [path] : [];
  });
}

describe("invoice layout lint (Styling rule 3)", () => {
  const files = hbsFiles(SEED_DIR);

  it("finds the seeded layout and generated templates", () => {
    // Layout v1: shell + footer + 8 partials; generated v1: invoice + footer.
    // bm71 deleted partials/usageAnnex.hbs (14 → 13); bm72 notes.hbs (→ 12).
    // bm76 adds the INVTPL-BASIC-A4 v1 reference package (+10 → 22).
    expect(files.length).toBeGreaterThanOrEqual(22);
  });

  it.each(files.map((f) => [relative(REPO_ROOT, f).split("\\").join("/"), f]))(
    "%s passes the lint",
    (_name, file) => {
      expect(lintInvoiceTemplate(readFileSync(file, "utf8"))).toEqual([]);
    },
  );

  it("fails the seeded bad fixture on every banned construct", () => {
    const hits = lintInvoiceTemplate(readFileSync(BAD_FIXTURE, "utf8"));
    expect(hits).toEqual(
      expect.arrayContaining([
        "external url attribute",
        "url(http",
        "<iframe|object|embed|base",
        "<script",
        "{{{",
        "<link",
        "@import",
        "{{>",
        "partial",
        "unescaped",
        "helper:lookup",
      ]),
    );
  });

  // Each of these fetched an external URL (or ran a script) in a real
  // Chromium `setContent` probe during the bm62/bm63 review; each must fail.
  it.each([
    ['<img srcset="https://x.example/a.png 1x">'],
    ["<img/src=https://x.example/a.png>"],
    ['<img src="//x.example/a.png">'],
    ['<iframe src="about:blank"></iframe>'],
    ['<object data="https://x.example/o"></object>'],
    ['<embed src="https://x.example/e">'],
    [
      '<video poster="https://x.example/p.png"><source src="https://x.example/v.mp4"></video>',
    ],
    ['<svg><image href="https://x.example/i.png"/></svg>'],
    ['<base href="https://x.example/"><img src="a.png">'],
    ['<div style="background: url(//x.example/b.png)"></div>'],
    ['<div title="/*"></div><script>alert(1)</script><div title="*/"></div>'],
    ['{{"lookup" customer "name"}}'],
    [
      '<div title="<!--"></div><script>alert(1)</script><div title="-->"></div>',
    ],
    [
      '<div title="<style>/*"></div><script>alert(1)</script><div title="*/</style>"></div>',
    ],
  ])("rejects %s", (snippet) => {
    expect(lintInvoiceTemplate(snippet)).not.toEqual([]);
  });

  // A comment opener inside an attribute value is not a comment: the script
  // between the two attributes must stay visible to the `<script` ban.
  it.each([
    [
      '<div title="<!--"></div><script>alert(1)</script><div title="-->"></div>',
    ],
    [
      '<div title="<style>/*"></div><script>alert(1)</script><div title="*/</style>"></div>',
    ],
  ])(
    "keeps the script hidden by an attribute-value comment opener: %s",
    (snippet) => {
      expect(lintInvoiceTemplate(snippet)).toContain("<script");
    },
  );

  it("still strips real HTML comments and CSS comments in a <style> block", () => {
    expect(
      lintInvoiceTemplate(
        "<!-- <script>x</script> --><style>/* @import url(http://x) */ .a{}</style>",
      ),
    ).toEqual([]);
  });

  it("still allows data: URIs, fragment references and template placeholders", () => {
    expect(
      lintInvoiceTemplate(
        '<img src="{{company.logoUrl}}"><img src="data:image/png;base64,AA=="><svg><use href="#a"/></svg>',
      ),
    ).toEqual([]);
  });

  it("allows only the nine registered helpers", () => {
    expect(Object.keys(KNOWN_HELPERS).sort()).toEqual(
      [
        "amt",
        "asset",
        "date",
        "int",
        "money",
        "period",
        "price",
        "qty",
        "unitCode",
      ].sort(),
    );
  });

  // bm76 (guardrail 73) — each hardening case is rejected by compliance.ts: a
  // URL spelled with entities or CSS escapes, image-set(), and event-handler
  // attributes. Asserted through the package lint (lint + hardening +
  // typed-supplier): the editor's `hardeningHits`, ported verbatim, reports
  // only what the plain lint misses, and `&#104;ttps://` still carries a raw
  // `//` the plain lint already refuses.
  it.each([
    ['<img src="&#104;ttps://x.example/a.png">'],
    ['<div style="background:url(\\68ttps://x.example/b.png)">'],
    [
      '<div style="background-image:image-set(url(https://x.example/c.png) 1x)">',
    ],
    ['<div onclick="x()">'],
  ])("compliance.ts rejects %s", (snippet) => {
    expect(lintLayoutTemplates({ "partials/x.hbs": snippet })).not.toEqual([]);
  });

  // The hardening itself, where the plain lint is blind: a URL whose scheme
  // and `//` are both entity-encoded, a CSS-escaped scheme, image-set() and
  // an on…= handler.
  it.each([
    ['<img src="&#104;ttps&#58;&#47;&#47;x.example/a.png">'],
    ['<div style="background:url(\\68ttps://x.example/b.png)">'],
    [
      '<div style="background-image:image-set(url(https://x.example/c.png) 1x)">',
    ],
    ['<div onclick="x()">'],
  ])("hardeningHits rejects %s", (snippet) => {
    expect(hardeningHits(snippet)).not.toEqual([]);
  });

  // bm76 — supplier identity comes from `company.*`, never typed in.
  it.each([
    ["<div>TIN C1234567890</div>"],
    ["<div>W10-1234-12345678</div>"],
    ["<div>Reg. No. 202601000001</div>"],
  ])("the typed-supplier rule rejects %s", (snippet) => {
    expect(typedSupplierHits(snippet)).not.toEqual([]);
  });

  it("the typed-supplier rule passes a {{company.…}} placeholder", () => {
    expect(typedSupplierHits("<div>TIN {{company.tin}}</div>")).toEqual([]);
  });
});
