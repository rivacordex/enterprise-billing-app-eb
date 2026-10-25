import { createHash } from "node:crypto";

import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// bm81-spec §9 (Inv #60, #68; guardrail 78) — export a version pair and
// restore it by upload, on a real database and a real Azurite (the shared
// template-type harness). Cases run in order on "Wholesale": byte identity for
// an ACTIVE pair, Standard v1, a DRAFT pair (EDIT only) and a RETIRED pair; a
// tampered blob; the refusals (no settings.json + wrong version, an unbound
// settings.json, a listed settings.json, another layout code), each writing
// nothing; then a restore into a FRESH environment (schemas dropped and
// re-migrated) and a restore over an open DRAFT. Probe renders are injected
// clean.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import type { Database } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { exportTemplateVersion } from "@/services/billing/invoice-template/export-template-version";
import { previewInvoiceTemplate } from "@/services/billing/invoice-template/preview";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import {
  freshTemplateDatabase,
  registerTemplateTypeDb,
} from "@/tests/db/helpers/template-type-db-harness";
import { cleanRender } from "@/tests/helpers/layout-package";
import type {
  ExpectedDraft,
  InvoiceTemplateStructure,
  UploadLayoutPackageResult,
} from "@/types/billing";
import { templateExportSettingsSchema } from "@/validation/billing/template-export-settings.schema";

const ACTOR = {
  id: "bm81-actor",
  name: "Template Exporter",
  email: "template-exporter@example.com",
};
const EXPORTER = { id: ACTOR.id, userName: ACTOR.name };
const BLOB_PREFIXES = [
  "layouts/INVTPL-WHOLESALE/",
  "layouts/INVTPL-RETAIL/",
  "generated/INVOICE/WHOLESALE/",
];
const RESTORED_STRUCTURE: InvoiceTemplateStructure = {
  sections: { payment: false },
  columns: {},
  footnote: ["Restored footnote line 1", "Restored footnote line 2"],
};

