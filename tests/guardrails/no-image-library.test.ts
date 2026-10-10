import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// bm60-spec §Tests — no image library. Logo dimensions come from the pure
// PNG/JPEG/SVG parsers (`image-dimensions.ts`); `sharp` is only an optional
// transitive of `next`, and adding any image dependency is a stop-and-ask
// (workflow rules §6.13). Static-source scan of the app code roots.
const REPO_ROOT = path.resolve(__dirname, "../..");
const ROOTS = ["services", "actions", "app", "lib", "components"];
const LIBRARIES = [
  "sharp",
  "jimp",
  "image-size",
  "probe-image-size",
  "canvas",
  "@napi-rs/canvas",
  "gm",
  "imagemagick",
  "pngjs",
  "jpeg-js",
  "svgo",
  "dompurify",
  "isomorphic-dompurify",
];
const IMPORT_RE =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']([^"']+)["']/g;

function walk(dir: string, out: string[] = []): string[] {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const abs = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(abs, out);
    else if (/\.(?:ts|tsx|js|mjs|cjs)$/.test(entry.name)) out.push(abs);
  }
  return out;
}

describe("no image library (bm60, workflow rules §6.13)", () => {
  it("no app code imports sharp, jimp, image-size or similar", () => {
    const offending: string[] = [];
    for (const root of ROOTS) {
      for (const file of walk(path.join(REPO_ROOT, root))) {
        const src = fs.readFileSync(file, "utf8");
        for (const m of src.matchAll(IMPORT_RE)) {
          const spec = m[1]!;
          if (
            LIBRARIES.some((lib) => spec === lib || spec.startsWith(`${lib}/`))
          ) {
            offending.push(`${path.relative(REPO_ROOT, file)}: ${spec}`);
          }
        }
      }
    }
    expect(offending).toEqual([]);
    // A repo-wide read; generous budget for a loaded CI machine.
  }, 60_000);

  it("package.json declares none of them", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, "package.json"), "utf8"),
    ) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const declared = Object.keys({
      ...pkg.dependencies,
      ...pkg.devDependencies,
    });
    expect(declared.filter((d) => LIBRARIES.includes(d))).toEqual([]);
  });

  it("the scan sees the parsers it protects", () => {
    expect(
      fs.existsSync(
        path.join(
          REPO_ROOT,
          "services/billing/invoice-profile/image-dimensions.ts",
        ),
      ),
    ).toBe(true);
  });
});
