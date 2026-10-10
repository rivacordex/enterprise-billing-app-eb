import { beforeEach, describe, expect, it, vi } from "vitest";

// bm60-spec §Tests — GUARDRAIL 52: every bad logo is rejected server-side with
// its own `LOGO_REJECTED` reason, in data rule 9 order (size → mime →
// dimensions → svg_content), with NOTHING written: no draft lookup, no blob,
// no row, no audit. Plus the happy path's call order and audit payload.

vi.mock("@/db/client", () => ({
  db: { transaction: vi.fn((fn: (tx: unknown) => unknown) => fn({})) },
}));
vi.mock("@/db/repositories/audit.repository", () => ({
  insertAuditEvent: vi.fn(),
}));
vi.mock("@/db/repositories/billing/bill-asset", () => ({
  billAssetRepository: { ensureLogoAsset: vi.fn(), insertVersion: vi.fn() },
}));
vi.mock("@/db/repositories/billing/invoice-profile", () => ({
  invoiceProfileRepository: {
    findDraftVersion: vi.fn(),
    setDraftLogo: vi.fn(),
  },
}));
vi.mock("@/services/billing/blob-store", async () => {
  const { createHash } = await import("node:crypto");
  return {
    blobStore: {
      digest: (b: Buffer, a: string) => createHash(a).update(b).digest("hex"),
      putObject: vi.fn(),
    },
  };
});
vi.mock("@/services/system-config/app-config-read.service", () => ({
  getBrandingLogo: vi.fn(),
}));

import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billAssetRepository } from "@/db/repositories/billing/bill-asset";
import { invoiceProfileRepository } from "@/db/repositories/billing/invoice-profile";
import { blobStore } from "@/services/billing/blob-store";
import {
  checkLogo,
  uploadLogo,
} from "@/services/billing/invoice-profile/upload-logo";
import { jpeg, png, svg } from "@/tests/helpers/logo-fixtures";

const TOKEN = "2026-10-10T01:02:03.123456Z";
const ACTOR = "actor-1";

function expectNothingWritten(): void {
  expect(invoiceProfileRepository.findDraftVersion).not.toHaveBeenCalled();
  expect(billAssetRepository.ensureLogoAsset).not.toHaveBeenCalled();
  expect(blobStore.putObject).not.toHaveBeenCalled();
  expect(billAssetRepository.insertVersion).not.toHaveBeenCalled();
  expect(invoiceProfileRepository.setDraftLogo).not.toHaveBeenCalled();
  expect(insertAuditEvent).not.toHaveBeenCalled();
}

