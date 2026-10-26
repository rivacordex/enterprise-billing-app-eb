import { createHash } from "node:crypto";

import { zipSync } from "fflate";
import type * as Fflate from "fflate";
import { beforeEach, describe, expect, it, vi } from "vitest";

// bm78-spec §13 (Inv #60, guardrail 69) — the layout package GATE, DB-free:
// one fixture per gate code, each built in memory from INVTPL-BASIC-A4 v1
// (tests/helpers/layout-package.ts). The Chromium probe render is stubbed to a
// clean report (every compliance section present once, printing every required
// value), so stage 7 is driven only by what the stub returns. Stages 1–3 stop
// at their own stage; stages 4–7 collect every problem.

// The gate module graph reaches `@/db/client` (the upload orchestration and
// install live beside it); nothing here touches it.
vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: {
    digest: (bytes: Buffer, algorithm: string) =>
      createHash(algorithm).update(bytes).digest("hex"),
  },
}));

// guardrail 69 — count every streaming Unzip and every UnzipInflate the gate
// constructs, wrapping (not replacing) fflate's own classes.
// Review fix: also sum every byte any UnzipInflate hands on (`inflated`), so
// a test can bound how much a lying entry expands before the cap stops it.
const inflateSpy = vi.hoisted(() => ({ unzips: 0, inflates: 0, inflated: 0 }));
vi.mock("fflate", async (importOriginal) => {
  const actual = await importOriginal<typeof Fflate>();
  class CountingUnzip extends actual.Unzip {
    constructor(...args: ConstructorParameters<typeof actual.Unzip>) {
      super(...args);
      inflateSpy.unzips++;
    }
  }
  class CountingUnzipInflate extends actual.UnzipInflate {
    constructor() {
      super();
      inflateSpy.inflates++;
      let handler: ((...a: unknown[]) => void) | undefined;
      Object.defineProperty(this, "ondata", {
        configurable: true,
        get: () => handler,
        set: (fn: (err: unknown, data: Uint8Array, final: boolean) => void) => {
          handler = (err, data, final) => {
            inflateSpy.inflated +=
              (data as Uint8Array | undefined)?.length ?? 0;
            fn(err, data as Uint8Array, final as boolean);
          };
        },
      });
    }
  }
  return {
    ...actual,
    Unzip: CountingUnzip,
    UnzipInflate: CountingUnzipInflate,
  };
});

import { COMPLIANCE_SECTION_KEYS } from "@/services/billing/invoice-template/compliance";
import type { renderAndReadSections } from "@/services/billing/invoice-template/compliance-render";
import {
  checkLayoutPackage,
  matchExpectedDraft,
  readZip,
} from "@/services/billing/invoice-template/upload-layout-package";
import {
  buildLayoutPackage,
  cleanReport,
  cleanRender as sharedCleanRender,
  replaceInFile,
  type LayoutPackageOptions,
} from "@/tests/helpers/layout-package";
import {
  LAYOUT_PACKAGE_MAX_ENTRIES,
  LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES,
  LAYOUT_PACKAGE_REQUIRED_FILES,
  LAYOUT_PACKAGE_SETTINGS_MAX_BYTES,
  type LayoutProblem,
} from "@/types/billing";
import { LAYOUT_PART_KEYS } from "@/validation/billing/layout-manifest.schema";

type Render = typeof renderAndReadSections;

const CODE = "INVTPL-BASIC-A4";
const CTX = { layoutCode: CODE, expectedVersionNo: 1 };
const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// The shared clean renderer, wrapped so a case can count its calls.
function cleanRender(blockedUrls: string[] = []) {
  return vi.fn<Render>(sharedCleanRender(blockedUrls));
}

function pkg(opts: LayoutPackageOptions = {}) {
  return buildLayoutPackage({ layoutCode: CODE, layoutVersion: 1, ...opts });
}

async function gate(zip: Uint8Array, render: Render = cleanRender()) {
  return checkLayoutPackage(zip, CTX, render);
}

function problemsOf(result: Awaited<ReturnType<typeof gate>>): LayoutProblem[] {
  if (result.ok) throw new Error("expected the gate to refuse the package");
  return result.problems;
}

const codes = (problems: LayoutProblem[]) => [
  ...new Set(problems.map((p) => p.code)),
];

