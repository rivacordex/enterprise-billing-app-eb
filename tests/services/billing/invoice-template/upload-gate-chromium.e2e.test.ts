import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

// bm78-spec §13 (guardrail 74, gate half; Inv #64) — the upload gate with the
// REAL probe render (`renderAndReadSections` through bm75's hardened page), so
// gated behind RUN_CHROMIUM_E2E=1:
//
//   RUN_CHROMIUM_E2E=1 node --env-file=.env.test node_modules/vitest/vitest.mjs run \
//     tests/services/billing/invoice-template/upload-gate-chromium.e2e.test.ts
//
// 1. INVTPL-BASIC-A4 passes the whole gate.
// 2. The same package with a `background:url(http://127.0.0.1:<port>/x)` on a
//    visible element fails LAYOUT_EXTERNAL_FETCH, and the local stub server
//    records no hit. The static lint (stage 4) refuses a literal
//    `url(http…` / `url(//…` and its entity / CSS-escape spellings, so the
//    URL here is split by an empty built-in block —
//    `url(http{{#if company}}{{/if}}://…)` — which no raw-text rule sees but
//    Handlebars renders to a plain external URL. That is exactly the fetch the
//    static tier cannot rule out and stage 7 (defence in depth) exists for.

vi.mock("@/db/client", () => ({ db: {} }));
vi.mock("@/services/billing/blob-store", () => ({
  blobStore: {
    digest: (bytes: Buffer, algorithm: string) =>
      createHash(algorithm).update(bytes).digest("hex"),
  },
}));

import { renderAndReadSections } from "@/services/billing/invoice-template/compliance-render";
import { lintLayoutTemplates } from "@/services/billing/invoice-template/compliance";
import { checkLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import {
  buildLayoutPackage,
  replaceInFile,
} from "@/tests/helpers/layout-package";

const run = process.env.RUN_CHROMIUM_E2E === "1";
const CODE = "INVTPL-BASIC-A4";
const CTX = { layoutCode: CODE, expectedVersionNo: 1 };

describe.skipIf(!run)(
  "bm78 upload gate — real Chromium probe render (RUN_CHROMIUM_E2E=1)",
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

    it("a real gate run over INVTPL-BASIC-A4 passes", async () => {
      const built = buildLayoutPackage({ layoutCode: CODE, layoutVersion: 1 });
      const result = await checkLayoutPackage(built.zip, CTX);
      if (!result.ok) {
        throw new Error(`gate refused: ${JSON.stringify(result.problems)}`);
      }
      expect(result.ok).toBe(true);
    }, 120_000);

    it("a layout that fetches an external URL fails LAYOUT_EXTERNAL_FETCH at the render stage; the stub server sees no hit", async () => {
      const split = `${origin.replace("http://", "http{{#if company}}{{/if}}://")}/x`;
      const style = `<div class="bm78-fetch" style="width:20px;height:20px;background:url(${split})"></div>`;
      const built = buildLayoutPackage({
        layoutCode: CODE,
        layoutVersion: 1,
        edit: (f) =>
          replaceInFile(
            f,
            "partials/header.hbs",
            "<h1>Invoice</h1>",
            `<h1>Invoice</h1>${style}`,
          ),
      });
      // The static lint does not see the split URL — so stage 7 is what refuses it.
      expect(
        lintLayoutTemplates({
          "partials/header.hbs": built.files
            .get("partials/header.hbs")!
            .toString("utf-8"),
        }),
      ).toEqual([]);

      const result = await checkLayoutPackage(built.zip, CTX);
      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.problems).toEqual([
        expect.objectContaining({
          code: "LAYOUT_EXTERNAL_FETCH",
          file: "(render)",
          message: expect.stringContaining(`${origin}/x`),
        }),
      ]);
      expect(hits).toBe(0);
    }, 120_000);

    it("renderAndReadSections reports a CSS background URL as blocked and never fetches it", async () => {
      const before = hits;
      const { blockedUrls, report } = await renderAndReadSections(
        `<!doctype html><html><body>
          <section class="sec sec--header"><div style="width:20px;height:20px;background:url(${origin}/direct)"></div>Supplier</section>
        </body></html>`,
        [{ key: "header", values: ["Supplier"] }],
      );
      expect(blockedUrls).toEqual([`${origin}/direct`]);
      expect(report.header).toMatchObject({ present: true, count: 1 });
      expect(hits).toBe(before);
    }, 120_000);
  },
);
