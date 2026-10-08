import { createHash } from "node:crypto";
import {
  readdirSync,
  readFileSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

// The invoice-template seed tree — the only directory this script may touch
// (path-traversal containment for the CLI arg; see main()).
const SEED_ROOT = path.resolve(process.cwd(), "db/seeds/invoice-templates");

// Locale-INDEPENDENT code-point order — deliberately NOT `localeCompare`: the
// index bytes must be byte-reproducible across machines and locales so the
// committed SHA-256 digest is stable, whereas `localeCompare` is
// locale-dependent (it would change the digest and make it non-reproducible).
const byCodePoint = (a: string, b: string): number =>
  a < b ? -1 : a > b ? 1 : 0;

function sha256Hex(bytes: Buffer): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function walk(dir: string, base: string, out: string[]): void {
  for (const entry of readdirSync(dir).sort(byCodePoint)) {
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
  files.sort(byCodePoint);

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
  // Path-traversal containment: the CLI argument is untrusted input. Canonicalize
  // BOTH the seed root and the requested dir with realpathSync (resolving any
  // symlinks) before the containment check, and use the canonical dir for the
  // subsequent reads/writes — so a symlinked argument cannot redirect the write
  // outside the seed tree. realpathSync throws if the dir does not exist, which
  // is the correct fail-loud for a non-existent version directory.
  const root = realpathSync(SEED_ROOT);
  const dir = realpathSync(path.resolve(process.cwd(), dirArg));
  if (dir !== root && !dir.startsWith(root + path.sep)) {
    throw new Error(
      `write-checksums: refusing a path outside ${root}: ${dirArg}`,
    );
  }
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
