import { createHash } from "node:crypto";

import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

// bm53-spec §Design D2, §Tests row 2 — verify → compile → memo, over a mocked
// blob store serving an in-memory version directory.

const events: string[] = [];
const blobs = new Map<string, Buffer>();

vi.mock("@/services/billing/blob-store", () => ({
  blobStore: {
    parseBlobRef: (ref: string) => {
      const slash = ref.indexOf("/");
      return { container: ref.slice(0, slash), path: ref.slice(slash + 1) };
    },
    digest: (bytes: Buffer, algorithm: string) =>
      createHash(algorithm).update(bytes).digest("hex"),
    getObject: vi.fn(async (container: string, path: string) => {
      events.push(`get:${path.split("/").pop()}`);
      const bytes = blobs.get(`${container}/${path}`);
      if (!bytes) throw new Error(`404 ${container}/${path}`);
      return bytes;
    }),
  },
}));

vi.mock(
  "@/services/billing/invoice-template/compile",
  async (importOriginal) => {
    const actual = await importOriginal<typeof CompileModule>();
    return {
      ...actual,
      compileInvoiceTemplate: (source: string) => {
        events.push("compile");
        return actual.compileInvoiceTemplate(source);
      },
    };
  },
);

import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import type * as CompileModule from "@/services/billing/invoice-template/compile";
import { blobStore } from "@/services/billing/blob-store";
import {
  clearLoadedTemplateMemo,
  loadCsvMap,
  loadGenerated,
  loadedTemplateMemo,
  loadLayout,
  PROBE_RENDER_INPUT,
  type LoadedGeneratedTemplate,
} from "@/services/billing/invoice-template/load";
import { InvoiceRenderError } from "@/types/billing";
import { SEEDED_GENERATED_ROW } from "@/tests/helpers/seeded-invoice-template";

const mockGetObject = vi.mocked(blobStore.getObject);

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// Writes a version directory the way `write-checksums.ts` does (sorted keys,
// 2-space, trailing newline) and returns the row whose checksum is the index's
// SHA-256 — i.e. a consistent, untampered version.
function storeVersion(
  dir: string,
  files: Record<string, string>,
  { algorithm = "sha256" }: { algorithm?: string } = {},
): string {
  const index = {
    algorithm,
    files: Object.fromEntries(
      Object.keys(files)
        .sort()
        .map((name) => [name, sha256(Buffer.from(files[name]!))]),
    ),
  };
  const indexBytes = Buffer.from(`${JSON.stringify(index, null, 2)}\n`);
  for (const [name, text] of Object.entries(files)) {
    blobs.set(`invoice-templates/${dir}${name}`, Buffer.from(text));
  }
  blobs.set(`invoice-templates/${dir}checksums.json`, indexBytes);
  return sha256(indexBytes);
}

const GOOD_INVOICE = "<p>{{customer.name}} {{invoice.billRunId}}</p>";
const GOOD_FOOTER = "<span>{{customer.billingAccountId}}</span>";

function generatedRow(
  dir: string,
  checksum: string,
  overrides: Partial<BillTemplateVersion> = {},
): BillTemplateVersion {
  return {
    ...SEEDED_GENERATED_ROW,
    billTemplateVersionId: `BTV${dir.replace(/\D/g, "").padStart(8, "0")}`,
    blobRef: `invoice-templates/${dir}`,
    checksum,
    ...overrides,
  };
}

async function codeAndFile(
  p: Promise<unknown>,
): Promise<{ code: string; file?: unknown }> {
  try {
    await p;
  } catch (err) {
    if (err instanceof InvoiceRenderError) {
      return { code: err.code, file: err.detail?.file };
    }
    return { code: "untyped" };
  }
  return { code: "none" };
}

let seq = 0;
function freshDir(): string {
  seq += 1;
  return `generated/INVOICE/v${seq}/`;
}

beforeEach(() => {
  clearLoadedTemplateMemo();
  events.length = 0;
  blobs.clear();
  mockGetObject.mockClear();
});

