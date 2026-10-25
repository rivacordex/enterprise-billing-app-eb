import { BlobServiceClient } from "@azure/storage-blob";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import type postgresjs from "postgres";

import * as schema from "@/db/schema";
import { assertTestBlobConnection } from "@/tests/helpers/assert-test-blob-store";
import { assertTestDatabaseUrl } from "@/tests/helpers/assert-test-database";

// bm79-spec §9 (Inv #61, #62 activation half, #63, #66, #67; guardrail 71
// activation half) — activate an uploaded layout + settings DRAFT pair on a
// real database and a real Azurite (the bm58/bm78 harness). "Wholesale" is
// created and its layout v1 uploaded through the bm77/bm78 services; the
// Chromium compliance render is injected through `deps.render` (the e2e suite
// proves the real one). Cases run in order on one type: the compliance re-run
// refusal, an upload re-point committed between the blob writes and the
// transaction, the pair activation, the frozen files, a second version, a
// stale preview token; plus a retired type. Standard's rows never change.
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
import { blobStore } from "@/services/billing/blob-store";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { clearLoadedTemplateMemo } from "@/services/billing/invoice-template/load";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import { listTemplateTypes } from "@/services/billing/read/invoice-template-settings";
import {
  buildLayoutPackage,
  cleanRender,
} from "@/tests/helpers/layout-package";
import type { Database } from "@/db/client";

