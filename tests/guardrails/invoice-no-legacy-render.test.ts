import { readdirSync, readFileSync, statSync } from "node:fs";
import { relative, resolve } from "node:path";

import { describe, expect, it } from "vitest";

import { stripComments } from "@/tests/helpers/strip-code-comments";

// Guardrail 44 (code-standards Part 2 §9 item 44, Inv #40 / R8) — grep gate:
// the invoice render path has no legacy fallback.
//
//   1. `buildDraftInvoiceHtml` / `buildFinalInvoiceHtml` (the deleted legacy
//      HTML builders) have no definition or caller in application code.
//   2. `ratedLinesRepository.listClaimedForAccount` has no caller in the render
//      path (`services/billing/render-invoice*.ts`, `invoice-template/**`).
//   3. bm53-spec §Design D5 extension — nothing under
//      `services/billing/invoice-template/**` reads the filesystem (no
//      `node:fs`/`fs` import, no `readFile`), and the bm47 stopgap loader
//      (`load-stopgap`) is gone: every template byte comes from the blob store,
//      checksum-verified (Inv #45).
//
// Comments are stripped before matching so a history note never trips it.

const ROOT = process.cwd();

function walk(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir)) {
    const abs = resolve(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, out);
    else if (/\.(ts|tsx)$/.test(entry) && !/\.test\.tsx?$/.test(entry))
      out.push(abs);
  }
  return out;
}

function code(file: string): string {
  return stripComments(readFileSync(file, "utf8"));
}

const APP_DIRS = ["services", "actions", "app", "components", "db", "lib"];

const TEMPLATE_DIR = resolve(ROOT, "services/billing/invoice-template");

function renderPathFiles(): string[] {
  const billingDir = resolve(ROOT, "services/billing");
  return [
    ...walk(TEMPLATE_DIR),
    ...readdirSync(billingDir)
      .filter((f) => /^render-invoice.*\.ts$/.test(f))
      .map((f) => resolve(billingDir, f)),
  ];
}

describe("guardrail 44 — no legacy invoice render fallback", () => {
  it("the legacy HTML builders are not defined or called anywhere in application code", () => {
    const offenders = APP_DIRS.flatMap((d) => walk(resolve(ROOT, d)))
      .filter((f) => /\bbuild(Draft|Final)InvoiceHtml\b/.test(code(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the render path never calls listClaimedForAccount", () => {
    const offenders = renderPathFiles()
      .filter((f) => /\blistClaimedForAccount\b/.test(code(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("nothing under services/billing/invoice-template/** reads the filesystem (bm53)", () => {
    const offenders = walk(TEMPLATE_DIR)
      .filter((f) => {
        const src = code(f);
        return (
          /from\s+["'](node:)?fs(\/promises)?["']/.test(src) ||
          /require\(\s*["'](node:)?fs/.test(src) ||
          /\breadFile(Sync)?\b/.test(src)
        );
      })
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("the bm47 stopgap loader is deleted and has no importer (bm53)", () => {
    expect(() => statSync(resolve(TEMPLATE_DIR, "load-stopgap.ts"))).toThrow();
    const offenders = APP_DIRS.flatMap((d) => walk(resolve(ROOT, d)))
      .filter((f) => /load-stopgap|loadDefaultTemplateFromRepo/.test(code(f)))
      .map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });
});
