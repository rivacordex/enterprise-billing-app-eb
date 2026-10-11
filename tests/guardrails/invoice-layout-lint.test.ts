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

const BANNED_TEXT: readonly [RegExp, string][] = [
  [/<img\s[^>]*src\s*=\s*["']?https?:/i, "<img src=http"],
  [/url\(\s*["']?https?:/i, "url(http"],
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
      const path = n.path as { original?: string; type: string };
      const params = (n.params as unknown[]) ?? [];
      const isCall =
        n.type === "BlockStatement" || params.length > 0 || Boolean(n.hash);
      if (isCall && path.type === "PathExpression") {
        const name = path.original ?? "";
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
function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/\{\{!--[\s\S]*?--\}\}/g, "")
    .replace(/\{\{![\s\S]*?\}\}/g, "");
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
    expect(files.length).toBeGreaterThanOrEqual(14);
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
        "<img src=http",
        "url(http",
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
