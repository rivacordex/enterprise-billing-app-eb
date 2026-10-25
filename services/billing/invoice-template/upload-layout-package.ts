import { Unzip, UnzipInflate, unzipSync } from "fflate";

import { db } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { testRender } from "@/services/billing/invoice-template/test-render";
import {
  checksumIndexSchema,
  sha256,
} from "@/services/billing/invoice-template/checksum-index";
import {
  COMPLIANCE_STRUCTURES,
  lintLayoutTemplates,
  staticComplianceProblems,
  visibleComplianceProblems,
} from "@/services/billing/invoice-template/compliance";
import { renderAndReadSections } from "@/services/billing/invoice-template/compliance-render";
import {
  generate,
  layoutFilesFromVerified,
} from "@/services/billing/invoice-template/generate";
import {
  installLayoutPackage,
  matchExpectedDraft,
} from "@/services/billing/invoice-template/install-layout-package";
import { parseSampleData } from "@/services/billing/invoice-template/sample-data";
import {
  LAYOUT_PACKAGE_FONT_FILE,
  LAYOUT_PACKAGE_MAX_ENTRIES,
  LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  LAYOUT_PACKAGE_REQUIRED_FILES,
  type ExpectedDraft,
  type LayoutProblem,
  type LayoutProblemCode,
  type UploadLayoutPackageResult,
} from "@/types/billing";
import {
  layoutManifestSchema,
  type LayoutManifest,
} from "@/validation/billing/layout-manifest.schema";

// bm78-spec §7 (Inv #60, code-standards › Invoice Template Types, General
// rule 2) — the layout package GATE and the upload orchestration. The gate owns
// no writes: only a fully clean package reaches `installLayoutPackage`, the one
// writer (Inv #59). Stages 1–3 are blocking (later stages need valid files);
// stages 4–7 collect every problem. bm80: an upload over the type's open
// layout DRAFT (the expected draft the warning named) overwrites it in place. The zip is read in memory with fflate,
// never written to disk, in two passes: the central directory (no inflate),
// then a streamed inflate with a running byte cap that trusts no declared size.

export interface GateContext {
  layoutCode: string;
  expectedVersionNo: number;
}
export type GateResult =
  | {
      ok: true;
      files: Map<string, Buffer>;
      manifest: LayoutManifest;
      indexDigest: string;
    }
  | { ok: false; problems: LayoutProblem[] };

type Render = typeof renderAndReadSections;

const INDEX_FILE = "checksums.json";
const MANIFEST_FILE = "manifest.json";
const RENDER_FILE = "(render)";
const PACKAGE_FILE = "(package)";
const MAX_LISTED_URLS = 10;
// Review fix — pass 2 feeds the zip to fflate in steps this small. fflate
// inflates a whole pushed chunk before `ondata` sees a byte (and the sync
// decoder ignores `terminate()`), so one push of the whole zip let a deflate
// bomb expand ~1000:1 before the cap ran. At 1 KiB per push, at most about
// 1 MiB is inflated past the cap before pushing stops.
const INFLATE_PUSH_BYTES = 1024;
const REQUIRED = new Set<string>(LAYOUT_PACKAGE_REQUIRED_FILES);

