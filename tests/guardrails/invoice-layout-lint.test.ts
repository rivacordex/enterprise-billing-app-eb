import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";

import Handlebars from "handlebars";
import { describe, expect, it } from "vitest";

import { KNOWN_HELPERS } from "@/services/billing/invoice-template/helpers";

// bm47-spec §Tests (code-standards Part 2 Styling rule 3, guardrail 50's lint
// half) — delivered by the bm63 sweep. Every `.hbs` seeded under
// `db/seeds/invoice-templates/**` has no external fetch (`<img src="http`,
// `url(http`, `<link`, `@import`), no `<script`, no triple-stash `{{{`, no
// partial `{{>`, and calls only the nine registered helpers (plus Handlebars'
// block built-ins). A bad fixture proves the lint fails.
const REPO_ROOT = join(__dirname, "../..");
const SEED_DIR = join(REPO_ROOT, "db/seeds/invoice-templates");
const BAD_FIXTURE = join(
  REPO_ROOT,
  "tests/fixtures/invoice-layout-bad/bad.hbs",
);

// An external fetch is any URL-bearing attribute or CSS `url()` that points
// at `http(s):` or a protocol-relative `//`, in any element (img, source,
// video poster, SVG image, form action …), plus the elements that load or
// re-base content by themselves.
const EXTERNAL_URL = String.raw`\s*["']?\s*(?:https?:|\/\/)`;
const BANNED_TEXT: readonly [RegExp, string][] = [
  [
    new RegExp(
      String.raw`(?:^|[\s/"'])(?:src|srcset|href|xlink:href|data|poster|action|formaction|background)\s*=` +
        String.raw`\s*["']?[^"'>]*?(?:https?:|\/\/)`,
      "i",
    ),
    "external url attribute",
  ],
  [new RegExp(String.raw`url\(` + EXTERNAL_URL, "i"), "url(http"],
  [/<(?:iframe|object|embed|base)[\s/>]/i, "<iframe|object|embed|base"],
  [/<script/i, "<script"],
  [/\{\{\{/, "{{{"],
  [/<link[\s>]/i, "<link"],
  [/@import/i, "@import"],
  [/\{\{~?>/, "{{>"],
];

const BLOCK_BUILT_INS = new Set(["if", "unless", "each", "with"]);
const ALLOWED_HELPERS = new Set([
  ...Object.keys(KNOWN_HELPERS),
  ...BLOCK_BUILT_INS,
]);

type Node = { type: string; [key: string]: unknown };

// Walks the Handlebars AST: a mustache/block/sub-expression with parameters
// or a hash is a helper call, and its name must be registered; any partial
// and any unescaped mustache is a violation.
function astViolations(source: string): string[] {
  const found: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(visit);
      return;
    }
    if (!node || typeof node !== "object") return;
    const n = node as Node;
    if (n.type === "PartialStatement" || n.type === "PartialBlockStatement") {
      found.push("partial");
    }
    if (
      n.type === "MustacheStatement" ||
      n.type === "BlockStatement" ||
      n.type === "SubExpression"
    ) {
      const path = n.path as {
        original?: unknown;
        value?: unknown;
        type: string;
      };
      const params = (n.params as unknown[]) ?? [];
      const isCall =
        n.type === "BlockStatement" || params.length > 0 || Boolean(n.hash);
      // A helper can be named by a path or by a literal (`{{"lookup" x}}`).
      if (isCall) {
        const name = String(path.original ?? path.value ?? "");
        if (!ALLOWED_HELPERS.has(name)) found.push(`helper:${name}`);
      }
      if (n.type === "MustacheStatement" && n.escaped === false) {
        found.push("unescaped");
      }
    }
    for (const [key, value] of Object.entries(n)) {
      if (key !== "loc") visit(value);
    }
  };
  visit(Handlebars.parse(source));
  return found;
}

// Comments (CSS, HTML, Handlebars) are documentation, not markup: the seeded
// shell's CSS comment names `@import` and `<link>` to state the rule itself.
// Handlebars comments go first (Handlebars removes them before any HTML is
// produced). HTML comments and `<style>` blocks are recognised only where
// they begin in text content, never inside a tag's attribute value, so a
// `<!--`/`-->` or `<style>`/`/*` pair split across two attribute values
// cannot hide the markup between them. CSS comments are stripped only inside
// a real `<style>` block.
function stripComments(source: string): string {
  const text = source
    .replace(/\{\{!--[\s\S]*?--\}\}/g, "")
    .replace(/\{\{![\s\S]*?\}\}/g, "");
  let out = "";
  let i = 0;
  let inTag = false;
  let quote: string | null = null;
  while (i < text.length) {
    const ch = text[i]!;
    if (inTag) {
      if (quote) {
        if (ch === quote) quote = null;
      } else if (ch === '"' || ch === "'") {
        quote = ch;
      } else if (ch === ">") {
        inTag = false;
      }
      out += ch;
      i += 1;
    } else if (text.startsWith("<!--", i)) {
      const end = text.indexOf("-->", i + 4);
      i = end === -1 ? text.length : end + 3;
    } else if (/^<style\b[^>]*>/i.test(text.slice(i, i + 200))) {
      const open = /^<style\b[^>]*>/i.exec(text.slice(i))![0];
      const close = text.toLowerCase().indexOf("</style>", i + open.length);
      const cssEnd = close === -1 ? text.length : close;
      out +=
        open +
        text.slice(i + open.length, cssEnd).replace(/\/\*[\s\S]*?\*\//g, "");
      i = cssEnd;
    } else {
      if (ch === "<") inTag = true;
      out += ch;
      i += 1;
    }
  }
  return out;
}

export function lintInvoiceTemplate(source: string): string[] {
  const markup = stripComments(source);
  const textHits = BANNED_TEXT.filter(([re]) => re.test(markup)).map(
    ([, label]) => label,
  );
  return [...textHits, ...astViolations(source)];
}

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
    // Layout v1: shell + footer + 9 partials; generated v1: invoice + footer.
    // bm71 deleted partials/usageAnnex.hbs (14 → 13).
    expect(files.length).toBeGreaterThanOrEqual(13);
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
});
