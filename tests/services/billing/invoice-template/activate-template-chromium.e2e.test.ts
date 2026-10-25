import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// bm79-spec §9 (Inv #63, #64) — activation re-runs the compliance check on a
// pair's layout DRAFT with the REAL probe render (bm75's hardened page), so
// gated behind RUN_CHROMIUM_E2E=1:
//
//   RUN_CHROMIUM_E2E=1 node --env-file=.env.test node_modules/vitest/vitest.mjs run \
//     tests/services/billing/invoice-template/activate-template-chromium.e2e.test.ts
//
// The layout DRAFT carries a `background:url(http://127.0.0.1:<port>/x)` the
// upload gate never saw (a row that reached DRAFT by bypassing it). DB-free,
// like the bm78 gate e2e: the type, the settings DRAFT and the layout DRAFT
// come from repository stand-ins and the layout's files from an in-memory blob
// store. The URL is split by an empty built-in block, so the raw-text lint
// passes and stage 7 is what refuses it (see upload-gate-chromium.e2e.test.ts).
// Activation is LAYOUT_REJECTED, writes no blob, opens no transaction, and
// the local stub server records no hit.

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

const hoisted = vi.hoisted(() => ({
  blobs: new Map<string, Buffer>(),
  putObject: vi.fn(),
  transaction: vi.fn(),
  family: null as unknown,
  draft: null as unknown,
  layout: null as unknown,
}));

vi.mock("@/db/client", () => ({ db: { transaction: hoisted.transaction } }));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: {
    digest: (bytes: Buffer, algorithm: string) =>
      createHash(algorithm).update(bytes).digest("hex"),
    parseBlobRef: (ref: string) => {
      const slash = ref.indexOf("/");
      return { container: ref.slice(0, slash), path: ref.slice(slash + 1) };
    },
    getObject: async (container: string, path: string) => {
      const bytes = hoisted.blobs.get(`${container}/${path}`);
      if (!bytes)
        throw Object.assign(new Error("missing"), { statusCode: 404 });
      return bytes;
    },
    putObject: hoisted.putObject,
  },
}));
vi.mock("@/db/repositories/billing/bill-template-family", () => ({
  billTemplateFamilyRepository: { findById: async () => hoisted.family },
}));
vi.mock(
  "@/db/repositories/billing/bill-template-version",
  async (importOriginal) => ({
    ...(await importOriginal<object>()),
    billTemplateVersionRepository: {
      findDraft: async () => hoisted.draft,
      findById: async () => hoisted.layout,
    },
  }),
);

import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { lintLayoutTemplates } from "@/services/billing/invoice-template/compliance";
import {
  buildLayoutPackage,
  replaceInFile,
} from "@/tests/helpers/layout-package";

const run = process.env.RUN_CHROMIUM_E2E === "1";
const TOKEN = "2026-10-25T01:02:03.123456Z";
const BLOB_REF = "invoice-templates/layouts/INVTPL-WHOLESALE/v1-bypass/";

describe.skipIf(!run)(
  "bm79 activate a pair — real Chromium compliance re-run (RUN_CHROMIUM_E2E=1)",
  () => {
    let server: Server;
    let hits = 0;
    let origin: string;

    beforeAll(async () => {
      server = createServer((_req, res) => {
        hits++;
        res.writeHead(200, { "content-type": "image/png" });
        res.end();
      });
      await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
      origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    });

    afterAll(async () => {
      if (server) await new Promise<void>((r) => server.close(() => r()));
    });

    it("a layout DRAFT that fetches an external URL is refused LAYOUT_REJECTED at activation; nothing is written and the stub server sees no hit", async () => {
      const split = `${origin.replace("http://", "http{{#if company}}{{/if}}://")}/x`;
      const style = `<div class="bm79-fetch" style="width:20px;height:20px;background:url(${split})"></div>`;
      const built = buildLayoutPackage({
        layoutCode: "INVTPL-WHOLESALE",
        layoutVersion: 1,
        edit: (f) =>
          replaceInFile(
            f,
            "partials/header.hbs",
            "<h1>Invoice</h1>",
            `<h1>Invoice</h1>${style}`,
          ),
      });
      expect(
        lintLayoutTemplates({
          "partials/header.hbs": built.files
            .get("partials/header.hbs")!
            .toString("utf-8"),
        }),
      ).toEqual([]);
      for (const [name, bytes] of built.files) {
        hoisted.blobs.set(`${BLOB_REF}${name}`, bytes);
      }

      hoisted.family = {
        billTemplateFamilyId: "BTF00000002",
        code: "WHOLESALE",
        layoutCode: "INVTPL-WHOLESALE",
        retiredDatetime: null,
      };
      hoisted.layout = {
        billTemplateVersionId: "BTV00000010",
        kind: "layout",
        status: "DRAFT",
        versionNo: 1,
        refBillTemplateFamilyId: "BTF00000002",
        blobRef: BLOB_REF,
        checksum: sha256(built.indexBytes!),
        checksumAlgorithm: "sha256",
      };
      hoisted.draft = {
        billTemplateVersionId: "BTV00000011",
        kind: "generated",
        status: "DRAFT",
        versionNo: 1,
        refBillTemplateFamilyId: "BTF00000002",
        refLayoutVersionId: "BTV00000010",
        structure: {
          sections: { payment: true },
          columns: {},
          footnote: ["Calculations are done in Mbps"],
        },
        token: TOKEN,
      };

      const result = await activateTemplate(
        {
          draftId: "BTV00000011",
          expectedDraftToken: TOKEN,
          changeNote: "Wholesale layout",
          familyId: "BTF00000002",
        },
        "bm79-actor",
      );
      expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
      if (result.ok || result.code !== "LAYOUT_REJECTED") return;
      expect(result.problems).toEqual([
        expect.objectContaining({
          code: "LAYOUT_EXTERNAL_FETCH",
          file: "(render)",
          message: expect.stringContaining(`${origin}/x`),
        }),
      ]);
      expect(hoisted.putObject).not.toHaveBeenCalled();
      expect(hoisted.transaction).not.toHaveBeenCalled();
      expect(hits).toBe(0);
    }, 120_000);
  },
);