function problem(
  file: string,
  code: LayoutProblemCode,
  message: string,
): LayoutProblem {
  return { file, code, message };
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

// A path that tries to leave the package: a backslash, a leading `/`, a `..`
// segment or a drive letter.
function isUnsafePath(name: string): boolean {
  return (
    name.includes("\\") ||
    name.startsWith("/") ||
    /^[A-Za-z]:/.test(name) ||
    name.split("/").includes("..")
  );
}

// The exact allow-list: the required files and `fonts/<name>.woff2` /
// `fonts/OFL.txt`. Anything else — `*.editor.json`, `settings.json` (bm81
// restore), another partial — is refused.
function isAllowedName(name: string): boolean {
  if (isUnsafePath(name)) return false;
  return REQUIRED.has(name) || LAYOUT_PACKAGE_FONT_FILE.test(name);
}

const isDirectory = (name: string): boolean => name.endsWith("/");

// Stage 1 — the zip's shape and size.
export function readZip(
  zip: Uint8Array,
):
  | { ok: true; files: Map<string, Buffer> }
  | { ok: false; problems: LayoutProblem[] } {
  // Pass 1: the central directory only. The filter records each entry and
  // returns false, so NOTHING is decompressed (guardrail 69).
  const entries: { name: string; originalSize: number }[] = [];
  try {
    unzipSync(zip, {
      filter: (f) => {
        entries.push({ name: f.name, originalSize: f.originalSize });
        return false;
      },
    });
  } catch {
    return {
      ok: false,
      problems: [
        problem(PACKAGE_FILE, "ZIP_UNEXPECTED_FILE", "not a readable zip"),
      ],
    };
  }

  const problems: LayoutProblem[] = [];
  const fileEntries = entries.filter((e) => !isDirectory(e.name));
  if (fileEntries.length > LAYOUT_PACKAGE_MAX_ENTRIES) {
    problems.push(
      problem(
        PACKAGE_FILE,
        "ZIP_TOO_MANY_ENTRIES",
        `the package has ${fileEntries.length} entries; at most ${LAYOUT_PACKAGE_MAX_ENTRIES} are allowed`,
      ),
    );
  }
  for (const e of fileEntries) {
    if (!isAllowedName(e.name)) {
      problems.push(
        problem(
          e.name,
          "ZIP_UNEXPECTED_FILE",
          "is not a file a layout package may contain",
        ),
      );
    }
  }
  const declared = fileEntries.reduce((n, e) => n + e.originalSize, 0);
  if (declared > LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
    problems.push(
      problem(
        PACKAGE_FILE,
        "ZIP_TOO_LARGE",
        `the package unpacks to ${declared} bytes; at most ${LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES} are allowed`,
      ),
    );
  }
  if (problems.length > 0) return { ok: false, problems };

  // Pass 2: the streamed inflate. Every entry's name is re-checked BEFORE it
  // starts (an entry absent from the central directory is never inflated), and
  // a running total aborts at the cap whatever the headers declared: the zip
  // is pushed in small steps, and pushing stops once the cap is crossed.
  const listed = new Set(fileEntries.map((e) => e.name));
  const parts = new Map<string, Uint8Array[]>();
  const seen = new Set<string>();
  let started = 0;
  let total = 0;
  let overCap = false;
  const unzip = new Unzip();
  unzip.register(UnzipInflate);
  unzip.onfile = (file) => {
    if (overCap || isDirectory(file.name)) return;
    if (seen.has(file.name)) {
      problems.push(
        problem(
          file.name,
          "ZIP_UNEXPECTED_FILE",
          "appears more than once in the package",
        ),
      );
      return;
    }
    seen.add(file.name);
    started++;
    // Review fix — the local header must name an entry the central directory
    // listed (pass 1 approved those names, not these).
    if (
      started > LAYOUT_PACKAGE_MAX_ENTRIES ||
      !listed.has(file.name) ||
      !isAllowedName(file.name)
    ) {
      problems.push(
        problem(
          file.name,
          "ZIP_UNEXPECTED_FILE",
          "is not a file a layout package may contain",
        ),
      );
      return;
    }
    const chunks: Uint8Array[] = [];
    parts.set(file.name, chunks);
    file.ondata = (err, data) => {
      if (err) {
        problems.push(
          problem(file.name, "ZIP_UNEXPECTED_FILE", "could not be unpacked"),
        );
        return;
      }
      if (overCap) return;
      total += data.length;
      if (total > LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES) {
        overCap = true;
        problems.push(
          problem(
            PACKAGE_FILE,
            "ZIP_TOO_LARGE",
            `the package unpacks to more than ${LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES} bytes`,
          ),
        );
        return;
      }
      chunks.push(data);
    };
    file.start();
  };
  try {
    for (
      let offset = 0;
      offset < zip.length && !overCap;
      offset += INFLATE_PUSH_BYTES
    ) {
      const end = Math.min(offset + INFLATE_PUSH_BYTES, zip.length);
      unzip.push(zip.subarray(offset, end), end === zip.length);
    }
  } catch {
    if (!overCap) {
      problems.push(
        problem(PACKAGE_FILE, "ZIP_UNEXPECTED_FILE", "not a readable zip"),
      );
    }
  }
  if (problems.length > 0) return { ok: false, problems };

  const files = new Map<string, Buffer>();
  for (const [name, chunks] of parts) {
    files.set(name, Buffer.concat(chunks));
  }
  for (const name of LAYOUT_PACKAGE_REQUIRED_FILES) {
    if (!files.has(name)) {
      problems.push(
        problem(name, "ZIP_MISSING_FILE", "is missing from the package"),
      );
    }
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, files };
}

// Stage 2 — `checksums.json` lists every other file, and nothing more, with
// matching sha256 digests. Returns the index's own digest when clean.
function checkChecksums(
  files: ReadonlyMap<string, Buffer>,
):
  | { ok: true; indexDigest: string }
  | { ok: false; problems: LayoutProblem[] } {
  const indexBytes = files.get(INDEX_FILE)!;
  let index: { algorithm: string; files: Record<string, string> };
  try {
    const parsed = checksumIndexSchema.safeParse(
      JSON.parse(indexBytes.toString("utf-8")),
    );
    if (!parsed.success || parsed.data.algorithm !== "sha256")
      throw new Error("invalid");
    index = parsed.data;
  } catch {
    return {
      ok: false,
      problems: [
        problem(
          INDEX_FILE,
          "CHECKSUM_MISMATCH",
          "is not a valid sha256 checksum index",
        ),
      ],
    };
  }
  const problems: LayoutProblem[] = [];
  for (const [name, digest] of Object.entries(index.files)) {
    const bytes = files.get(name);
    if (bytes === undefined) {
      problems.push(
        problem(
          name,
          "CHECKSUM_MISMATCH",
          "is listed in checksums.json but missing from the package",
        ),
      );
    } else if (sha256(bytes) !== digest) {
      problems.push(
        problem(
          name,
          "CHECKSUM_MISMATCH",
          "does not match its checksums.json entry",
        ),
      );
    }
  }
  for (const name of files.keys()) {
    if (name !== INDEX_FILE && !(name in index.files)) {
      problems.push(
        problem(name, "CHECKSUM_MISMATCH", "is not listed in checksums.json"),
      );
    }
  }
  return problems.length > 0
    ? { ok: false, problems }
    : { ok: true, indexDigest: sha256(indexBytes) };
}

// Stage 3 — the manifest, the type's layout code and the computed version.
function checkManifest(
  files: ReadonlyMap<string, Buffer>,
  ctx: GateContext,
):
  | { ok: true; manifest: LayoutManifest }
  | { ok: false; problems: LayoutProblem[] } {
  let manifest: LayoutManifest;
  try {
    const parsed = layoutManifestSchema.safeParse(
      JSON.parse(files.get(MANIFEST_FILE)!.toString("utf-8")),
    );
    if (!parsed.success) {
      return {
        ok: false,
        problems: parsed.error.issues.map((i) =>
          problem(
            MANIFEST_FILE,
            "MANIFEST_INVALID",
            `${i.path.join(".") || "(root)"}: ${i.message}`,
          ),
        ),
      };
    }
    manifest = parsed.data;
  } catch {
    return {
      ok: false,
      problems: [
        problem(MANIFEST_FILE, "MANIFEST_INVALID", "is not valid JSON"),
      ],
    };
  }
  const problems: LayoutProblem[] = [];
  if (manifest.layoutCode !== ctx.layoutCode) {
    problems.push(
      problem(
        MANIFEST_FILE,
        "LAYOUT_CODE_MISMATCH",
        `layoutCode is ${manifest.layoutCode}; this type's layout code is ${ctx.layoutCode}`,
      ),
    );
  }
  if (manifest.layoutVersion !== ctx.expectedVersionNo) {
    problems.push(
      problem(
        MANIFEST_FILE,
        "LAYOUT_VERSION_MISMATCH",
        `layoutVersion is ${manifest.layoutVersion}; this upload must be layout version ${ctx.expectedVersionNo}`,
      ),
    );
  }
  return problems.length > 0 ? { ok: false, problems } : { ok: true, manifest };
}

// Stages 4–7 alone, over already-verified files. checkLayoutPackage calls it;
// activation (bm79) re-runs it on the layout DRAFT.
export async function checkLayoutFiles(
  files: Map<string, Buffer>,
  render: Render = renderAndReadSections,
): Promise<LayoutProblem[]> {
  let layout: ReturnType<typeof layoutFilesFromVerified>;
  try {
    layout = layoutFilesFromVerified(files);
  } catch (err) {
    return [problem(RENDER_FILE, "COMPILE_FAILED", errorMessage(err))];
  }

  // Stage 4 — the lint, hardening and typed-supplier rules over every .hbs.
  const templates = Object.fromEntries(
    [...files]
      .filter(([name]) => name.endsWith(".hbs"))
      .map(([name, bytes]) => [name, bytes.toString("utf-8")]),
  );
  const problems: LayoutProblem[] = [...lintLayoutTemplates(templates)];

  // Stage 5 — the static compliance tier.
  const staticResult = staticComplianceProblems(layout);
  problems.push(...staticResult.problems);

  // Stage 6 — strict compile and execute, for both compliance structures,
  // against the probe and the package's own sample bill.
  for (const structure of COMPLIANCE_STRUCTURES) {
    try {
      const generated = generate(layout, structure);
      testRender(
        generated.invoiceHbs,
        generated.footerHbs,
        parseSampleData(files),
      );
    } catch (err) {
      problems.push(problem(RENDER_FILE, "COMPILE_FAILED", errorMessage(err)));
      break;
    }
  }

  // Stage 7 — only a clean template is rendered: the hardened probe render's
  // blocked URLs and the visible tier, from the same launch per render.
  if (problems.length > 0) return problems;
  const blocked = new Set<string>();
  const visible = await visibleComplianceProblems(
    staticResult.renders,
    async (html, probes) => {
      const result = await render(html, probes);
      for (const url of result.blockedUrls) blocked.add(url);
      return result.report;
    },
  );
  if (blocked.size > 0) {
    const urls = [...blocked];
    problems.push(
      problem(
        RENDER_FILE,
        "LAYOUT_EXTERNAL_FETCH",
        `the layout tried to fetch ${urls.length} URL${urls.length === 1 ? "" : "s"}: ${urls
          .slice(0, MAX_LISTED_URLS)
          .join(", ")}${urls.length > MAX_LISTED_URLS ? ", …" : ""}`,
      ),
    );
  }
  problems.push(...visible);
  return problems;
}

export async function checkLayoutPackage(
  zip: Uint8Array,
  ctx: GateContext,
  render: Render = renderAndReadSections,
): Promise<GateResult> {
  const read = readZip(zip);
  if (!read.ok) return read;
  const checksums = checkChecksums(read.files);
  if (!checksums.ok) return checksums;
  const manifest = checkManifest(read.files, ctx);
  if (!manifest.ok) return manifest;

  const problems = await checkLayoutFiles(read.files, render);
  if (problems.length > 0) return { ok: false, problems };
  return {
    ok: true,
    files: read.files,
    manifest: manifest.manifest,
    indexDigest: checksums.indexDigest,
  };
}

// bm80 — `matchExpectedDraft` lives beside its second caller, install (an
// import from here would be a cycle: this module imports install).
export { matchExpectedDraft };

export async function uploadLayoutPackage(
  input: { familyId: string; zip: Uint8Array; expectedDraft: ExpectedDraft },
  actorId: string,
  deps: { render?: Render } = {},
): Promise<UploadLayoutPackageResult> {
  const type = await billTemplateFamilyRepository.findById(db, input.familyId);
  if (!type) return { ok: false, code: "VALIDATION_ERROR", problems: [] };
  if (type.retiredDatetime !== null) {
    return { ok: false, code: "TEMPLATE_TYPE_RETIRED", problems: [] };
  }

  // Review fix — plain reads, no lock: an advisory xact lock here would run
  // in autocommit and protect nothing; install re-checks under its locks.
  const openLayoutDraft = await billTemplateVersionRepository.findDraft(db, {
    kind: "layout",
    familyId: input.familyId,
  });
  const mode = matchExpectedDraft(openLayoutDraft, input.expectedDraft);
  if (mode === "stale") {
    return { ok: false, code: "DRAFT_CHANGED_SINCE_WARNING", problems: [] };
  }
  // The expected version is computed, never typed: an overwrite keeps the
  // open DRAFT's number (the editor exports vN again to replace draft vN); a
  // create is max over every layout row of the type (RETIRED included) + 1.
  const expectedVersionNo =
    mode === "overwrite" && openLayoutDraft
      ? openLayoutDraft.versionNo
      : await billTemplateVersionRepository.nextVersionNo(db, {
          kind: "layout",
          familyId: input.familyId,
        });

  const gate = await checkLayoutPackage(
    input.zip,
    { layoutCode: type.layoutCode, expectedVersionNo },
    deps.render,
  );
  if (!gate.ok) {
    return { ok: false, code: "LAYOUT_REJECTED", problems: gate.problems };
  }

  return installLayoutPackage({
    familyId: input.familyId,
    layoutCode: type.layoutCode,
    versionNo: expectedVersionNo,
    files: gate.files,
    manifest: gate.manifest,
    indexDigest: gate.indexDigest,
    actorId,
    mode,
    expectedDraft: input.expectedDraft,
  });
}