describe("loadGenerated — verify, then compile, then memo", () => {
  it("loads a consistent version: verifies every byte before compiling", async () => {
    const dir = freshDir();
    const checksum = storeVersion(dir, {
      "invoice.hbs": GOOD_INVOICE,
      "footer.hbs": GOOD_FOOTER,
    });
    const loaded = await loadGenerated(generatedRow(dir, checksum));

    expect(loaded.invoice(PROBE_RENDER_INPUT)).toContain(
      "Probe Customer Sdn Bhd",
    );
    expect(loaded.structure).toEqual(SEEDED_GENERATED_ROW.structure);
    // Order: index, then both files, THEN the two compiles.
    expect(events).toEqual([
      "get:checksums.json",
      "get:invoice.hbs",
      "get:footer.hbs",
      "compile",
      "compile",
    ]);
  });

  it("verifies the real seeded default (repo bytes vs the migration checksum)", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = "generated/INVOICE/v1/";
    for (const name of ["checksums.json", "invoice.hbs", "footer.hbs"]) {
      blobs.set(
        `invoice-templates/${dir}${name}`,
        readFileSync(
          path.join(process.cwd(), "db/seeds/invoice-templates", dir, name),
        ),
      );
    }
    const loaded = await loadGenerated(SEEDED_GENERATED_ROW);
    expect(loaded.invoice(PROBE_RENDER_INPUT)).toContain("TAX INVOICE");
  });

  it("an index digest mismatch → TEMPLATE_CHECKSUM_MISMATCH naming checksums.json", async () => {
    const dir = freshDir();
    storeVersion(dir, {
      "invoice.hbs": GOOD_INVOICE,
      "footer.hbs": GOOD_FOOTER,
    });
    const result = await codeAndFile(
      loadGenerated(generatedRow(dir, "0".repeat(64))),
    );
    expect(result).toEqual({
      code: "TEMPLATE_CHECKSUM_MISMATCH",
      file: "checksums.json",
    });
    expect(events).not.toContain("compile");
  });

  it("one changed byte in a stored file → TEMPLATE_CHECKSUM_MISMATCH naming that file", async () => {
    const dir = freshDir();
    const checksum = storeVersion(dir, {
      "invoice.hbs": GOOD_INVOICE,
      "footer.hbs": GOOD_FOOTER,
    });
    const key = `invoice-templates/${dir}footer.hbs`;
    const tampered = Buffer.from(blobs.get(key)!);
    tampered[0] = tampered[0]! ^ 0x01;
    blobs.set(key, tampered);

    const result = await codeAndFile(
      loadGenerated(generatedRow(dir, checksum)),
    );
    expect(result).toEqual({
      code: "TEMPLATE_CHECKSUM_MISMATCH",
      file: "footer.hbs",
    });
    expect(events).not.toContain("compile");
  });

  it("an index algorithm that differs from the row's → TEMPLATE_CHECKSUM_MISMATCH", async () => {
    const dir = freshDir();
    // The index declares md5 (its own bytes still hash to the row checksum).
    const checksum = storeVersion(
      dir,
      { "invoice.hbs": GOOD_INVOICE, "footer.hbs": GOOD_FOOTER },
      { algorithm: "md5" },
    );
    const result = await codeAndFile(
      loadGenerated(generatedRow(dir, checksum)),
    );
    expect(result).toEqual({
      code: "TEMPLATE_CHECKSUM_MISMATCH",
      file: "checksums.json",
    });
  });

  it("a memo hit skips all blob I/O", async () => {
    const dir = freshDir();
    const row = generatedRow(
      dir,
      storeVersion(dir, {
        "invoice.hbs": GOOD_INVOICE,
        "footer.hbs": GOOD_FOOTER,
      }),
    );
    const first = await loadGenerated(row);
    mockGetObject.mockClear();
    const second = await loadGenerated(row);
    expect(second).toBe(first);
    expect(mockGetObject).not.toHaveBeenCalled();
  });

  it("a failed verify leaves no memo entry (a later load re-verifies)", async () => {
    const dir = freshDir();
    storeVersion(dir, {
      "invoice.hbs": GOOD_INVOICE,
      "footer.hbs": GOOD_FOOTER,
    });
    const row = generatedRow(dir, "f".repeat(64));
    await codeAndFile(loadGenerated(row));
    expect(loadedTemplateMemo.has(row.billTemplateVersionId)).toBe(false);
    mockGetObject.mockClear();
    await codeAndFile(loadGenerated(row));
    expect(mockGetObject).toHaveBeenCalled();
  });

  it.each([
    ["a parse error", "<p>{{#if customer.name}}unclosed</p>"],
    ["an unknown helper", "<p>{{shout customer.name}}</p>"],
    ["a strict-mode missing path", "<p>{{customer.nickname}}</p>"],
  ])(
    "%s surfaces at load as TEMPLATE_COMPILE_FAILED (and is not memoized)",
    async (_label, source) => {
      const dir = freshDir();
      const row = generatedRow(
        dir,
        storeVersion(dir, { "invoice.hbs": source, "footer.hbs": GOOD_FOOTER }),
      );
      expect((await codeAndFile(loadGenerated(row))).code).toBe(
        "TEMPLATE_COMPILE_FAILED",
      );
      expect(loadedTemplateMemo.has(row.billTemplateVersionId)).toBe(false);
    },
  );

  it("a DRAFT / wrong-kind row is refused without blob I/O", async () => {
    for (const overrides of [
      { status: "DRAFT", blobRef: null, checksum: null },
      { kind: "csv" },
    ] as Partial<BillTemplateVersion>[]) {
      const result = await codeAndFile(
        loadGenerated(generatedRow(freshDir(), "a".repeat(64), overrides)),
      );
      expect(result.code).toBe("TEMPLATE_VERSION_NOT_FOUND");
    }
    expect(mockGetObject).not.toHaveBeenCalled();
  });
});

