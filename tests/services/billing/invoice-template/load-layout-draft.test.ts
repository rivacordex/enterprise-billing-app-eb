import { createHash } from "node:crypto";

import { beforeEach, describe, expect, it, vi } from "vitest";

// bm78-spec §5 / §13 (Inv #61, guardrail 70 — CRITICAL regression):
// `loadLayoutDraft` is the ONLY loader that accepts a DRAFT. It verifies the
// draft row's CURRENT checksum and every file, accepts only a stored layout
// DRAFT, and is never memoized; `loadLayout` and `loadGenerated` still refuse
// a DRAFT. The blob store is an in-memory map serving a package
// built from INVTPL-BASIC-A4 v1.

vi.mock("@/services/billing/blob-store", async () =>
  (
    await import("@/tests/helpers/in-memory-blob-store")
  ).inMemoryBlobStoreModule(),
);

import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import {
  clearLoadedTemplateMemo,
  loadedTemplateMemo,
  loadGenerated,
  loadLayout,
  loadLayoutDraft,
  loadLayoutForExport,
} from "@/services/billing/invoice-template/load";
import { memoryBlobs as blobs } from "@/tests/helpers/in-memory-blob-store";
import { buildLayoutPackage } from "@/tests/helpers/layout-package";
import {
  SEEDED_GENERATED_ROW,
  SEEDED_LAYOUT_ROW,
} from "@/tests/helpers/seeded-invoice-template";
import { InvoiceRenderError } from "@/types/billing";

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");
const DIR = "layouts/INVTPL-WHOLESALE/v1-abcdef012345/";

// Store the package's files under DIR and return a layout DRAFT row whose
// checksum is the stored index's digest.
function storeDraft(
  overrides: Partial<BillTemplateVersion> = {},
): BillTemplateVersion {
  const built = buildLayoutPackage({
    layoutCode: "INVTPL-WHOLESALE",
    layoutVersion: 1,
  });
  for (const [name, bytes] of built.files) {
    blobs.set(`invoice-templates/${DIR}${name}`, bytes);
  }
  return {
    ...SEEDED_LAYOUT_ROW,
    billTemplateVersionId: "BTV00000078",
    status: "DRAFT",
    isDefault: false,
    layoutCode: "INVTPL-WHOLESALE",
    refBillTemplateFamilyId: "BTF00000002",
    blobRef: `invoice-templates/${DIR}`,
    checksum: sha256(built.indexBytes!),
    checksumAlgorithm: "sha256",
    activatedBy: null,
    activatedDatetime: null,
    ...overrides,
  };
}

async function errorCode(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (err) {
    return err instanceof InvoiceRenderError ? err.code : "untyped";
  }
  return "none";
}

beforeEach(() => {
  blobs.clear();
  clearLoadedTemplateMemo();
});

describe("bm78 loadLayoutDraft (Inv #61)", () => {
  it("verifies a stored layout DRAFT and returns every file in its index", async () => {
    const row = storeDraft();
    const files = await loadLayoutDraft(row);
    const expected = buildLayoutPackage({
      layoutCode: "INVTPL-WHOLESALE",
      layoutVersion: 1,
    }).files;
    // Every file the index lists (the index itself is not one of them).
    expect([...files.keys()].sort()).toEqual(
      [...expected.keys()].filter((n) => n !== "checksums.json").sort(),
    );
    expect(
      files
        .get("partials/header.hbs")
        ?.equals(expected.get("partials/header.hbs")!),
    ).toBe(true);
  });

  it("throws TEMPLATE_CHECKSUM_MISMATCH when a stored file was changed", async () => {
    const row = storeDraft();
    blobs.set(
      `invoice-templates/${DIR}partials/header.hbs`,
      Buffer.from("<section>tampered</section>"),
    );
    expect(await errorCode(loadLayoutDraft(row))).toBe(
      "TEMPLATE_CHECKSUM_MISMATCH",
    );
  });

  it("throws TEMPLATE_CHECKSUM_MISMATCH when the row's CURRENT checksum is not the index's", async () => {
    const row = storeDraft({ checksum: "0".repeat(64) });
    expect(await errorCode(loadLayoutDraft(row))).toBe(
      "TEMPLATE_CHECKSUM_MISMATCH",
    );
  });

  it.each([
    ["an ACTIVE layout", { status: "ACTIVE" }],
    ["a RETIRED layout", { status: "RETIRED" }],
    ["a generated DRAFT", { kind: "generated" }],
    ["a DRAFT with no blob_ref", { blobRef: null }],
    ["a DRAFT with no checksum", { checksum: null }],
    ["a DRAFT with no checksum algorithm", { checksumAlgorithm: null }],
  ] as const)(
    "refuses %s with TEMPLATE_VERSION_NOT_FOUND",
    async (_label, overrides) => {
      const row = storeDraft(overrides as Partial<BillTemplateVersion>);
      expect(await errorCode(loadLayoutDraft(row))).toBe(
        "TEMPLATE_VERSION_NOT_FOUND",
      );
    },
  );

  it("is never memoized: the memo is unchanged after loadLayoutDraft", async () => {
    const before = new Map(loadedTemplateMemo);
    await loadLayoutDraft(storeDraft());
    await loadLayoutDraft(storeDraft());
    expect(new Map(loadedTemplateMemo)).toEqual(before);
    expect(loadedTemplateMemo.has("BTV00000078")).toBe(false);
  });
});

