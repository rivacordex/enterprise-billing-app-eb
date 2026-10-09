import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import postgres from "postgres";
import type postgresjs from "postgres";

import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { blobStore } from "@/services/billing/blob-store";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { buildInvoiceHtml } from "@/services/billing/render-invoice-template";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import {
  setupInvoiceRenderFixtures,
  type InvoiceRenderFixtures,
} from "@/tests/db/helpers/invoice-render-fixtures";

// Guardrail 45, render half (bm53-spec §Tests; code-standards Part 2 §9 item
// 45). On a fresh DB (0046's seed rows) after the template seed upload, with NO
// admin activity (no profile, no further template version): every posted
// account's FINAL render and an unposted account's DRAFT render resolve the
// default BTV00000002 and load it FROM BLOB — the spy proves the bytes come
// through `blobStore.getObject` (guardrail 44 proves there is no `fs` path).
//
// Named `.integration.test.ts` (not the spec's `.test.ts`): it drops and
// re-migrates schemas, so it must run under the destructive-DB preflight (the
// bm50 grants-test precedent). The posted bills are written directly by
// tests/db/helpers/invoice-render-fixtures.ts — no workflow engine exists here
// to produce a `ci` run — and the render path reads exactly those rows.
// Requires DATABASE_URL + BILLRUN_BLOB_CONNECTION_STRING (Azurite); the seed
// writes the real seeded paths, idempotently (identical bytes).
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const RUN_POSTED = "BRN-BM53-G45-POSTED";
const RUN_DRAFT = "BRN-BM53-G45-DRAFT";

describe.skipIf(!databaseUrl || !blobConnection)(
  "guardrail 45 — a run with no admin activity renders the default from blob",
  () => {
    let sql: postgresjs.Sql;
    let fx: InvoiceRenderFixtures;
    const posted: { banId: string; invoiceNo: string }[] = [];
    let draftBan = "";

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      sql = postgres(databaseUrl as string, { max: 5 });
      fx = await setupInvoiceRenderFixtures(sql, "BM53G45");
      await seedInvoiceTemplates(fx.db);

      await fx.newRun(RUN_POSTED);
      for (const n of [1, 2, 3]) {
        const invoiceNo = `INV9000000${n}`;
        const { banId } = await fx.postedBill({
          label: `P${n}`,
          runId: RUN_POSTED,
          invoiceNo,
        });
        posted.push({ banId, invoiceNo });
      }
      await fx.newRun(RUN_DRAFT);
      ({ banId: draftBan } = await fx.draftBill({
        label: "D1",
        runId: RUN_DRAFT,
      }));
      clearLoadedTemplateMemo(); // a cold replica
    }, 180_000);

    afterAll(async () => {
      vi.restoreAllMocks();
      if (sql) {
        await fx?.dropAll();
        await sql.end();
      }
    }, 60_000);

    it("every posted account's final render resolves BTV00000002 (no profile) and loads it from blob", async () => {
      const getObject = vi.spyOn(blobStore, "getObject");

      for (const { banId, invoiceNo } of posted) {
        const result = await buildInvoiceHtml({
          runId: RUN_POSTED,
          banId,
          mode: "final",
          invoiceNo,
        });
        expect(result.resolved.generated.billTemplateVersionId).toBe(
          "BTV00000002",
        );
        expect(result.resolved.layout.billTemplateVersionId).toBe(
          "BTV00000001",
        );
        expect(result.resolved.csv.billTemplateVersionId).toBe("BTV00000003");
        expect(result.resolved.profileVersion).toBeNull();
        expect(result.html).toContain("TAX INVOICE");
        expect(result.html).toContain(invoiceNo);
        // G15 A — no profile: no issuer/payment block.
        expect(result.html).not.toContain('class="issuer"');
        expect(result.html).not.toContain("sec--payment");
        expect(result.pageSetup.format).toBe("A4");
      }

      // The cold load read the verified bytes from the seeded blob paths.
      const paths = getObject.mock.calls.map(([c, p]) => `${c}/${p}`);
      expect(paths).toEqual(
        expect.arrayContaining([
          "invoice-templates/generated/INVOICE/v1/checksums.json",
          "invoice-templates/generated/INVOICE/v1/invoice.hbs",
          "invoice-templates/generated/INVOICE/v1/footer.hbs",
        ]),
      );
    });

    it("an unposted account's draft render resolves the same default", async () => {
      const result = await buildInvoiceHtml({
        runId: RUN_DRAFT,
        banId: draftBan,
        mode: "draft",
      });
      expect(result.resolved.generated.billTemplateVersionId).toBe(
        "BTV00000002",
      );
      expect(result.resolved.profileVersion).toBeNull();
      expect(result.html).toContain("PRO-FORMA");
    });
  },
);
