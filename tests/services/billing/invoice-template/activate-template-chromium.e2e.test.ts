import { createHash } from "node:crypto";

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
  putObject: vi.fn(),
  transaction: vi.fn(),
  family: null as unknown,
  draft: null as unknown,
  layout: null as unknown,
}));

vi.mock("@/db/client", () => ({ db: { transaction: hoisted.transaction } }));
vi.mock("@/services/billing/blob-store", async () =>
  (
    await import("@/tests/helpers/in-memory-blob-store")
  ).inMemoryBlobStoreModule({
    missingAs404: true,
    extra: { putObject: hoisted.putObject },
  }),
);
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
import { memoryBlobs } from "@/tests/helpers/in-memory-blob-store";
import { externalFetchPackage } from "@/tests/helpers/layout-package";
import {
  startFetchStubServer,
  type FetchStubServer,
} from "@/tests/helpers/fetch-stub-server";

const run = process.env.RUN_CHROMIUM_E2E === "1";
const TOKEN = "2026-10-25T01:02:03.123456Z";
const BLOB_REF = "invoice-templates/layouts/INVTPL-WHOLESALE/v1-bypass/";

describe.skipIf(!run)(
  "bm79 activate a pair — real Chromium compliance re-run (RUN_CHROMIUM_E2E=1)",
  () => {
    let stub: FetchStubServer;
    let origin: string;

    beforeAll(async () => {
      stub = await startFetchStubServer();
      origin = stub.origin;
    });

    afterAll(async () => {
      if (stub) await stub.close();
    });

    it("a layout DRAFT that fetches an external URL is refused LAYOUT_REJECTED at activation; nothing is written and the stub server sees no hit", async () => {
      const built = externalFetchPackage(origin, "INVTPL-WHOLESALE");
      expect(
        lintLayoutTemplates({
          "partials/header.hbs": built.files
            .get("partials/header.hbs")!
            .toString("utf-8"),
        }),
      ).toEqual([]);
      for (const [name, bytes] of built.files) {
        memoryBlobs.set(`${BLOB_REF}${name}`, bytes);
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
      expect(stub.hits()).toBe(0);
    }, 120_000);
  },
);