// --- raw zip surgery (fflate's zipSync writes no data descriptors) ------------

const LOCAL_SIG = 0x04034b50; // PK\x03\x04
const CENTRAL_SIG = 0x02014b50; // PK\x01\x02

// Every local-header and central-directory entry, located by its signature AND
// a name that parses back — so a signature-like run of compressed bytes is
// never mistaken for a header.
function headers(zip: Uint8Array): {
  kind: "local" | "central";
  at: number;
  name: string;
  nameAt: number;
}[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: {
    kind: "local" | "central";
    at: number;
    name: string;
    nameAt: number;
  }[] = [];
  for (let i = 0; i + 46 <= zip.length; i++) {
    const sig = view.getUint32(i, true);
    if (sig === LOCAL_SIG) {
      const len = view.getUint16(i + 26, true);
      const name = Buffer.from(zip.subarray(i + 30, i + 30 + len)).toString(
        "utf-8",
      );
      out.push({ kind: "local", at: i, name, nameAt: i + 30 });
    } else if (sig === CENTRAL_SIG) {
      const len = view.getUint16(i + 28, true);
      const name = Buffer.from(zip.subarray(i + 46, i + 46 + len)).toString(
        "utf-8",
      );
      out.push({ kind: "central", at: i, name, nameAt: i + 46 });
    }
  }
  return out;
}

// Rewrite an entry's declared uncompressed size in BOTH its local header
// (offset 22) and its central-directory entry (offset 24).
function patchDeclaredSize(zip: Uint8Array, name: string, size: number) {
  const out = new Uint8Array(zip);
  const view = new DataView(out.buffer);
  const hits = headers(out).filter((h) => h.name === name);
  expect(hits.map((h) => h.kind).sort()).toEqual(["central", "local"]);
  for (const h of hits) {
    view.setUint32(h.at + (h.kind === "local" ? 22 : 24), size, true);
  }
  return out;
}

// Rename an entry in its LOCAL header only (same byte length): the central
// directory pass 1 approves then names a different file than pass 2 reads.
function renameLocalOnly(zip: Uint8Array, from: string, to: string) {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = new Uint8Array(zip);
  const local = headers(out).filter(
    (h) => h.name === from && h.kind === "local",
  );
  expect(local).toHaveLength(1);
  out.set(Buffer.from(to, "utf-8"), local[0]!.nameAt);
  return out;
}

// Rename an entry (same byte length) in both headers — how a zip with two
// entries of the SAME name is made, since zipSync takes an object.
function renameEntry(zip: Uint8Array, from: string, to: string) {
  expect(Buffer.byteLength(from)).toBe(Buffer.byteLength(to));
  const out = new Uint8Array(zip);
  const hits = headers(out).filter((h) => h.name === from);
  expect(hits).toHaveLength(2);
  for (const h of hits) out.set(Buffer.from(to, "utf-8"), h.nameAt);
  return out;
}

beforeEach(() => {
  inflateSpy.unzips = 0;
  inflateSpy.inflates = 0;
  inflateSpy.inflated = 0;
});

describe("bm78 layout package gate — a clean package", () => {
  it("INVTPL-BASIC-A4 passes: ok, every file, the manifest, indexDigest = sha256(checksums.json)", async () => {
    const built = pkg();
    const render = cleanRender();
    const result = await gate(built.zip, render);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect([...result.files.keys()].sort()).toEqual(
      [...built.files.keys()].sort(),
    );
    for (const [name, bytes] of built.files) {
      expect(result.files.get(name)?.equals(bytes)).toBe(true);
    }
    expect(result.manifest).toMatchObject({
      layoutCode: CODE,
      layoutVersion: 1,
    });
    expect(result.indexDigest).toBe(sha256(built.indexBytes!));
    // Stage 7 reads both probe renders (Payment on, then off).
    expect(render).toHaveBeenCalledTimes(2);
    // The spy is live: a clean package IS inflated (in pass 2).
    expect(inflateSpy.unzips).toBe(1);
    expect(inflateSpy.inflates).toBeGreaterThan(0);
  });

  it("LAYOUT_PACKAGE_REQUIRED_FILES lists partials/<k>.hbs for every LAYOUT_PART_KEYS entry (pins the duplicated list)", () => {
    const partials = LAYOUT_PACKAGE_REQUIRED_FILES.filter((f) =>
      f.startsWith("partials/"),
    );
    expect([...partials].sort()).toEqual(
      LAYOUT_PART_KEYS.map((k) => `partials/${k}.hbs`).sort(),
    );
    expect(LAYOUT_PACKAGE_REQUIRED_FILES).toEqual(
      expect.arrayContaining([
        "manifest.json",
        "shell.hbs",
        "footer.hbs",
        "sample-data.json",
        "checksums.json",
      ]),
    );
  });
});