describe("bm78 every other loader still refuses a DRAFT (guardrail 70)", () => {
  it("loadLayout handed a stored layout DRAFT throws TEMPLATE_VERSION_NOT_FOUND", async () => {
    expect(await errorCode(loadLayout(storeDraft()))).toBe(
      "TEMPLATE_VERSION_NOT_FOUND",
    );
  });

  it("loadGenerated handed a generated DRAFT throws TEMPLATE_VERSION_NOT_FOUND and memoizes nothing", async () => {
    const draft: BillTemplateVersion = {
      ...SEEDED_GENERATED_ROW,
      billTemplateVersionId: "BTV00000079",
      status: "DRAFT",
      isDefault: false,
    };
    expect(await errorCode(loadGenerated(draft))).toBe(
      "TEMPLATE_VERSION_NOT_FOUND",
    );
    expect(loadedTemplateMemo.has("BTV00000079")).toBe(false);
  });
});

describe("bm81 loadLayoutForExport (Inv #68)", () => {
  function expectedFiles(): Map<string, Buffer> {
    return buildLayoutPackage({
      layoutCode: "INVTPL-WHOLESALE",
      layoutVersion: 1,
    }).files;
  }

  it.each([
    ["a DRAFT row (through loadLayoutDraft)", "DRAFT" as const],
    ["an ACTIVE row", "ACTIVE" as const],
  ])(
    "returns every file plus the verified checksums.json for %s",
    async (_c, status) => {
      const row = storeDraft(
        status === "ACTIVE"
          ? { status, activatedDatetime: new Date("2026-10-25T00:00:00Z") }
          : {},
      );
      const files = await loadLayoutForExport(row);
      const expected = expectedFiles();
      expect([...files.keys()].sort()).toEqual([...expected.keys()].sort());
      for (const [name, bytes] of expected) {
        expect(files.get(name)?.equals(bytes)).toBe(true);
      }
      expect(sha256(files.get("checksums.json")!)).toBe(row.checksum);
    },
  );

  it("loadLayout still never returns checksums.json", async () => {
    const row = storeDraft({
      status: "ACTIVE",
      activatedDatetime: new Date("2026-10-25T00:00:00Z"),
    });
    expect((await loadLayout(row)).has("checksums.json")).toBe(false);
    expect((await loadLayoutDraft(storeDraft())).has("checksums.json")).toBe(
      false,
    );
  });

  it("a tampered file throws TEMPLATE_CHECKSUM_MISMATCH naming it", async () => {
    const row = storeDraft();
    blobs.set(
      `invoice-templates/${DIR}partials/header.hbs`,
      Buffer.from("tampered"),
    );
    await expect(loadLayoutForExport(row)).rejects.toMatchObject({
      code: "TEMPLATE_CHECKSUM_MISMATCH",
      detail: { file: "partials/header.hbs" },
    });
  });

  it("a generated row is refused (assertLoadable still applies off the DRAFT path)", async () => {
    expect(await errorCode(loadLayoutForExport(SEEDED_GENERATED_ROW))).toBe(
      "TEMPLATE_VERSION_NOT_FOUND",
    );
  });
});
