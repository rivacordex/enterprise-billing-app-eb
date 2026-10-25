import { readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import { zipSync } from "fflate";

import { buildChecksumIndex } from "@/services/billing/invoice-template/checksum-index";
import type {
  ComplianceSectionKey,
  VisibleSectionReport,
} from "@/services/billing/invoice-template/compliance";
import type { renderAndReadSections } from "@/services/billing/invoice-template/compliance-render";

// bm78-spec §13 — layout package fixtures, built IN MEMORY (never on disk) from
// the committed reference package `db/seeds/invoice-templates/INVTPL-BASIC-A4/v1/`:
//   1. read every file of the reference package;
//   2. rewrite `manifest.json` with the given `layoutCode` / `layoutVersion`;
//   3. `edit` (optional) changes the file set BEFORE the index is built, so the
//      package stays checksum-consistent (a lint fixture, a removed file …);
//   4. regenerate `checksums.json` with `buildChecksumIndex` over every other file;
//   5. `override` (optional) changes the file set AFTER the index is built, so it
//      can corrupt a checksum, add an unlisted entry or drop a listed one;
//   6. zip with `fflate.zipSync`.

export const BASIC_PACKAGE_DIR = path.join(
  process.cwd(),
  "db/seeds/invoice-templates/INVTPL-BASIC-A4/v1",
);

export const INDEX_FILE = "checksums.json";

export type PackageFiles = Map<string, Buffer>;

export interface LayoutPackageOptions {
  layoutCode?: string;
  layoutVersion?: number;
  // A manifest edit applied to the parsed JSON (before the index).
  manifest?: (manifest: Record<string, unknown>) => void;
  edit?: (files: PackageFiles) => void;
  override?: (files: PackageFiles) => void;
}

export interface LayoutPackage {
  zip: Uint8Array;
  files: PackageFiles; // exactly the entries zipped
  indexBytes: Buffer | undefined; // the zipped checksums.json
}

function walk(dir: string, base = dir, out: string[] = []): string[] {
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) walk(abs, base, out);
    else out.push(path.relative(base, abs).split(path.sep).join("/"));
  }
  return out;
}

// The reference package's files, keyed by package path (`partials/header.hbs`).
export function readBasicPackageFiles(): PackageFiles {
  return new Map(
    walk(BASIC_PACKAGE_DIR).map((name) => [
      name,
      readFileSync(path.join(BASIC_PACKAGE_DIR, name)),
    ]),
  );
}

// Replace `from` with `to` in a text file; throws if `from` is absent, so a
// fixture never silently stops testing what it claims to.
export function replaceInFile(
  files: PackageFiles,
  name: string,
  from: string | RegExp,
  to: string,
): void {
  const text = files.get(name)?.toString("utf-8");
  if (text === undefined) throw new Error(`fixture: no ${name}`);
  const next = text.replace(from, to);
  if (next === text) throw new Error(`fixture: ${String(from)} not in ${name}`);
  files.set(name, Buffer.from(next, "utf-8"));
}

export function zipFiles(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  return zipSync(Object.fromEntries(files));
}

export function buildLayoutPackage(
  opts: LayoutPackageOptions = {},
): LayoutPackage {
  const files = readBasicPackageFiles();
  files.delete(INDEX_FILE);

  const manifest = JSON.parse(
    files.get("manifest.json")!.toString("utf-8"),
  ) as Record<string, unknown>;
  manifest.layoutCode = opts.layoutCode ?? "INVTPL-BASIC-A4";
  manifest.layoutVersion = opts.layoutVersion ?? 1;
  opts.manifest?.(manifest);
  files.set(
    "manifest.json",
    Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`, "utf-8"),
  );

  opts.edit?.(files);
  files.set(INDEX_FILE, buildChecksumIndex(files));
  opts.override?.(files);

  return { zip: zipFiles(files), files, indexBytes: files.get(INDEX_FILE) };
}

// bm78/bm79 — a Chromium-free stand-in for `renderAndReadSections` (the
// `deps.render` of upload and activation): every probed section present and
// legible, with the given blocked URLs. The e2e suites prove the real one.
export function cleanRender(
  blockedUrls: string[] = [],
): typeof renderAndReadSections {
  return async (_html, probes) => ({
    report: Object.fromEntries(
      probes.map((p) => [
        p.key,
        {
          present: true,
          count: 1,
          text: p.values.length > 0 ? p.values.join(" ") : `${p.key} text`,
          illegible: [],
        },
      ]),
    ) as unknown as Record<ComplianceSectionKey, VisibleSectionReport>,
    blockedUrls,
  });
}