describe("bm78 layout package gate — stage 1, zip shape and size (blocking)", () => {
  it("ZIP_TOO_LARGE: an honestly-declared 3 MiB bomb is refused in pass 1 — the streaming Unzip is never constructed, nothing inflated", async () => {
    const built = pkg({
      override: (f) => f.set("fonts/big.woff2", Buffer.alloc(3 * 1024 * 1024)),
    });
    // It compresses small: only the declared size gives it away.
    expect(built.zip.length).toBeLessThan(64 * 1024);

    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["ZIP_TOO_LARGE"]);
    expect(inflateSpy.unzips).toBe(0);
    expect(inflateSpy.inflates).toBe(0);
  });

  it("ZIP_TOO_LARGE: the same entry declaring 1 KiB in both headers passes pass 1, and the pass-2 byte counter aborts at the cap", async () => {
    const built = pkg({
      override: (f) => f.set("fonts/big.woff2", Buffer.alloc(3 * 1024 * 1024)),
    });
    const lying = patchDeclaredSize(built.zip, "fonts/big.woff2", 1024);

    const problems = problemsOf(await gate(lying));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "ZIP_TOO_LARGE",
        message: expect.stringContaining(
          `more than ${LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES} bytes`,
        ),
      }),
    ]);
    // Pass 1 passed (the stream ran); the counter, not the header, stopped it.
    expect(inflateSpy.unzips).toBe(1);
    expect(inflateSpy.inflates).toBeGreaterThan(0);
  });

  it("review fix — a 64 MiB deflate bomb declaring 1 KiB is stopped near the cap: pushed in small steps, it never inflates in full", async () => {
    const built = pkg({
      override: (f) => f.set("fonts/big.woff2", Buffer.alloc(64 * 1024 * 1024)),
    });
    const lying = patchDeclaredSize(built.zip, "fonts/big.woff2", 1024);

    expect(codes(problemsOf(await gate(lying)))).toEqual(["ZIP_TOO_LARGE"]);
    // One push of the whole zip inflated all 64 MiB before the cap ran.
    expect(inflateSpy.inflated).toBeLessThanOrEqual(
      LAYOUT_PACKAGE_MAX_UNCOMPRESSED_BYTES + 2 * 1024 * 1024,
    );
  });

  it("review fix — a local header naming a file the central directory does not list is refused, never stored", async () => {
    const built = pkg();
    // Same byte length as "partials/header.hbs", and on the font allow-list.
    const forged = renameLocalOnly(
      built.zip,
      "partials/header.hbs",
      "fonts/abcdefg.woff2",
    );
    const result = readZip(forged);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.problems).toContainEqual(
      expect.objectContaining({
        file: "fonts/abcdefg.woff2",
        code: "ZIP_UNEXPECTED_FILE",
      }),
    );
  });

  it(`ZIP_TOO_MANY_ENTRIES: ${LAYOUT_PACKAGE_MAX_ENTRIES + 1} entries`, async () => {
    const built = pkg({
      override: (f) => {
        for (let i = 0; f.size < LAYOUT_PACKAGE_MAX_ENTRIES + 1; i++) {
          f.set(`fonts/f${i}.woff2`, Buffer.from([i]));
        }
      },
    });
    expect(built.files.size).toBe(LAYOUT_PACKAGE_MAX_ENTRIES + 1);

    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["ZIP_TOO_MANY_ENTRIES"]);
    expect(inflateSpy.unzips).toBe(0);
  });

  it.each([
    "../x",
    "/abs",
    "C:\\x",
    "x.editor.json",
    // bm81: `settings.json` is now an allowed optional file.
    "notes.txt",
    "fonts/x.ttf",
    "partials/extra.hbs",
  ])("ZIP_UNEXPECTED_FILE: %s is refused before any inflate", async (name) => {
    const built = pkg({ override: (f) => f.set(name, Buffer.from("x")) });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({ code: "ZIP_UNEXPECTED_FILE", file: name }),
    ]);
    expect(inflateSpy.unzips).toBe(0);
  });

  it("ZIP_UNEXPECTED_FILE: a duplicate name (two entries both called partials/header.hbs)", async () => {
    const built = pkg({
      override: (f) => f.set("partials/HEADER.hbs", Buffer.from("<p>dup</p>")),
    });
    const dup = renameEntry(
      built.zip,
      "partials/HEADER.hbs",
      "partials/header.hbs",
    );

    const problems = problemsOf(await gate(dup));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "ZIP_UNEXPECTED_FILE",
        file: "partials/header.hbs",
        message: expect.stringContaining("more than once"),
      }),
    ]);
  });

  it("ZIP_UNEXPECTED_FILE: bytes that are not a zip", async () => {
    const problems = problemsOf(await gate(Buffer.from("not a zip at all")));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "ZIP_UNEXPECTED_FILE",
        message: "not a readable zip",
      }),
    ]);
  });

  it("directory entries (a name ending in /) are ignored", async () => {
    const built = pkg();
    // fflate writes a nested object as a directory entry ("fonts/").
    const zip = zipSync({ ...Object.fromEntries(built.files), fonts: {} });
    expect(
      headers(zip).some((h) => h.kind === "central" && h.name === "fonts/"),
    ).toBe(true);
    const read = readZip(zip);
    expect(read.ok).toBe(true);
    if (read.ok) expect(read.files.has("fonts/")).toBe(false);
    expect((await gate(zip)).ok).toBe(true);
  });

  it("ZIP_MISSING_FILE: no partials/taxSummary.hbs", async () => {
    const built = pkg({ edit: (f) => f.delete("partials/taxSummary.hbs") });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "ZIP_MISSING_FILE",
        file: "partials/taxSummary.hbs",
      }),
    ]);
  });

  it("stage 1 stops at its own stage: an unexpected file plus an edited file (a checksum mismatch) reports only the zip problem", async () => {
    const built = pkg({
      override: (f) => {
        f.set("notes.txt", Buffer.from("{}"));
        replaceInFile(
          f,
          "partials/header.hbs",
          "<h1>Invoice</h1>",
          "<h1>X</h1>",
        );
      },
    });
    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["ZIP_UNEXPECTED_FILE"]);
  });
});