const ACTOR = "bm79-actor";
const BLOB_PREFIXES = [
  "layouts/INVTPL-WHOLESALE/",
  "layouts/INVTPL-OLD_PAIR/",
  "generated/INVOICE/WHOLESALE/",
  "generated/INVOICE/OLD_PAIR/",
];

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm79 activate an uploaded draft pair (requires DATABASE_URL + Azurite)",
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

    // The settings DRAFT and its token, as the page would load them.
    async function settingsDraft(familyId: string) {
      const draft = await billTemplateVersionRepository.findDraft(db, {
        kind: "generated",
        familyId,
      });
      if (!draft) throw new Error("no settings draft");
      return draft;
    }

    async function activate(
      familyId: string,
      draft: { billTemplateVersionId: string; token: string },
      render = cleanRender(),
    ) {
      return activateTemplate(
        {
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
          changeNote: "Wholesale layout",
          familyId,
        },
        ACTOR,
        { render },
      );
    }

    async function typeRows(familyId: string) {
      return sql<
        {
          bill_template_version_id: string;
          kind: string;
          version_no: number;
          status: string;
          blob_ref: string | null;
          checksum: string | null;
          change_note: string | null;
          activated_datetime: Date | null;
          retired_datetime: Date | null;
          last_modified_datetime: Date;
        }[]
      >`
        SELECT bill_template_version_id, kind, version_no, status, blob_ref, checksum,
               change_note, activated_datetime, retired_datetime, last_modified_datetime
        FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${familyId}
        ORDER BY kind, version_no`;
    }

    async function activatedAudit() {
      return sql<
        { target_id: string; before_data: unknown; after_data: unknown }[]
      >`
        SELECT target_id, before_data, after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_ACTIVATED' ORDER BY created_datetime`;
    }

    let standardBefore: Awaited<ReturnType<typeof typeRows>>;

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
        VALUES (${ACTOR}, 'Template Activator', 'template-activator@example.com', 'LOCAL', 'ACTIVE')`;
      await seedInvoiceTemplates(db);
      clearLoadedTemplateMemo();
      await deleteTestBlobs();

      const created = await createTemplateType({ name: "Wholesale" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      wholesaleId = created.typeId;
      await upload(wholesaleId, "INVTPL-WHOLESALE", 1);
      standardBefore = await typeRows("BTF00000001");
    }, 180_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    afterAll(async () => {
      if (service) await deleteTestBlobs();
      clearLoadedTemplateMemo();
      if (sql) {
        await dropAll();
        await sql.end();
      }
    }, 60_000);

    it("[Inv #63] a layout DRAFT that fails the compliance re-run is LAYOUT_REJECTED and writes nothing (no generated blob)", async () => {
      const before = await typeRows(wholesaleId);
      const auditBefore = (await activatedAudit()).length;
      const result = await activate(
        wholesaleId,
        await settingsDraft(wholesaleId),
        cleanRender(["http://x/a.png"]),
      );
      expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
      if (result.ok || result.code !== "LAYOUT_REJECTED") return;
      expect(result.problems.map((p) => p.code)).toContain(
        "LAYOUT_EXTERNAL_FETCH",
      );
      expect(await typeRows(wholesaleId)).toEqual(before);
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(await blobNames("generated/INVOICE/WHOLESALE/")).toHaveLength(0);
    }, 120_000);

    it("an upload re-point committed between the blob writes and the transaction is DRAFT_CONFLICT and promotes nothing", async () => {
      const draft = await settingsDraft(wholesaleId);
      const auditBefore = (await activatedAudit()).length;
      const original = blobStore.putObject.bind(blobStore);
      let interleaved = false;
      vi.spyOn(blobStore, "putObject").mockImplementation(
        async (...args: Parameters<typeof blobStore.putObject>) => {
          const put = await original(...args);
          if (!interleaved) {
            interleaved = true;
            // What install does to an open settings DRAFT (Inv #62): re-point
            // it, committed in its own transaction, which bumps its token.
            await db.transaction((tx) =>
              billTemplateVersionRepository.repointDraftLayout(tx, {
                id: draft.billTemplateVersionId,
                layoutVersionId: draft.refLayoutVersionId!,
                actorId: ACTOR,
              }),
            );
          }
          return put;
        },
      );

      const result = await activate(wholesaleId, draft);
      expect(result).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect(interleaved).toBe(true);
      const rows = await typeRows(wholesaleId);
      expect(rows.map((r) => [r.kind, r.version_no, r.status])).toEqual([
        ["generated", 1, "DRAFT"],
        ["layout", 1, "DRAFT"],
      ]);
      expect(await activatedAudit()).toHaveLength(auditBefore);
    }, 120_000);

    it("activates the pair: layout v1 and settings v1 ACTIVE, the layout's files unchanged, a per-type generated path, one audit row, the type Usable", async () => {
      const draft = await settingsDraft(wholesaleId);
      const [layoutDraft] = (await typeRows(wholesaleId)).filter(
        (r) => r.kind === "layout",
      );
      const result = await activate(wholesaleId, draft);
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.versionNo).toBe(1);
      expect(result.retiredVersionId).toBeNull();
      expect(result.layout).toEqual({
        versionId: layoutDraft!.bill_template_version_id,
        versionNo: 1,
        retiredVersionId: null,
      });

      const rows = await typeRows(wholesaleId);
      const layout = rows.find((r) => r.kind === "layout")!;
      const settings = rows.find((r) => r.kind === "generated")!;
      expect(layout).toMatchObject({
        status: "ACTIVE",
        version_no: 1,
        blob_ref: layoutDraft!.blob_ref,
        checksum: layoutDraft!.checksum,
        change_note: "Wholesale layout",
      });
      expect(layout.activated_datetime).not.toBeNull();
      expect(settings).toMatchObject({
        status: "ACTIVE",
        version_no: 1,
        change_note: "Wholesale layout",
      });
      expect(settings.blob_ref).toMatch(
        /^invoice-templates\/generated\/INVOICE\/WHOLESALE\/v1-[0-9a-f]{12}\/$/,
      );

      const audit = await activatedAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]?.target_id).toBe(result.versionId);
      expect(audit[0]?.before_data).toEqual({
        activeVersionId: null,
        activeVersionNo: null,
        activeLayoutVersionId: null,
      });
      expect(audit[0]?.after_data).toMatchObject({
        familyId: wholesaleId,
        activatedVersionId: result.versionId,
        layout: {
          activatedVersionId: layoutDraft!.bill_template_version_id,
          versionNo: 1,
          retiredVersionId: null,
          blobRef: layoutDraft!.blob_ref,
          checksum: layoutDraft!.checksum,
        },
      });

      const wholesale = (await listTemplateTypes()).find(
        (t) => t.billTemplateFamilyId === wholesaleId,
      );
      expect(wholesale).toMatchObject({ status: "USABLE", activeVersionNo: 1 });
    }, 120_000);

    it("[bm74 through the service path] the promoted layout's files are frozen: an UPDATE of blob_ref raises VERSION_IMMUTABLE", async () => {
      const layout = (await typeRows(wholesaleId)).find(
        (r) => r.kind === "layout" && r.status === "ACTIVE",
      )!;
      await expect(
        sql`UPDATE billing.bill_template_version SET blob_ref = 'invoice-templates/layouts/x/'
            WHERE bill_template_version_id = ${layout.bill_template_version_id}`,
      ).rejects.toThrow(/VERSION_IMMUTABLE/);
    });

    it("a second upload and activation retires the v1 pair and promotes v2; the audit names v1", async () => {
      const v1 = await typeRows(wholesaleId);
      const layoutV1 = v1.find((r) => r.kind === "layout")!;
      const settingsV1 = v1.find((r) => r.kind === "generated")!;
      await upload(wholesaleId, "INVTPL-WHOLESALE", 2);
      const result = await activate(
        wholesaleId,
        await settingsDraft(wholesaleId),
      );
      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.versionNo).toBe(2);
      expect(result.retiredVersionId).toBe(settingsV1.bill_template_version_id);
      expect(result.layout).toMatchObject({
        versionNo: 2,
        retiredVersionId: layoutV1.bill_template_version_id,
      });

      const rows = await typeRows(wholesaleId);
      expect(rows.map((r) => [r.kind, r.version_no, r.status])).toEqual([
        ["generated", 1, "RETIRED"],
        ["generated", 2, "ACTIVE"],
        ["layout", 1, "RETIRED"],
        ["layout", 2, "ACTIVE"],
      ]);
      const audit = (await activatedAudit()).at(-1);
      expect(audit?.before_data).toEqual({
        activeVersionId: settingsV1.bill_template_version_id,
        activeVersionNo: 1,
        activeLayoutVersionId: layoutV1.bill_template_version_id,
      });
      expect(audit?.after_data).toMatchObject({
        retiredVersionId: settingsV1.bill_template_version_id,
        layout: { retiredVersionId: layoutV1.bill_template_version_id },
      });
    }, 120_000);

    it("[guardrail 71, activation half — Inv #62] an Activate carrying the token from before an upload promotes nothing; the new token succeeds", async () => {
      // A settings DRAFT exists before the upload: its token T0 is what a page
      // opened then would hold.
      const saved = await saveTemplateDraft(
        {
          structure: {
            sections: { payment: false },
            columns: {},
            footnote: ["Stale preview footnote"],
          },
          expectedDraftToken: null,
          familyId: wholesaleId,
        },
        ACTOR,
      );
      if (!saved.ok) throw new Error(`save failed: ${saved.code}`);
      const t0 = {
        billTemplateVersionId: saved.versionId,
        token: saved.draftToken,
      };
      // The upload re-points that DRAFT at layout v3, so its token is now T1.
      await upload(wholesaleId, "INVTPL-WHOLESALE", 3);
      const t1 = await settingsDraft(wholesaleId);
      expect(t1.billTemplateVersionId).toBe(t0.billTemplateVersionId);
      expect(t1.token).not.toBe(t0.token);

      const before = await typeRows(wholesaleId);
      const auditBefore = (await activatedAudit()).length;
      expect(await activate(wholesaleId, t0)).toEqual({
        ok: false,
        code: "DRAFT_CONFLICT",
      });
      expect(await typeRows(wholesaleId)).toEqual(before);
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(
        await blobNames(`generated/INVOICE/WHOLESALE/v${saved.versionNo}-`),
      ).toHaveLength(0);

      const ok = await activate(wholesaleId, t1);
      expect(ok).toMatchObject({ ok: true, versionNo: saved.versionNo });
      if (!ok.ok) return;
      expect(ok.layout).toMatchObject({ versionNo: 3 });
    }, 120_000);

    it("[Inv #67] a type retired via SQL is TEMPLATE_TYPE_RETIRED and nothing is written", async () => {
      const created = await createTemplateType({ name: "Old Pair" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      await upload(created.typeId, "INVTPL-OLD_PAIR", 1);
      const draft = await settingsDraft(created.typeId);
      await sql`
        UPDATE billing.bill_template_family SET retired_datetime = now()
        WHERE bill_template_family_id = ${created.typeId}`;
      const before = await typeRows(created.typeId);
      const auditBefore = (await activatedAudit()).length;

      expect(await activate(created.typeId, draft)).toEqual({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
      });
      expect(await typeRows(created.typeId)).toEqual(before);
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(await blobNames("generated/INVOICE/OLD_PAIR/")).toHaveLength(0);
    }, 120_000);

    it("Standard is untouched: none of its rows changed across every Wholesale activation", async () => {
      expect(await typeRows("BTF00000001")).toEqual(standardBefore);
    });
  },
);
