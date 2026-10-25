import { BlobServiceClient } from "@azure/storage-blob";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";
import { SEEDED_FOOTNOTE } from "@/tests/helpers/seeded-invoice-template";

// bm78-spec §9 / §13 (Inv #61) — the sample preview of an uploaded, not yet
// activated layout: on a real database and Azurite (the activation harness),
// after "Wholesale" receives layout DRAFT v1, `previewInvoiceTemplate({ source:
// "sample", familyId, draft: true })` renders THAT draft layout (through
// `loadLayoutDraft`), labelled "INVTPL-WHOLESALE v1 (draft)", while Standard's
// preview is unchanged. bm79 review fix: without `draft` (a READ user, or a
// version opened from history) the preview never shows the draft. The upload's probe render is injected clean (the e2e suite proves
// the real one). The services use the `@/db/client` singleton, so it is
// replaced with one built on the test client.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import type {
  ComplianceSectionKey,
  VisibleSectionReport,
} from "@/services/billing/invoice-template/compliance";
import type { renderAndReadSections } from "@/services/billing/invoice-template/compliance-render";
import {
  clearLoadedTemplateMemo,
  loadedTemplateMemo,
} from "@/services/billing/invoice-template/load";
import { previewInvoiceTemplate } from "@/services/billing/invoice-template/preview";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import {
  buildLayoutPackage,
  replaceInFile,
} from "@/tests/helpers/layout-package";
import type { Database } from "@/db/client";
import type { InvoiceTemplateStructure } from "@/types/billing";

const ACTOR = "bm78-preview-actor";
const STANDARD = "BTF00000001";
// A marker only the uploaded Wholesale layout prints.
const MARKER = "Wholesale draft layout";

const STRUCTURE: InvoiceTemplateStructure = {
  sections: { payment: true },
  columns: {},
  footnote: [...SEEDED_FOOTNOTE],
};

const cleanRender: typeof renderAndReadSections = async (_html, probes) => ({
  report: Object.fromEntries(
    probes.map((p) => [
      p.key,
      {
        present: true,
        count: 1,
        text: p.values.length > 0 ? p.values.join(" ") : `${p.key} text`,
        illegible: [],
      },
    ]),
  ) as unknown as Record<ComplianceSectionKey, VisibleSectionReport>,
  blockedUrls: [],
});

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm78 preview of an uploaded layout DRAFT (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let wholesaleId: string;
    const service = blobConnection
      ? BlobServiceClient.fromConnectionString(blobConnection)
      : null;
    const templates = () => service!.getContainerClient("invoice-templates");

    async function dropAll(): Promise<void> {
      for (const s of [
        "billing",
        "customer",
        "product",
        "rating",
        "core",
        "drizzle",
        "partman",
        "inventory",
        "ordering",
      ]) {
        await sql.unsafe(`DROP SCHEMA IF EXISTS "${s}" CASCADE`);
      }
    }

    async function deleteWholesaleBlobs(): Promise<void> {
      for await (const b of templates().listBlobsFlat({
        prefix: "layouts/INVTPL-WHOLESALE/",
      })) {
        await templates()
          .deleteBlob(b.name)
          .catch(() => undefined);
      }
    }

    beforeAll(async () => {
      assertTestDatabaseUrl(databaseUrl as string);
      assertTestBlobConnection(blobConnection as string);
      sql = postgres(databaseUrl as string, { max: 8, onnotice: () => {} });
      await dropAll();
      const drizzleDb = drizzle(sql, { schema });
      await migrate(drizzleDb, {
        migrationsFolder: "./db/migrations",
        migrationsSchema: "drizzle",
      });
      const db = drizzleDb as unknown as Database;
      hoisted.holder.db = db;
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${ACTOR}, 'Preview Admin', 'preview-admin@example.com', 'LOCAL', 'ACTIVE')`;
      await seedInvoiceTemplates(db);
      clearLoadedTemplateMemo();
      await deleteWholesaleBlobs();

      const created = await createTemplateType({ name: "Wholesale" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      wholesaleId = created.typeId;
      const uploaded = await uploadLayoutPackage(
        {
          familyId: wholesaleId,
          zip: buildLayoutPackage({
            layoutCode: "INVTPL-WHOLESALE",
            layoutVersion: 1,
            edit: (f) =>
              replaceInFile(
                f,
                "partials/header.hbs",
                "<h1>Invoice</h1>",
                `<h1>Invoice</h1><p>${MARKER}</p>`,
              ),
          }).zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender },
      );
      if (!uploaded.ok) {
        throw new Error(
          `upload failed: ${uploaded.code} ${JSON.stringify(uploaded.problems)}`,
        );
      }
    }, 180_000);

    afterAll(async () => {
      if (service) await deleteWholesaleBlobs();
      clearLoadedTemplateMemo();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it('renders the uploaded layout DRAFT, labelled "INVTPL-WHOLESALE v1 (draft)", and memoizes nothing', async () => {
      const memoBefore = new Map(loadedTemplateMemo);
      const result = await previewInvoiceTemplate({
        structure: STRUCTURE,
        source: "sample",
        familyId: wholesaleId,
        draft: true,
      });
      expect(result.templateLabel).toBe("INVTPL-WHOLESALE v1 (draft)");
      expect(result.pinnedVersionNo).toBeNull();
      expect(result.html).toContain(MARKER);
      // The submitted structure's footnote is generated in.
      expect(result.html).toContain(SEEDED_FOOTNOTE[0]!);
      expect(new Map(loadedTemplateMemo)).toEqual(memoBefore);
    });

    it("review fix — without `draft` the preview never renders the draft: Wholesale has no version in use yet", async () => {
      await expect(
        previewInvoiceTemplate({
          structure: STRUCTURE,
          source: "sample",
          familyId: wholesaleId,
        }),
      ).rejects.toMatchObject({ code: "TEMPLATE_VERSION_NOT_FOUND" });
    });

    it("Standard's sample preview is unchanged: its own layout, not a draft label", async () => {
      const result = await previewInvoiceTemplate({
        structure: STRUCTURE,
        source: "sample",
        familyId: STANDARD,
      });
      expect(result.templateLabel).not.toContain("(draft)");
      expect(result.templateLabel).not.toContain("INVTPL-WHOLESALE");
      expect(result.templateLabel).toContain("INVTPL-STD-A4");
      expect(result.html).not.toContain(MARKER);
    });
  },
);