describe("bm78 layout package gate — stage 2, checksums (blocking)", () => {
  it("CHECKSUM_MISMATCH: an edited file", async () => {
    const built = pkg({
      override: (f) =>
        replaceInFile(
          f,
          "partials/header.hbs",
          "<h1>Invoice</h1>",
          "<h1>X</h1>",
        ),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "CHECKSUM_MISMATCH",
        file: "partials/header.hbs",
      }),
    ]);
  });

  it("CHECKSUM_MISMATCH: an unlisted extra file", async () => {
    const built = pkg({
      override: (f) => f.set("fonts/OFL.txt", Buffer.from("licence")),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "CHECKSUM_MISMATCH",
        file: "fonts/OFL.txt",
        message: expect.stringContaining("not listed"),
      }),
    ]);
  });

  it("CHECKSUM_MISMATCH: a listed-but-missing file", async () => {
    const built = pkg({
      edit: (f) => f.set("fonts/Body.woff2", Buffer.from("font")),
      override: (f) => f.delete("fonts/Body.woff2"),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "CHECKSUM_MISMATCH",
        file: "fonts/Body.woff2",
        message: expect.stringContaining("missing"),
      }),
    ]);
  });

  it("stage 2 stops at its own stage: an edited file plus a wrong manifest code reports only the checksum problem", async () => {
    const built = pkg({
      layoutCode: "INVTPL-OTHER",
      override: (f) =>
        replaceInFile(
          f,
          "partials/header.hbs",
          "<h1>Invoice</h1>",
          "<h1>X</h1>",
        ),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["CHECKSUM_MISMATCH"]);
  });
});