async function rejects(
  bytes: Buffer,
  declaredMime: string,
): Promise<{ reason: string; detail: Record<string, unknown> }> {
  const result = await uploadLogo(
    { bytes, declaredMime, expectedDraftToken: TOKEN },
    ACTOR,
  );
  if (result.ok || result.code !== "LOGO_REJECTED") {
    throw new Error(`expected LOGO_REJECTED, got ${JSON.stringify(result)}`);
  }
  expectNothingWritten();
  return result;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("guardrail 52 — logo rejections, each with its reason, nothing written", () => {
  it("> 500 KB → size (with the actual byte count)", async () => {
    const r = await rejects(png(400, 400, 512_001), "image/png");
    expect(r).toMatchObject({
      reason: "size",
      detail: { byteSize: 512_001 },
    });
  });

  it("exactly 500 KB is within the limit", () => {
    expect(checkLogo(png(400, 400, 512_000), "image/png")).toMatchObject({
      ok: true,
    });
  });

  it("0 bytes → size", async () => {
    expect(await rejects(Buffer.alloc(0), "image/png")).toMatchObject({
      reason: "size",
      detail: { byteSize: 0 },
    });
  });

  it.each([
    ["PNG", png(299, 800), "image/png"],
    ["JPEG", jpeg(1000, 120), "image/jpeg"],
    ["SVG", svg('viewBox="0 0 1000 200"'), "image/svg+xml"],
  ])("< 300 px %s → dimensions (with w×h)", async (_label, bytes, mime) => {
    const r = await rejects(bytes, mime);
    expect(r.reason).toBe("dimensions");
    expect(r.detail).toHaveProperty("width");
    expect(r.detail).toHaveProperty("height");
  });

  it("SVG sizes in other units → dimensions", async () => {
    expect(
      await rejects(svg('width="80mm" height="80mm"'), "image/svg+xml"),
    ).toMatchObject({ reason: "dimensions" });
  });

  it("PNG bytes declared image/svg+xml → mime (declared vs detected)", async () => {
    expect(await rejects(png(400, 400), "image/svg+xml")).toMatchObject({
      reason: "mime",
      detail: { declared: "image/svg+xml", detected: "image/png" },
    });
  });

  it("SVG declared image/png → mime", async () => {
    expect(await rejects(svg(), "image/png")).toMatchObject({
      reason: "mime",
      detail: { declared: "image/png", detected: "image/svg+xml" },
    });
  });

  it.each([
    ["a GIF", Buffer.from("GIF89a................"), "image/gif"],
    ["text declared PNG", Buffer.from("hello"), "image/png"],
  ])("%s → mime", async (_label, bytes, mime) => {
    expect(await rejects(bytes, mime)).toMatchObject({ reason: "mime" });
  });

  it.each<[string, string, string]>([
    ["<script>", 'width="400" height="400"', "<script>alert(1)</script>"],
    ["onload=", 'width="400" height="400" onload="alert(1)"', ""],
    ["onclick =", 'width="400" height="400"', '<rect onclick = "x()"/>'],
    [
      "<foreignObject>",
      'width="400" height="400"',
      "<foreignObject><div/></foreignObject>",
    ],
    ["<iframe>", 'width="400" height="400"', "<iframe/>"],
    ["<embed>", 'width="400" height="400"', "<embed/>"],
    ["<object>", 'width="400" height="400"', "<object/>"],
    [
      "external href",
      'width="400" height="400"',
      '<a href="https://evil.example"><rect/></a>',
    ],
    [
      'xlink:href="http…"',
      'width="400" height="400"',
      '<use xlink:href="http://evil.example/x.svg#a"/>',
    ],
    [
      "<image> with an external href",
      'width="400" height="400"',
      '<image href="//evil.example/x.png"/>',
    ],
    [
      "url(http…)",
      'width="400" height="400"',
      '<rect fill="url(http://evil.example/p)"/>',
    ],
    [
      "javascript:",
      'width="400" height="400"',
      '<a href="#x"><text>javascript:alert(1)</text></a>',
    ],
    [
      "data:",
      'width="400" height="400"',
      '<rect fill="url(#g)"/><text>data:text/html,x</text>',
    ],
    ["@import", 'width="400" height="400"', "<style>@import 'x.css';</style>"],
    [
      "<style> with url(#…)",
      'width="400" height="400"',
      "<style>.a { fill: url(#g) }</style>",
    ],
  ])("SVG with %s → svg_content", async (_label, attrs, body) => {
    const r = await rejects(svg(attrs, body), "image/svg+xml");
    expect(r.reason).toBe("svg_content");
    expect(typeof r.detail.construct).toBe("string");
  });

  it("SVG with <!DOCTYPE> → svg_content", async () => {
    const r = await rejects(
      svg(
        'width="400" height="400"',
        "<rect/>",
        '<?xml version="1.0"?>\n<!DOCTYPE svg [<!ENTITY x "y">]>\n',
      ),
      "image/svg+xml",
    );
    expect(r).toMatchObject({
      reason: "svg_content",
      detail: { construct: "<!DOCTYPE>" },
    });
  });

  it("accepts fragment-only references: href=#, xlink:href=#, url(#)", () => {
    const ok = svg(
      'width="400" height="400" xmlns:xlink="http://www.w3.org/1999/xlink"',
      '<defs><linearGradient id="g"/></defs><use href="#g"/><use xlink:href=\'#g\'/><rect fill="url(#g)"/>',
    );
    expect(checkLogo(ok, "image/svg+xml")).toMatchObject({ ok: true });
  });

  it("check order: an oversized SVG with a script reports size", async () => {
    const big = svg(
      'width="10" height="10"',
      `<script>x</script><!--${"x".repeat(520_000)}-->`,
    );
    expect(await rejects(big, "image/svg+xml")).toMatchObject({
      reason: "size",
    });
  });

  it("check order: a too-small SVG with a script reports dimensions", async () => {
    expect(
      await rejects(
        svg('width="10" height="10"', "<script>x</script>"),
        "image/svg+xml",
      ),
    ).toMatchObject({ reason: "dimensions" });
  });
});

describe("uploadLogo — the stored path (D5/D6)", () => {
  const ASSET = { billAssetId: "INVAST00000001" };
  const VERSION = {
    billAssetVersionId: "INVASV00000007",
    versionNo: 3,
    mime: "image/png",
    width: 400,
    height: 300,
    byteSize: 58,
    checksum: "",
  };

  beforeEach(() => {
    vi.mocked(invoiceProfileRepository.findDraftVersion).mockResolvedValue({
      configVersion: 4,
      token: TOKEN,
    });
    vi.mocked(billAssetRepository.ensureLogoAsset).mockResolvedValue(
      ASSET as never,
    );
    vi.mocked(blobStore.putObject).mockImplementation(
      async (container, path, bytes) => ({
        blobRef: `${container}/${path}`,
        checksum: blobStore.digest(bytes, "sha256"),
        checksumAlgorithm: "sha256",
        created: true,
      }),
    );
    vi.mocked(billAssetRepository.insertVersion).mockImplementation(
      async (_tx, input) =>
        ({
          ...VERSION,
          checksum: input.checksum,
          byteSize: input.byteSize,
        }) as never,
    );
    vi.mocked(invoiceProfileRepository.setDraftLogo).mockResolvedValue({
      configVersion: 4,
      previousLogoAssetVersionId: "INVASV00000002",
      token: "2026-10-10T01:02:04.000000Z",
    });
  });

  it("writes write-once at the content-addressed path, then version → draft pointer → audit", async () => {
    const bytes = png(400, 300);
    const digest = blobStore.digest(bytes, "sha256");
    const result = await uploadLogo(
      { bytes, declaredMime: "image/png", expectedDraftToken: TOKEN },
      ACTOR,
    );
    expect(result).toEqual({
      ok: true,
      assetVersionId: "INVASV00000007",
      versionNo: 3,
      draftVersion: 4,
      draftToken: "2026-10-10T01:02:04.000000Z",
    });
    expect(blobStore.putObject).toHaveBeenCalledWith(
      "invoice-assets",
      `INVAST00000001/sha256-${digest.slice(0, 12)}/logo.png`,
      bytes,
      "image/png",
      {
        writeOnce: true,
        onExists: "returnExisting",
        checksumAlgorithm: "sha256",
      },
    );
    // The stored bytes ARE the uploaded bytes (no repair).
    expect(vi.mocked(blobStore.putObject).mock.calls[0]![2]).toBe(bytes);
    expect(billAssetRepository.insertVersion).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        assetId: "INVAST00000001",
        mime: "image/png",
        width: 400,
        height: 300,
        byteSize: bytes.length,
        checksum: digest,
        actor: ACTOR,
      }),
    );
    expect(insertAuditEvent).toHaveBeenCalledTimes(1);
    expect(insertAuditEvent).toHaveBeenCalledWith(
      {},
      expect.objectContaining({
        eventType: "INVOICE_LOGO_UPLOADED",
        targetEntity: "BILL_ASSET_VERSION",
        targetId: "INVASV00000007",
        beforeData: { previousDraftLogoAssetVersionId: "INVASV00000002" },
        afterData: expect.objectContaining({
          assetId: "INVAST00000001",
          assetVersionId: "INVASV00000007",
          versionNo: 3,
          profileDraftVersion: 4,
          checksum: digest,
        }),
      }),
    );
  });

  it("no draft, or a stale token, is DRAFT_CONFLICT before any blob write", async () => {
    vi.mocked(invoiceProfileRepository.findDraftVersion).mockResolvedValue(
      null,
    );
    expect(
      await uploadLogo(
        {
          bytes: png(400, 300),
          declaredMime: "image/png",
          expectedDraftToken: TOKEN,
        },
        ACTOR,
      ),
    ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    expect(blobStore.putObject).not.toHaveBeenCalled();
  });

  it("a lost race inside the transaction is DRAFT_CONFLICT with no audit", async () => {
    vi.mocked(invoiceProfileRepository.setDraftLogo).mockResolvedValue(null);
    expect(
      await uploadLogo(
        {
          bytes: png(400, 300),
          declaredMime: "image/png",
          expectedDraftToken: TOKEN,
        },
        ACTOR,
      ),
    ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
    expect(insertAuditEvent).not.toHaveBeenCalled();
  });

  it("a different blob at the content-addressed path is ACTIVATION_BLOB_CONFLICT, nothing recorded", async () => {
    vi.mocked(blobStore.putObject).mockResolvedValue({
      blobRef: "invoice-assets/x",
      checksum: "0".repeat(64),
      checksumAlgorithm: "sha256",
      created: false,
    });
    expect(
      await uploadLogo(
        {
          bytes: png(400, 300),
          declaredMime: "image/png",
          expectedDraftToken: TOKEN,
        },
        ACTOR,
      ),
    ).toEqual({ ok: false, code: "ACTIVATION_BLOB_CONFLICT" });
    expect(billAssetRepository.insertVersion).not.toHaveBeenCalled();
    expect(insertAuditEvent).not.toHaveBeenCalled();
  });
});
