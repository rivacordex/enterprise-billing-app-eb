import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

// bm50-spec §Design D3 — generate the canonical `checksums.json` index for an
// invoice-template version directory and print the SHA-256 of that index (the
// digest the migration's `bill_template_version.checksum` column stores).
//
//   node --import tsx scripts/invoice-templates/write-checksums.ts <dir>
//
// The index lists every file under <dir> (recursively, POSIX-separated relative
// paths) EXCEPT `checksums.json` itself, each mapped to the SHA-256 hex of its
// raw bytes, with keys sorted. Canonical serialization: `JSON.stringify(_, 2)`
// (two-space indent, LF) + a trailing newline. `load()` (bm53) re-derives this
// to verify the version on every render (Inv #45), and a bm50 test recomputes
// the digests to prove the migration literals never drift from the repo files.

const INDEX_FILE = "checksums.json";

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort()) {
    const abs = path.join(dir, entry);
    if (statSync(abs).isDirectory()) {
      walk(abs, base, out);
    } else {
      const rel = path.relative(base, abs).split(path.sep).join("/");
      if (rel !== INDEX_FILE) out.push(rel);
    }
  }
}

// Exported so tests/db/invoice-template-seed-checksums.test.ts recomputes the
// exact same digest the migration literals must equal (no drift).
export function buildIndex(dir: string): { bytes: Buffer; digest: string } {
  const files: string[] = [];
  walk(dir, dir, files);
  files.sort();

  const index: { algorithm: string; files: Record<string, string> } = {
    algorithm: "sha256",
    files: {},
  };
  for (const rel of files) {
    index.files[rel] = sha256Hex(readFileSync(path.join(dir, rel)));
  }

  const bytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`, "utf-8");
  return { bytes, digest: sha256Hex(bytes) };
}

function main(): void {
  const dirArg = process.argv[2];
  if (!dirArg) {
    throw new Error("usage: write-checksums.ts <version-dir>");
  }
  const dir = path.resolve(process.cwd(), dirArg);
  const { bytes, digest } = buildIndex(dir);
  writeFileSync(path.join(dir, INDEX_FILE), bytes);
  // eslint-disable-next-line no-console
  console.log(`${digest}  ${dirArg}`);
}

const isMain =
  process.argv[1] !== undefined &&
  import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  main();
}