describe("bm78 layout package gate — stage 3, manifest (blocking)", () => {
  it("MANIFEST_INVALID: a manifest with no pageSetup", async () => {
    const built = pkg({ manifest: (m) => delete m.pageSetup });
    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["MANIFEST_INVALID"]);
    expect(problems[0]).toMatchObject({ file: "manifest.json" });
  });

  it("LAYOUT_CODE_MISMATCH: the manifest names another layout code", async () => {
    const built = pkg({ layoutCode: "INVTPL-OTHER" });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "LAYOUT_CODE_MISMATCH",
        message: expect.stringMatching(/INVTPL-OTHER.*INVTPL-BASIC-A4/),
      }),
    ]);
  });

  it("LAYOUT_VERSION_MISMATCH: the manifest's version is not the computed next version", async () => {
    const built = pkg({ layoutVersion: 3 });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "LAYOUT_VERSION_MISMATCH",
        message: expect.stringMatching(/3.*1/),
      }),
    ]);
  });

  it("stage 3 stops at its own stage: an invalid manifest plus a lint violation reports only the manifest problem", async () => {
    const render = cleanRender();
    const built = pkg({
      manifest: (m) => delete m.pageSetup,
      edit: (f) =>
        replaceInFile(f, "partials/header.hbs", "<h1>", '<h1 onclick="x()">'),
    });
    const problems = problemsOf(
      await checkLayoutPackage(built.zip, CTX, render),
    );
    expect(codes(problems)).toEqual(["MANIFEST_INVALID"]);
    expect(render).not.toHaveBeenCalled();
  });
});