const sha256 = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
const enc = (text: string) => new TextEncoder().encode(text);

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm81 export a version pair and restore it by upload (requires DATABASE_URL + Azurite)",
  () => {
    let wholesaleId: string;
    const h = registerTemplateTypeDb({
      databaseUrl,
      blobConnection,
      actor: ACTOR,
      blobPrefixes: BLOB_PREFIXES,
      holder: hoisted.holder,
    });

    function db(): Database {
      return hoisted.holder.db as Database;
    }

    async function settingsRow(id: string): Promise<BillTemplateVersion> {
      const row = await billTemplateVersionRepository.findById(db(), id);
      if (!row) throw new Error(`no version ${id}`);
      return row;
    }

    async function activatePair(familyId: string) {
      const draft = await h.settingsDraft(familyId);
      const result = await activateTemplate(
        {
          draftId: draft.billTemplateVersionId,
          expectedDraftToken: draft.token,
          changeNote: "bm81 fixture",
          familyId,
        },
        ACTOR.id,
        { render: cleanRender() },
      );
      if (!result.ok) throw new Error(`activate failed: ${result.code}`);
      return result;
    }

    async function exported(versionId: string, canEdit = false) {
      const result = await exportTemplateVersion(versionId, EXPORTER, canEdit);
      if (!result.ok) throw new Error(`export failed: ${result.code}`);
      return result;
    }

    // The export unzips to every stored layout file plus checksums.json, each
    // byte-equal to the blob, and exactly one extra entry: settings.json.
    async function expectByteIdentity(
      bytes: Uint8Array,
      settings: BillTemplateVersion,
    ): Promise<void> {
      const layout = await settingsRow(settings.refLayoutVersionId!);
      const entries = unzipSync(bytes);
      const base = layout.blobRef!.replace(/^invoice-templates\//, "");
      const index = JSON.parse(
        new TextDecoder().decode(entries["checksums.json"]!),
      ) as { files: Record<string, string> };
      expect(Object.keys(entries).sort()).toEqual(
        [...Object.keys(index.files), "checksums.json", "settings.json"].sort(),
      );
      for (const name of [...Object.keys(index.files), "checksums.json"]) {
        const stored = await blobStore.getObject(
          "invoice-templates",
          `${base}${name}`,
        );
        expect(Buffer.from(entries[name]!).equals(stored)).toBe(true);
      }
      const parsed = templateExportSettingsSchema.parse(
        JSON.parse(new TextDecoder().decode(entries["settings.json"]!)),
      );
      expect(parsed.source.layoutChecksum).toBe(layout.checksum);
      expect(sha256(entries["checksums.json"]!)).toBe(layout.checksum);
      expect(parsed.source).toMatchObject({
        layoutVersion: layout.versionNo,
        settingsVersion: settings.versionNo,
        status: settings.status,
        exportedBy: ACTOR.name,
      });
      expect(parsed.structure).toEqual(settings.structure);
    }

    function upload(
      familyId: string,
      zip: Uint8Array,
      expectedDraft: ExpectedDraft = { none: true },
      expectedSettingsToken: string | null = null,
    ): Promise<UploadLayoutPackageResult> {
      return uploadLayoutPackage(
        { familyId, zip, expectedDraft, expectedSettingsToken },
        ACTOR.id,
        { render: cleanRender() },
      );
    }

    async function counts() {
      const [versions] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM billing.bill_template_version`;
      const [audit] = await h.sql<{ n: number }[]>`
        SELECT count(*)::int AS n FROM core.audit_log`;
      return {
        versions: versions!.n,
        audit: audit!.n,
        blobs: (await h.blobNames("layouts/")).sort(),
      };
    }

    async function exportedAudit() {
      return h.sql<
        { target_id: string; after_data: Record<string, unknown> }[]
      >`
        SELECT target_id, after_data FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_EXPORTED'
        ORDER BY created_datetime`;
    }

    // The export state the round trip carries between cases.
    let exportZip: Uint8Array;
    let exportFileName: string;
    let sourceLayoutChecksum: string;
    let sourcePreviewHtml: string;

    beforeAll(async () => {
      const created = await createTemplateType({ name: "Wholesale" }, ACTOR.id);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      wholesaleId = created.typeId;
      await h.upload(wholesaleId, "INVTPL-WHOLESALE", 1);
      await activatePair(wholesaleId);
    }, 180_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("an ACTIVE pair exports as INVTPL-WHOLESALE-v1-s1.zip, byte-identical to the stored blobs, audited once", async () => {
      const active = await billTemplateVersionRepository.findActive(db(), {
        kind: "generated",
        familyId: wholesaleId,
      });
      const result = await exported(active!.billTemplateVersionId);
      expect(result.fileName).toBe("INVTPL-WHOLESALE-v1-s1.zip");
      await expectByteIdentity(result.bytes, active!);
      const audit = await exportedAudit();
      expect(audit).toHaveLength(1);
      expect(audit[0]).toMatchObject({
        target_id: active!.billTemplateVersionId,
        after_data: {
          familyId: wholesaleId,
          layoutVersionNo: 1,
          settingsVersionNo: 1,
          fileName: "INVTPL-WHOLESALE-v1-s1.zip",
        },
      });
    });

    it("Standard v1 exports as INVTPL-STD-A4-v1-s1.zip, byte-identical", async () => {
      const standard = await billTemplateVersionRepository.findDefault(db(), {
        kind: "generated",
        familyId: "BTF00000001",
      });
      const result = await exported(standard!.billTemplateVersionId);
      expect(result.fileName).toBe("INVTPL-STD-A4-v1-s1.zip");
      await expectByteIdentity(result.bytes, standard!);
    });

    it("a DRAFT pair exports for EDIT only (a READ request is NOT_FOUND)", async () => {
      await h.upload(wholesaleId, "INVTPL-WHOLESALE", 2);
      const draft = await h.settingsDraft(wholesaleId);
      expect(
        await exportTemplateVersion(
          draft.billTemplateVersionId,
          EXPORTER,
          false,
        ),
      ).toEqual({ ok: false, code: "NOT_FOUND" });
      const result = await exported(draft.billTemplateVersionId, true);
      expect(result.fileName).toBe("INVTPL-WHOLESALE-v2-s2.zip");
      await expectByteIdentity(
        result.bytes,
        await settingsRow(draft.billTemplateVersionId),
      );
    });

    it("a RETIRED pair (v1 after v2 activates) exports for READ, byte-identical", async () => {
      const v1 = await billTemplateVersionRepository.findActive(db(), {
        kind: "generated",
        familyId: wholesaleId,
      });
      await activatePair(wholesaleId);
      const retired = await settingsRow(v1!.billTemplateVersionId);
      expect(retired.status).toBe("RETIRED");
      const result = await exported(retired.billTemplateVersionId);
      expect(result.fileName).toBe("INVTPL-WHOLESALE-v1-s1.zip");
      await expectByteIdentity(result.bytes, retired);
    });

    it("a tampered blob fails the export with TEMPLATE_CHECKSUM_MISMATCH naming the file, and writes no audit row", async () => {
      const active = await billTemplateVersionRepository.findActive(db(), {
        kind: "generated",
        familyId: wholesaleId,
      });
      const layout = await settingsRow(active!.refLayoutVersionId!);
      const path = `${layout.blobRef!.replace(/^invoice-templates\//, "")}partials/header.hbs`;
      const blob = h.templates().getBlockBlobClient(path);
      const original = await blob.downloadToBuffer();
      const auditBefore = (await exportedAudit()).length;
      await blob.upload(Buffer.from("tampered"), 8);
      try {
        await expect(
          exportTemplateVersion(active!.billTemplateVersionId, EXPORTER, false),
        ).rejects.toMatchObject({
          code: "TEMPLATE_CHECKSUM_MISMATCH",
          detail: { file: "partials/header.hbs" },
        });
        expect(await exportedAudit()).toHaveLength(auditBefore);
      } finally {
        await blob.upload(original, original.length);
      }
    });

    it("builds the round-trip source: layout v3 with settings v4 (three uploads and activations, then a settings-only one)", async () => {
      await h.upload(wholesaleId, "INVTPL-WHOLESALE", 3);
      await activatePair(wholesaleId);
      const draft = await saveTemplateDraft(
        {
          structure: RESTORED_STRUCTURE,
          expectedDraftToken: null,
          familyId: wholesaleId,
        },
        ACTOR.id,
      );
      if (!draft.ok) throw new Error(`save failed: ${draft.code}`);
      await activatePair(wholesaleId);
      const active = await billTemplateVersionRepository.findActive(db(), {
        kind: "generated",
        familyId: wholesaleId,
      });
      const result = await exported(active!.billTemplateVersionId);
      expect(result.fileName).toBe("INVTPL-WHOLESALE-v3-s4.zip");
      exportZip = result.bytes;
      exportFileName = result.fileName;
      sourceLayoutChecksum = (await settingsRow(active!.refLayoutVersionId!))
        .checksum!;
      sourcePreviewHtml = (
        await previewInvoiceTemplate({
          structure: RESTORED_STRUCTURE,
          source: "sample",
          familyId: wholesaleId,
        })
      ).html;
    });

    describe("refusals (guardrail 78) — each writes nothing", () => {
      // The export's entries, edited, re-zipped.
      function edited(
        edit: (entries: Record<string, Uint8Array>) => void,
      ): Uint8Array {
        const entries = unzipSync(exportZip);
        edit(entries);
        return zipSync(entries);
      }

      it("without settings.json, into a type whose next version isn't 3: LAYOUT_VERSION_MISMATCH", async () => {
        const before = await counts();
        const result = await upload(
          wholesaleId,
          edited((e) => delete e["settings.json"]),
        );
        expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
        if (result.ok) return;
        expect(result.problems.map((p) => p.code)).toEqual([
          "LAYOUT_VERSION_MISMATCH",
        ]);
        expect(await counts()).toEqual(before);
      });

      it("a settings.json with a different layoutChecksum: SETTINGS_INVALID", async () => {
        const before = await counts();
        const result = await upload(
          wholesaleId,
          edited((e) => {
            const s = JSON.parse(new TextDecoder().decode(e["settings.json"]));
            s.source.layoutChecksum = "0".repeat(64);
            e["settings.json"] = enc(JSON.stringify(s));
          }),
        );
        expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
        if (result.ok) return;
        expect(result.problems).toEqual([
          {
            file: "settings.json",
            code: "SETTINGS_INVALID",
            message: "settings.json does not belong to these layout files",
          },
        ]);
        expect(await counts()).toEqual(before);
      });

      it("a settings.json listed in checksums.json: CHECKSUM_MISMATCH", async () => {
        const before = await counts();
        const result = await upload(
          wholesaleId,
          edited((e) => {
            const index = JSON.parse(
              new TextDecoder().decode(e["checksums.json"]),
            );
            index.files["settings.json"] = sha256(e["settings.json"]!);
            e["checksums.json"] = enc(JSON.stringify(index));
          }),
        );
        expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
        if (result.ok) return;
        expect(result.problems.map((p) => [p.file, p.code])).toContainEqual([
          "settings.json",
          "CHECKSUM_MISMATCH",
        ]);
        expect(await counts()).toEqual(before);
      });

      it("an export restored into a type with a different layout_code: LAYOUT_CODE_MISMATCH", async () => {
        const retail = await createTemplateType({ name: "Retail" }, ACTOR.id);
        if (!retail.ok) throw new Error(`create type failed: ${retail.code}`);
        const before = await counts();
        const result = await upload(retail.typeId, exportZip);
        expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
        if (result.ok) return;
        expect(result.problems.map((p) => p.code)).toEqual([
          "LAYOUT_CODE_MISMATCH",
        ]);
        expect(await counts()).toEqual(before);
      });
    });

    describe("restore into a fresh environment", () => {
      let freshWholesaleId: string;

      beforeAll(async () => {
        // Drop and re-migrate the schemas: another environment's empty DB.
        hoisted.holder.db = await freshTemplateDatabase(h.sql, ACTOR);
        const created = await createTemplateType(
          { name: "Wholesale" },
          ACTOR.id,
        );
        if (!created.ok) throw new Error(`create type failed: ${created.code}`);
        freshWholesaleId = created.typeId;
      }, 180_000);

      it(`uploading the export creates DRAFT v1 with the same bytes and settings, audited with restoredFrom`, async () => {
        const result = await upload(freshWholesaleId, exportZip);
        expect(result).toMatchObject({
          ok: true,
          versionNo: 1,
          replaced: false,
        });
        if (!result.ok) return;

        const layout = await settingsRow(result.versionId);
        expect(layout).toMatchObject({
          kind: "layout",
          status: "DRAFT",
          versionNo: 1,
          checksum: sourceLayoutChecksum,
        });
        // Byte-equal blobs: every exported layout file (settings.json is not
        // stored).
        const entries = unzipSync(exportZip);
        const base = layout.blobRef!.replace(/^invoice-templates\//, "");
        const stored = (await h.blobNames(base)).map((n) =>
          n.slice(base.length),
        );
        expect(stored.sort()).toEqual(
          Object.keys(entries)
            .filter((n) => n !== "settings.json")
            .sort(),
        );
        for (const name of stored) {
          const bytes = await blobStore.getObject(
            "invoice-templates",
            `${base}${name}`,
          );
          expect(bytes.equals(Buffer.from(entries[name]!))).toBe(true);
        }

        const settings = await h.settingsDraft(freshWholesaleId);
        expect(settings.structure).toEqual(RESTORED_STRUCTURE);
        expect(settings.refLayoutVersionId).toBe(result.versionId);

        const source = templateExportSettingsSchema.parse(
          JSON.parse(new TextDecoder().decode(entries["settings.json"]!)),
        ).source;
        const [audit] = await h.sql<{ after_data: Record<string, unknown> }[]>`
          SELECT after_data FROM core.audit_log
          WHERE event_type = 'INVOICE_TEMPLATE_LAYOUT_UPLOADED'`;
        expect(audit!.after_data.restoredFrom).toEqual(source);
        expect(exportFileName).toBe("INVTPL-WHOLESALE-v3-s4.zip");

        // The restored DRAFT previews (draft: true, the bm79 path) exactly as
        // the source environment rendered the exported pair.
        const preview = await previewInvoiceTemplate({
          structure: RESTORED_STRUCTURE,
          source: "sample",
          familyId: freshWholesaleId,
          draft: true,
        });
        expect(preview.html).toBe(sourcePreviewHtml);
      });

      it("restoring over the open DRAFT checks the settings token (#2), replaces the settings in place, audits before/after (#4), credits the restorer (#4) and makes a stale editor's save a plain conflict (#1)", async () => {
        const EDITOR = "bm81-editor";
        await h.sql`
          INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
          VALUES (${EDITOR}, 'Settings Editor', 'settings-editor@example.com', 'LOCAL', 'ACTIVE')`;
        const edit = (footnote: string, token: string) =>
          saveTemplateDraft(
            {
              structure: {
                sections: { payment: true },
                columns: {},
                footnote: [footnote],
              },
              expectedDraftToken: token,
              familyId: freshWholesaleId,
            },
            EDITOR,
          );

        const first = await edit(
          "A manager's edit",
          (await h.settingsDraft(freshWholesaleId)).token,
        );
        if (!first.ok) throw new Error(`save failed: ${first.code}`);
        // The uploader's page loads now: layout token and settings token.
        const open = await billTemplateVersionRepository.findDraft(db(), {
          kind: "layout",
          familyId: freshWholesaleId,
        });
        const warned: ExpectedDraft = {
          versionId: open!.billTemplateVersionId,
          lastModified: open!.token,
        };
        const seenSettingsToken = first.draftToken;

        // Another manager saves after the dialog opened.
        const second = await edit("A later edit", seenSettingsToken);
        if (!second.ok) throw new Error(`save failed: ${second.code}`);
        const auditBefore = (
          await h.auditRows("INVOICE_TEMPLATE_LAYOUT_UPLOADED")
        ).length;

        // #2 — the restore would replace settings changed since: refused.
        expect(
          await upload(freshWholesaleId, exportZip, warned, seenSettingsToken),
        ).toEqual({
          ok: false,
          code: "DRAFT_CHANGED_SINCE_WARNING",
          problems: [],
        });
        const untouched = await h.settingsDraft(freshWholesaleId);
        expect(untouched.structure).toMatchObject({
          footnote: ["A later edit"],
        });
        expect(
          await h.auditRows("INVOICE_TEMPLATE_LAYOUT_UPLOADED"),
        ).toHaveLength(auditBefore);

        // Reloaded: the current settings token restores in place.
        const result = await upload(
          freshWholesaleId,
          exportZip,
          warned,
          untouched.token,
        );
        expect(result).toEqual({
          ok: true,
          versionId: open!.billTemplateVersionId,
          versionNo: 1,
          replaced: true,
        });
        const after = await billTemplateVersionRepository.findDraftWithModifier(
          db(),
          { kind: "generated", familyId: freshWholesaleId },
        );
        expect(after!.billTemplateVersionId).toBe(
          untouched.billTemplateVersionId,
        );
        expect(after!.structure).toEqual(RESTORED_STRUCTURE);
        // #4 — the banner's "saved by" is the restorer, not the last editor.
        expect(after!.lastModifiedByName).toBe(ACTOR.name);
        const audit = await h.auditRows("INVOICE_TEMPLATE_LAYOUT_UPLOADED");
        expect(audit).toHaveLength(auditBefore + 1);
        expect(audit.at(-1)!.after_data).toMatchObject({
          replaced: true,
          settingsBefore: untouched.structure,
          settingsAfter: RESTORED_STRUCTURE,
        });

        // #1 — restored settings are a settings change: the editor still
        // holding the pre-restore token gets the plain conflict.
        const layoutNow = await billTemplateVersionRepository.findDraft(db(), {
          kind: "layout",
          familyId: freshWholesaleId,
        });
        expect(layoutNow!.token).not.toBe(after!.token);
        expect(await edit("A stale edit", untouched.token)).toEqual({
          ok: false,
          code: "DRAFT_CONFLICT",
        });
        expect((await h.settingsDraft(freshWholesaleId)).structure).toEqual(
          RESTORED_STRUCTURE,
        );
      });
    });
  },
);