describe("the memo — the one sanctioned cache (data rule 8)", () => {
  it("holds only verified, compiled generated templates", async () => {
    expectTypeOf(loadedTemplateMemo).toEqualTypeOf<
      ReadonlyMap<string, LoadedGeneratedTemplate>
    >();
    const dir = freshDir();
    await loadGenerated(
      generatedRow(
        dir,
        storeVersion(dir, {
          "invoice.hbs": GOOD_INVOICE,
          "footer.hbs": GOOD_FOOTER,
        }),
      ),
    );
    for (const value of loadedTemplateMemo.values()) {
      expect(Object.keys(value).sort()).toEqual([
        "footer",
        "invoice",
        "structure",
      ]);
      expect(typeof value.invoice).toBe("function");
      expect(typeof value.footer).toBe("function");
    }
  });
});

describe("loadLayout / loadCsvMap", () => {
  it("loadLayout returns every verified file of the layout", async () => {
    const dir = "layouts/INVTPL-TEST/v1/";
    const checksum = storeVersion(dir, {
      "manifest.json": "{}",
      "shell.hbs": "<html></html>",
      "partials/header.hbs": "<h1></h1>",
    });
    const files = await loadLayout(
      generatedRow(dir, checksum, { kind: "layout", structure: null }),
    );
    expect([...files.keys()].sort()).toEqual([
      "manifest.json",
      "partials/header.hbs",
      "shell.hbs",
    ]);
    expect(files.get("shell.hbs")!.toString()).toBe("<html></html>");
  });

  it("loadLayout detects a tampered layout file", async () => {
    const dir = "layouts/INVTPL-TEST/v2/";
    const checksum = storeVersion(dir, { "shell.hbs": "<html></html>" });
    blobs.set(
      `invoice-templates/${dir}shell.hbs`,
      Buffer.from("<html> </html>"),
    );
    const result = await codeAndFile(
      loadLayout(generatedRow(dir, checksum, { kind: "layout" })),
    );
    expect(result).toEqual({
      code: "TEMPLATE_CHECKSUM_MISMATCH",
      file: "shell.hbs",
    });
  });

  it("loadCsvMap verifies and parses the seeded CSV v1 column map", async () => {
    const { readFileSync } = await import("node:fs");
    const path = await import("node:path");
    const dir = "system/csv/v1/";
    for (const name of ["checksums.json", "invoice.csv.columns.json"]) {
      blobs.set(
        `invoice-templates/${dir}${name}`,
        readFileSync(
          path.join(process.cwd(), "db/seeds/invoice-templates", dir, name),
        ),
      );
    }
    const map = await loadCsvMap(
      generatedRow(
        dir,
        "ef31c2f1b96d6f6278fe2a0e4f657755c8c75bf17eab105bd3da7d0c8e579c05",
        { kind: "csv", structure: null },
      ),
    );
    expect(map.rowSource).toBe("lines");
    expect(map.columns.length).toBeGreaterThan(0);
  });
});