describe("bm81 — restore: an export's settings.json", () => {
  // A schema-valid settings.json bound to `files`' own checksums.json.
  function exportSettings(
    files: Map<string, Buffer>,
    edit: (s: Record<string, unknown>) => void = () => {},
  ): Buffer {
    const settings: Record<string, unknown> = {
      exportFormat: 1,
      source: {
        typeCode: "BASIC",
        typeName: "Basic",
        layoutVersion: 3,
        settingsVersion: 4,
        status: "ACTIVE",
        layoutChecksum: sha256(files.get("checksums.json")!),
        exportedAt: "2026-10-25T01:02:03.000Z",
        exportedBy: "Exporter",
      },
      structure: {
        sections: { payment: false },
        columns: {},
        footnote: ["Restored footnote"],
      },
    };
    edit(settings);
    return Buffer.from(`${JSON.stringify(settings, null, 2)}\n`, "utf-8");
  }

  it("a valid, bound settings.json skips the version check and is returned as `restore`", async () => {
    // The package says v3; the type expects v1.
    const built = pkg({
      layoutVersion: 3,
      override: (f) => f.set("settings.json", exportSettings(f)),
    });
    const result = await gate(built.zip);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.restore).toMatchObject({
      source: { layoutVersion: 3, settingsVersion: 4 },
      structure: { footnote: ["Restored footnote"] },
    });
  });

  it("without settings.json the same package keeps the version check, and `restore` is null when clean", async () => {
    const v3 = problemsOf(await gate(pkg({ layoutVersion: 3 }).zip));
    expect(codes(v3)).toEqual(["LAYOUT_VERSION_MISMATCH"]);
    const v1 = await gate(pkg().zip);
    expect(v1.ok && v1.restore).toBeNull();
  });

  it("SETTINGS_INVALID: a settings.json that fails the schema, with the issue paths; stages 4–7 never run", async () => {
    const render = cleanRender();
    const built = pkg({
      layoutVersion: 3,
      override: (f) =>
        f.set(
          "settings.json",
          exportSettings(f, (s) => {
            s.exportFormat = 2;
          }),
        ),
    });
    const problems = problemsOf(
      await checkLayoutPackage(built.zip, CTX, render),
    );
    expect(problems).toEqual([
      expect.objectContaining({
        file: "settings.json",
        code: "SETTINGS_INVALID",
        message: expect.stringContaining("exportFormat"),
      }),
    ]);
    expect(render).not.toHaveBeenCalled();
  });

  it("SETTINGS_INVALID: a settings.json bound to other files (another layoutChecksum)", async () => {
    const built = pkg({
      layoutVersion: 3,
      override: (f) =>
        f.set(
          "settings.json",
          exportSettings(f, (s) => {
            (s.source as Record<string, unknown>).layoutChecksum = "0".repeat(
              64,
            );
          }),
        ),
    });
    expect(problemsOf(await gate(built.zip))).toEqual([
      {
        file: "settings.json",
        code: "SETTINGS_INVALID",
        message: "settings.json does not belong to these layout files",
      },
    ]);
  });

  it("CHECKSUM_MISMATCH: a settings.json listed in checksums.json", async () => {
    const built = pkg({
      edit: (f) => f.set("settings.json", Buffer.from("{}")),
    });
    expect(problemsOf(await gate(built.zip))).toEqual([
      expect.objectContaining({
        file: "settings.json",
        code: "CHECKSUM_MISMATCH",
      }),
    ]);
  });

  it("LAYOUT_CODE_MISMATCH still applies with a valid settings.json", async () => {
    const built = pkg({
      layoutCode: "INVTPL-OTHER",
      layoutVersion: 3,
      override: (f) => f.set("settings.json", exportSettings(f)),
    });
    expect(codes(problemsOf(await gate(built.zip)))).toEqual([
      "LAYOUT_CODE_MISMATCH",
    ]);
  });

  it("review fix (#12) — an unbound settings.json no longer hides the manifest's code mismatch", async () => {
    const built = pkg({
      layoutCode: "INVTPL-OTHER",
      layoutVersion: 3,
      override: (f) =>
        f.set(
          "settings.json",
          exportSettings(f, (s) => {
            (s.source as Record<string, unknown>).layoutChecksum = "0".repeat(
              64,
            );
          }),
        ),
    });
    expect(codes(problemsOf(await gate(built.zip)))).toEqual([
      "SETTINGS_INVALID",
      "LAYOUT_CODE_MISMATCH",
    ]);
  });

  it("review fix (#15) — a clean restore's `files` hold only the layout files", async () => {
    const built = pkg({
      layoutVersion: 3,
      override: (f) => f.set("settings.json", exportSettings(f)),
    });
    const result = await gate(built.zip);
    expect(result.ok && result.files.has("settings.json")).toBe(false);
    expect(result.ok && result.files.size).toBe(built.files.size - 1);
  });

  describe("review fix (owner, #5/#9) — settings.json has its own budget", () => {
    // Pad the layout with small font entries until it has exactly `entries`
    // layout files (checksums.json included).
    function atEntries(entries: number) {
      return pkg({
        layoutVersion: 3,
        edit: (f) => {
          for (let i = 0; f.size + 1 < entries; i++) {
            f.set(`fonts/pad${i}.woff2`, Buffer.from(`font ${i}`));
          }
        },
        override: (f) => f.set("settings.json", exportSettings(f)),
      });
    }

    it(`a layout at ${LAYOUT_PACKAGE_MAX_ENTRIES} entries plus settings.json passes stage 1`, () => {
      const built = atEntries(LAYOUT_PACKAGE_MAX_ENTRIES);
      expect(built.files.size).toBe(LAYOUT_PACKAGE_MAX_ENTRIES + 1);
      expect(readZip(built.zip).ok).toBe(true);
    });

    it("one layout entry more is still ZIP_TOO_MANY_ENTRIES", () => {
      const read = readZip(atEntries(LAYOUT_PACKAGE_MAX_ENTRIES + 1).zip);
      expect(read.ok ? [] : codes(read.problems)).toEqual([
        "ZIP_TOO_MANY_ENTRIES",
      ]);
    });

    it("a settings.json over LAYOUT_PACKAGE_SETTINGS_MAX_BYTES is ZIP_TOO_LARGE on that file", () => {
      const built = pkg({
        layoutVersion: 3,
        override: (f) =>
          f.set(
            "settings.json",
            Buffer.alloc(LAYOUT_PACKAGE_SETTINGS_MAX_BYTES + 1, 0x20),
          ),
      });
      const read = readZip(built.zip);
      expect(read.ok ? [] : read.problems).toEqual([
        expect.objectContaining({
          file: "settings.json",
          code: "ZIP_TOO_LARGE",
        }),
      ]);
    });

    it("a source field over its bound is SETTINGS_INVALID", async () => {
      const built = pkg({
        layoutVersion: 3,
        override: (f) =>
          f.set(
            "settings.json",
            exportSettings(f, (s) => {
              (s.source as Record<string, unknown>).exportedBy = "A".repeat(
                256,
              );
            }),
          ),
      });
      expect(codes(problemsOf(await gate(built.zip)))).toEqual([
        "SETTINGS_INVALID",
      ]);
    });
  });
});

