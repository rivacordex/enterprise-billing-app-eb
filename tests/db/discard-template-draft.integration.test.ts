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

// bm79-spec §9 — discard a type's DRAFTs on a real database and a real Azurite
// (the bm58/bm78 harness). Wholesale's uploaded pair → both RETIRED (never
// activated, last writer the actor), one INVOICE_TEMPLATE_DRAFT_DISCARDED,
// the numbers consumed (the next upload is v2, the next settings v2) and the
// blobs kept; a Standard settings-only DRAFT is discarded alone; a stale
// token, a retired type and a draft of another type are refused.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { seedInvoiceTemplates } from "@/db/seeds/invoice-templates";
import { discardTemplateDraft } from "@/services/billing/invoice-template/discard-template-draft";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import {
  getGeneratedVersionFile,
  getInvoiceTemplatePageData,
} from "@/services/billing/read/invoice-template-settings";
import {
  buildLayoutPackage,
  cleanRender,
} from "@/tests/helpers/layout-package";
import type { Database } from "@/db/client";

const ACTOR = "bm79-discarder";
const BLOB_PREFIXES = ["layouts/INVTPL-WHOLESALE/", "layouts/INVTPL-SHUT/"];

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm79 discard a template draft (requires DATABASE_URL + Azurite)",
  () => {
    let sql: postgresjs.Sql;
    let db: Database;
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

    async function blobNames(prefix: string): Promise<string[]> {
      const names: string[] = [];
      for await (const b of templates().listBlobsFlat({ prefix })) {
        names.push(b.name);
      }
      return names;
    }

    async function deleteTestBlobs(): Promise<void> {
      for (const prefix of BLOB_PREFIXES) {
        for (const name of await blobNames(prefix)) {
          await templates()
            .deleteBlob(name)
            .catch(() => undefined);
        }
      }
    }

    async function upload(familyId: string, layoutCode: string, n: number) {
      const result = await uploadLayoutPackage(
        {
          familyId,
          zip: buildLayoutPackage({ layoutCode, layoutVersion: n }).zip,
          expectedDraft: { none: true },
        },
        ACTOR,
        { render: cleanRender() },
      );
      if (!result.ok) throw new Error(`upload failed: ${result.code}`);
      return result;
    }

    async function settingsDraft(familyId: string) {
      const draft = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
        familyId,
      });
      if (!draft) throw new Error("no settings draft");
      return draft;
    }

    async function discard(
      familyId: string,
      draft: { billTemplateVersionId: string; token: string },
    ) {
      return discardTemplateDraft(
        {
          familyId,
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
        },
        ACTOR,
      );
    }

    async function versionRows() {
      return sql<
        {
          bill_template_version_id: string;
          status: string;
          last_modified_datetime: Date;
        }[]
      >`
        SELECT bill_template_version_id, status, last_modified_datetime
        FROM billing.bill_template_version ORDER BY bill_template_version_id`;
    }

    async function discardAudit() {
      return sql<
        { target_id: string; before_data: unknown; after_data: unknown }[]
      >`
        SELECT target_id, before_data, after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_DRAFT_DISCARDED' ORDER BY created_datetime`;
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
      db = drizzleDb as unknown as Database;
      hoisted.holder.db = db;
      await sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${ACTOR}, 'Draft Discarder', 'draft-discarder@example.com', 'LOCAL', 'ACTIVE')`;
      await seedInvoiceTemplates(db);
      clearLoadedTemplateMemo();
      await deleteTestBlobs();

      const created = await createTemplateType({ name: "Wholesale" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      wholesaleId = created.typeId;
      await upload(wholesaleId, "INVTPL-WHOLESALE", 1);
    }, 180_000);

    afterAll(async () => {
      if (service) await deleteTestBlobs();
      clearLoadedTemplateMemo();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("a stale token is DRAFT_CONFLICT and changes nothing", async () => {
      const draft = await settingsDraft(wholesaleId);
      const before = await versionRows();
      expect(
        await discard(wholesaleId, {
          billTemplateVersionId: draft.billTemplateVersionId,
          token: "2020-01-01T00:00:00.000000Z",
        }),
      ).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(await versionRows()).toEqual(before);
      expect(await discardAudit()).toHaveLength(0);
    });

    it("a draftId from another type is DRAFT_CONFLICT", async () => {
      const draft = await settingsDraft(wholesaleId);
      const before = await versionRows();
      expect(await discard("BTF00000001", draft)).toEqual({
        ok: false,
        code: "DRAFT_CONFLICT",
      });
      expect(await versionRows()).toEqual(before);
    });

    it("discards Wholesale's pair: both RETIRED, never activated, the actor as last writer, one audit row, the blobs kept and the numbers consumed", async () => {
      const draft = await settingsDraft(wholesaleId);
      const layoutDraft = (await billTemplateVersionRepository.findDraft(db, {
        kind: "layout",
        familyId: wholesaleId,
      }))!;
      const layoutBlobs = await blobNames(
        layoutDraft.blobRef!.replace(/^invoice-templates\//, ""),
      );
      expect(layoutBlobs.length).toBeGreaterThan(0);

      const result = await discard(wholesaleId, draft);
      expect(result).toEqual({
        ok: true,
        discardedVersionIds: [
          draft.billTemplateVersionId,
          layoutDraft.billTemplateVersionId,
        ],
      });

      const rows = await sql<
        {
          bill_template_version_id: string;
          kind: string;
          status: string;
          retired_datetime: Date | null;
          activated_datetime: Date | null;
          last_modified_by: string | null;
        }[]
      >`
        SELECT bill_template_version_id, kind, status, retired_datetime,
               activated_datetime, last_modified_by
        FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${wholesaleId} ORDER BY kind`;
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.status).toBe("RETIRED");
        expect(row.retired_datetime).not.toBeNull();
        expect(row.activated_datetime).toBeNull();
        expect(row.last_modified_by).toBe(ACTOR);
      }

      const audit = await discardAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toEqual({
        target_id: draft.billTemplateVersionId,
        before_data: { status: "DRAFT" },
        after_data: {
          familyId: wholesaleId,
          settingsVersionId: draft.billTemplateVersionId,
          settingsVersionNo: 1,
          layoutVersionId: layoutDraft.billTemplateVersionId,
          layoutVersionNo: 1,
        },
      });

      // Write-once blobs are never deleted inline.
      expect(
        await blobNames(
          layoutDraft.blobRef!.replace(/^invoice-templates\//, ""),
        ),
      ).toEqual(layoutBlobs);

      // Rows and numbers are never reused: the next upload is v2, and so is
      // the settings DRAFT it creates.
      const next = await upload(wholesaleId, "INVTPL-WHOLESALE", 2);
      expect(next.versionNo).toBe(2);
      expect((await settingsDraft(wholesaleId)).versionNo).toBe(2);
    }, 120_000);

    it("a Standard settings-only DRAFT is discarded alone: the page then shows the ACTIVE version and no layout row changes", async () => {
      const saved = await saveTemplateDraft(
        {
          structure: {
            sections: { payment: false },
            columns: {},
            footnote: [...SEEDED_FOOTNOTE],
          },
          expectedDraftToken: null,
          familyId: "BTF00000001",
        },
        ACTOR,
      );
      if (!saved.ok) throw new Error(`save failed: ${saved.code}`);
      const layoutsBefore = await sql`
        SELECT * FROM billing.bill_template_version
        WHERE kind = 'layout' ORDER BY bill_template_version_id`;

      const result = await discard("BTF00000001", {
        billTemplateVersionId: saved.versionId,
        token: saved.draftToken,
      });
      expect(result).toEqual({
        ok: true,
        discardedVersionIds: [saved.versionId],
      });
      expect(
        await sql`
          SELECT * FROM billing.bill_template_version
          WHERE kind = 'layout' ORDER BY bill_template_version_id`,
      ).toEqual(layoutsBefore);

      const page = await getInvoiceTemplatePageData("BTF00000001", undefined, {
        canEdit: true,
      });
      expect(page).toMatchObject({ empty: false, draft: null });
      if (!page || page.empty) return;
      expect(page.shown.billTemplateVersionId).toBe("BTV00000002");
      expect(page.shown.status).toBe("ACTIVE");
      const discarded = page.history.find(
        (h) => h.billTemplateVersionId === saved.versionId,
      );
      expect(discarded).toMatchObject({ status: "RETIRED", activatedAt: null });

      // Review fix — a discarded draft is still a draft: a READ user's
      // `?version=` falls back to the version in use, and it is no stored
      // version (the file download is a 404, not a verification failure).
      const asReader = await getInvoiceTemplatePageData(
        "BTF00000001",
        saved.versionId,
        { canEdit: false },
      );
      if (!asReader || asReader.empty) throw new Error("expected the editor");
      expect(asReader.shown.billTemplateVersionId).toBe("BTV00000002");
      const asEditor = await getInvoiceTemplatePageData(
        "BTF00000001",
        saved.versionId,
        { canEdit: true },
      );
      if (!asEditor || asEditor.empty) throw new Error("expected the editor");
      expect(asEditor.shown.billTemplateVersionId).toBe(saved.versionId);
      expect(
        await getGeneratedVersionFile(saved.versionId, "invoice.hbs"),
      ).toBeNull();
    }, 120_000);

    it("[Inv #67] a retired type is TEMPLATE_TYPE_RETIRED and its DRAFTs stay", async () => {
      const created = await createTemplateType({ name: "Shut" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      await upload(created.typeId, "INVTPL-SHUT", 1);
      const draft = await settingsDraft(created.typeId);
      await sql`
        UPDATE billing.bill_template_family SET retired_datetime = now()
        WHERE bill_template_family_id = ${created.typeId}`;
      const before = await versionRows();

      expect(await discard(created.typeId, draft)).toEqual({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
      });
      expect(await versionRows()).toEqual(before);
    }, 120_000);

    it("an unknown type is VALIDATION_ERROR", async () => {
      const draft = await settingsDraft(wholesaleId);
      expect(await discard("BTF00009999", draft)).toEqual({
        ok: false,
        code: "VALIDATION_ERROR",
      });
    });
  },
);