describe("bm80 — stage 3 against an open DRAFT's own number (overwrite)", () => {
  // The type has an open layout DRAFT v2: an overwrite expects v2 again, not
  // max + 1.
  const OVERWRITE_CTX = { layoutCode: CODE, expectedVersionNo: 2 };

  it("a package exported as v2 passes stage 3", async () => {
    const built = pkg({ layoutVersion: 2 });
    const result = await checkLayoutPackage(
      built.zip,
      OVERWRITE_CTX,
      cleanRender(),
    );
    expect(result.ok).toBe(true);
  });

  it("a package numbered max + 1 is LAYOUT_VERSION_MISMATCH", async () => {
    const built = pkg({ layoutVersion: 3 });
    const problems = problemsOf(
      await checkLayoutPackage(built.zip, OVERWRITE_CTX, cleanRender()),
    );
    expect(problems).toEqual([
      expect.objectContaining({
        code: "LAYOUT_VERSION_MISMATCH",
        message: expect.stringMatching(/3.*2/),
      }),
    ]);
  });
});

describe("bm80 — matchExpectedDraft (the expected-draft table)", () => {
  const TOKEN = "2026-10-25T01:02:03.123456Z";
  const DRAFT = { billTemplateVersionId: "BTV00000010", token: TOKEN };

  it.each([
    ["{ none } and no layout DRAFT → create", null, { none: true }, "create"],
    [
      "{ none } and a layout DRAFT → stale (one appeared)",
      DRAFT,
      { none: true },
      "stale",
    ],
    [
      "that DRAFT with that token → overwrite",
      DRAFT,
      { versionId: "BTV00000010", lastModified: TOKEN },
      "overwrite",
    ],
    [
      "that DRAFT with a newer token → stale (overwritten since the warning)",
      { ...DRAFT, token: "2026-10-25T01:02:04.000001Z" },
      { versionId: "BTV00000010", lastModified: TOKEN },
      "stale",
    ],
    [
      "no layout DRAFT → stale (activated or discarded)",
      null,
      { versionId: "BTV00000010", lastModified: TOKEN },
      "stale",
    ],
    [
      "another DRAFT → stale (replaced)",
      { ...DRAFT, billTemplateVersionId: "BTV00000011" },
      { versionId: "BTV00000010", lastModified: TOKEN },
      "stale",
    ],
  ] as const)("%s", (_c, open, expected, mode) => {
    expect(matchExpectedDraft(open, expected)).toBe(mode);
  });
});

describe("bm78 layout package gate — stages 4–7 (collecting)", () => {
  it("LINT_VIOLATION: an onclick= attribute", async () => {
    const built = pkg({
      edit: (f) =>
        replaceInFile(f, "partials/header.hbs", "<h1>", '<h1 onclick="x()">'),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "LINT_VIOLATION",
        file: "partials/header.hbs",
        message: expect.stringContaining("event-handler"),
      }),
    ]);
  });

  it("LINT_VIOLATION: an entity-escaped URL", async () => {
    const built = pkg({
      edit: (f) =>
        replaceInFile(
          f,
          "partials/header.hbs",
          "<h1>Invoice</h1>",
          '<h1>Invoice</h1><img src="&#104;ttp&#58;&#47;&#47;x/a.png" alt="" />',
        ),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "LINT_VIOLATION",
        file: "partials/header.hbs",
        message: expect.stringContaining("hidden behind entities"),
      }),
    ]);
  });

  it("LAYOUT_MISSING_REQUIRED_BLOCKS: the supplier TIN removed", async () => {
    const built = pkg({
      edit: (f) =>
        replaceInFile(
          f,
          "partials/header.hbs",
          "<div>TIN {{company.tin}}</div>",
          "",
        ),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["LAYOUT_MISSING_REQUIRED_BLOCKS"]);
    expect(problems[0]!.message).toContain("TIN");
  });

  it("COMPILE_FAILED: {{customer.nmae}}", async () => {
    const built = pkg({
      edit: (f) =>
        replaceInFile(
          f,
          "partials/billTo.hbs",
          "<div>{{customer.name}}</div>",
          "<div>{{customer.name}}</div><div>{{customer.nmae}}</div>",
        ),
    });
    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems)).toEqual(["COMPILE_FAILED"]);
    expect(problems.some((p) => p.message.includes("nmae"))).toBe(true);
  });

  it("LAYOUT_EXTERNAL_FETCH: the probe render reports a blocked URL", async () => {
    const render = cleanRender(["http://x/a.png"]);
    const problems = problemsOf(await gate(pkg().zip, render));
    expect(problems).toEqual([
      expect.objectContaining({
        code: "LAYOUT_EXTERNAL_FETCH",
        file: "(render)",
        message: expect.stringContaining("http://x/a.png"),
      }),
    ]);
  });

  it("LAYOUT_EXTERNAL_FETCH lists at most 10 URLs", async () => {
    const urls = Array.from({ length: 12 }, (_, i) => `http://x/${i}.png`);
    const problems = problemsOf(await gate(pkg().zip, cleanRender(urls)));
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("12 URLs");
    expect(problems[0]!.message).toContain("http://x/9.png");
    expect(problems[0]!.message).not.toContain("http://x/10.png");
  });

  it("stages 4–5 collect: one fixture with an onclick= and the TIN removed reports both a LINT_VIOLATION and a LAYOUT_MISSING_REQUIRED_BLOCKS, and nothing is rendered", async () => {
    const render = cleanRender();
    const built = pkg({
      edit: (f) => {
        replaceInFile(f, "partials/header.hbs", "<h1>", '<h1 onclick="x()">');
        replaceInFile(
          f,
          "partials/header.hbs",
          "<div>TIN {{company.tin}}</div>",
          "",
        );
      },
    });
    const problems = problemsOf(
      await checkLayoutPackage(built.zip, CTX, render),
    );
    expect(codes(problems).sort()).toEqual([
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
      "LINT_VIOLATION",
    ]);
    // A broken template is never rendered (stage 7 needs 4–6 clean).
    expect(render).not.toHaveBeenCalled();
  });

  it("stages 4 and 6 collect: an onclick= and {{customer.nmae}} report LINT_VIOLATION and COMPILE_FAILED", async () => {
    const built = pkg({
      edit: (f) => {
        replaceInFile(f, "partials/header.hbs", "<h1>", '<h1 onclick="x()">');
        replaceInFile(
          f,
          "partials/billTo.hbs",
          "<div>{{customer.name}}</div>",
          "<div>{{customer.name}}</div><div>{{customer.nmae}}</div>",
        );
      },
    });
    const problems = problemsOf(await gate(built.zip));
    expect(codes(problems).sort()).toEqual([
      "COMPILE_FAILED",
      "LINT_VIOLATION",
    ]);
  });

  it("stage 7 collects: a blocked URL and a section the visible tier cannot see are both reported", async () => {
    const render = vi.fn<Render>(async (_html, probes) => {
      const report = cleanReport(probes);
      report.taxSummary = { present: false, count: 0, text: "", illegible: [] };
      return { report, blockedUrls: ["http://x/a.png"] };
    });
    const problems = problemsOf(await gate(pkg().zip, render));
    expect(codes(problems).sort()).toEqual([
      "LAYOUT_EXTERNAL_FETCH",
      "LAYOUT_MISSING_REQUIRED_BLOCKS",
    ]);
    expect(
      problems.find((p) => p.code === "LAYOUT_MISSING_REQUIRED_BLOCKS")!
        .message,
    ).toContain("taxSummary");
  });

  it("stage 7 merges blocked URLs from both probe renders (Payment on and off)", async () => {
    let call = 0;
    const render = vi.fn<Render>(async (_html, probes) => ({
      report: cleanReport(probes),
      blockedUrls: [`http://x/render-${++call}.png`],
    }));
    const problems = problemsOf(await gate(pkg().zip, render));
    expect(render).toHaveBeenCalledTimes(2);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.message).toContain("http://x/render-1.png");
    expect(problems[0]!.message).toContain("http://x/render-2.png");
  });

  it("the probe render is handed every compliance section to read", async () => {
    const render = cleanRender();
    await gate(pkg().zip, render);
    const probes = render.mock.calls[0]![1];
    expect(probes.map((p) => p.key)).toEqual([...COMPLIANCE_SECTION_KEYS]);
  });
});
