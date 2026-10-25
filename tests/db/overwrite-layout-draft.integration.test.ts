import { createHash } from "node:crypto";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

// bm80-spec §8 (Inv #59, #61, #62; guardrail 71 concurrency half) — overwrite
// an open layout DRAFT by upload on a real database and a real Azurite (the
// bm78 harness and fixtures). Cases run in order on "Wholesale": the in-place
// overwrite (same row and number, new files, the old blobs kept, the settings
// DRAFT kept with a bumped token, one audit row with both checksums); a stale
// warning; the same bytes again; a stale Activate; then an overwrite of a
// draft activated meanwhile. Two races run on their own types: two creates
// and two overwrites, held together by a barrier on the blob writes until both
// have passed the gate. The probe render is injected clean.
const databaseUrl = process.env.DATABASE_URL;
const blobConnection = process.env.BILLRUN_BLOB_CONNECTION_STRING;

const hoisted = vi.hoisted(() => ({ holder: { db: undefined as unknown } }));
vi.mock("@/db/client", () => ({
  get db() {
    return hoisted.holder.db;
  },
}));

import {
  billTemplateVersionRepository,
  type TemplateDraftRow,
} from "@/db/repositories/billing/bill-template-version";
import { blobStore } from "@/services/billing/blob-store";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { createTemplateType } from "@/services/billing/invoice-template/template-types";
import { uploadLayoutPackage } from "@/services/billing/invoice-template/upload-layout-package";
import { registerTemplateTypeDb } from "@/tests/db/helpers/template-type-db-harness";
import {
  buildLayoutPackage,
  cleanRender,
  replaceInFile,
} from "@/tests/helpers/layout-package";
import type { ExpectedDraft, UploadLayoutPackageResult } from "@/types/billing";

const ACTOR = "bm80-actor";
const SECOND = "bm80-second";
const BLOB_PREFIXES = [
  "layouts/INVTPL-WHOLESALE/",
  "layouts/INVTPL-RACE/",
  "layouts/INVTPL-RACE_TWO/",
  "generated/INVOICE/WHOLESALE/",
];

const sha256 = (b: Buffer) => createHash("sha256").update(b).digest("hex");

// The reference package as `code` v`n`, its header carrying `marker` (a
// different marker is a different package, so a different digest and folder).
function markedPackage(code: string, n: number, marker: string) {
  return buildLayoutPackage({
    layoutCode: code,
    layoutVersion: n,
    edit: (f) =>
      replaceInFile(
        f,
        "partials/header.hbs",
        "<h1>Invoice</h1>",
        `<h1>Invoice</h1><p>${marker}</p>`,
      ),
  });
}

function expected(draft: TemplateDraftRow): ExpectedDraft {
  return { versionId: draft.billTemplateVersionId, lastModified: draft.token };
}

describe.skipIf(!databaseUrl || !blobConnection)(
  "bm80 overwrite an open layout draft (requires DATABASE_URL + Azurite)",
  () => {
    let wholesaleId: string;
    const h = registerTemplateTypeDb({
      databaseUrl,
      blobConnection,
      actor: {
        id: ACTOR,
        name: "First Uploader",
        email: "first-uploader@example.com",
      },
      blobPrefixes: BLOB_PREFIXES,
      holder: hoisted.holder,
    });

    function upload(
      familyId: string,
      zip: Uint8Array,
      expectedDraft: ExpectedDraft,
      actor = ACTOR,
    ): Promise<UploadLayoutPackageResult> {
      return uploadLayoutPackage({ familyId, zip, expectedDraft }, actor, {
        render: cleanRender(),
      });
    }

    async function layoutDraft(familyId: string): Promise<TemplateDraftRow> {
      const draft = await billTemplateVersionRepository.findDraft(h.db, {
        kind: "layout",
        familyId,
      });
      if (!draft) throw new Error("no layout draft");
      return draft;
    }

    async function layoutRows(familyId: string) {
      return h.sql<
        {
          bill_template_version_id: string;
          version_no: number;
          status: string;
          blob_ref: string | null;
          checksum: string | null;
          last_modified_by: string | null;
          change_note: string | null;
        }[]
      >`
        SELECT bill_template_version_id, version_no, status, blob_ref, checksum,
               last_modified_by, change_note
        FROM billing.bill_template_version
        WHERE ref_bill_template_family_id = ${familyId} AND kind = 'layout'
        ORDER BY version_no`;
    }

    async function uploadedAudit() {
      return h.sql<
        {
          target_id: string;
          actor_user_id: string;
          before_data: Record<string, unknown> | null;
          after_data: Record<string, unknown>;
        }[]
      >`
        SELECT target_id, actor_user_id, before_data, after_data
        FROM core.audit_log
        WHERE event_type = 'INVOICE_TEMPLATE_LAYOUT_UPLOADED'
        ORDER BY created_datetime`;
    }

    // Holds every blob write until `parties` different package folders have
    // started writing, i.e. until every racing upload has passed the gate.
    function blobBarrier(parties: number): void {
      const original = blobStore.putObject.bind(blobStore);
      const folders = new Set<string>();
      let release!: () => void;
      const allArrived = new Promise<void>((r) => (release = r));
      vi.spyOn(blobStore, "putObject").mockImplementation(
        async (...args: Parameters<typeof blobStore.putObject>) => {
          const folder = args[1].split("/").slice(0, 3).join("/");
          folders.add(folder);
          if (folders.size >= parties) release();
          await allArrived;
          return original(...args);
        },
      );
    }

    beforeAll(async () => {
      await h.sql`
        INSERT INTO core.appuser (user_id, user_name, user_email, auth_method, status)
        VALUES (${SECOND}, 'Second Uploader', 'second-uploader@example.com', 'LOCAL', 'ACTIVE')`;
      const created = await createTemplateType({ name: "Wholesale" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      wholesaleId = created.typeId;
      const first = await upload(
        wholesaleId,
        markedPackage("INVTPL-WHOLESALE", 1, "MARKER-A").zip,
        { none: true },
      );
      if (!first.ok) throw new Error(`upload failed: ${first.code}`);
    }, 180_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("overwrites DRAFT v1 in place: same id and number, new files (old blobs kept), the settings DRAFT kept with a new token, one audit row with both checksums", async () => {
      const before = await layoutDraft(wholesaleId);
      const settingsBefore = await h.settingsDraft(wholesaleId);
      const oldFolder = before.blobRef!.replace(/^invoice-templates\//, "");
      const oldBlobs = await h.blobNames(oldFolder);
      expect(oldBlobs.length).toBeGreaterThan(0);

      const built = markedPackage("INVTPL-WHOLESALE", 1, "MARKER-B");
      const digest = sha256(built.indexBytes!);
      const result = await upload(
        wholesaleId,
        built.zip,
        expected(before),
        SECOND,
      );
      expect(result).toEqual({
        ok: true,
        versionId: before.billTemplateVersionId,
        versionNo: 1,
        replaced: true,
      });

      const rows = await layoutRows(wholesaleId);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        bill_template_version_id: before.billTemplateVersionId,
        version_no: 1,
        status: "DRAFT",
        checksum: digest,
        blob_ref: `invoice-templates/layouts/INVTPL-WHOLESALE/v1-${digest.slice(0, 12)}/`,
        last_modified_by: SECOND,
        change_note: null,
      });
      expect(rows[0]!.blob_ref).not.toBe(before.blobRef);
      // The replaced files stay in the blob store.
      expect(await h.blobNames(oldFolder)).toEqual(oldBlobs);

      const settingsAfter = await h.settingsDraft(wholesaleId);
      expect(settingsAfter.billTemplateVersionId).toBe(
        settingsBefore.billTemplateVersionId,
      );
      expect(settingsAfter.structure).toEqual(settingsBefore.structure);
      expect(settingsAfter.refLayoutVersionId).toBe(
        before.billTemplateVersionId,
      );
      expect(settingsAfter.token).not.toBe(settingsBefore.token);
      // One transaction, one now(): the layout and settings tokens are equal.
      expect((await layoutDraft(wholesaleId)).token).toBe(settingsAfter.token);

      const replaced = (await uploadedAudit()).filter(
        (r) => r.after_data.replaced === true,
      );
      expect(replaced).toHaveLength(1);
      expect(replaced[0]).toMatchObject({
        target_id: before.billTemplateVersionId,
        actor_user_id: SECOND,
        before_data: {
          blobRef: before.blobRef,
          checksum: before.checksum,
          pageSetup: before.pageSetup,
        },
      });
      expect(replaced[0]!.after_data).toMatchObject({
        familyId: wholesaleId,
        versionNo: 1,
        replaced: true,
        blobRef: rows[0]!.blob_ref,
        checksum: digest,
        previousBlobRef: before.blobRef,
        previousChecksum: before.checksum,
      });
    });

    it("a stale warning (the token from before the overwrite) is DRAFT_CHANGED_SINCE_WARNING and changes nothing", async () => {
      const current = await layoutDraft(wholesaleId);
      const auditBefore = await uploadedAudit();
      const rowsBefore = await layoutRows(wholesaleId);
      const blobsBefore = await h.blobNames("layouts/INVTPL-WHOLESALE/");

      const result = await upload(
        wholesaleId,
        markedPackage("INVTPL-WHOLESALE", 1, "MARKER-C").zip,
        {
          versionId: current.billTemplateVersionId,
          lastModified: "2026-01-01T00:00:00.000000Z",
        },
      );
      expect(result).toEqual({
        ok: false,
        code: "DRAFT_CHANGED_SINCE_WARNING",
        problems: [],
      });
      expect(await layoutRows(wholesaleId)).toEqual(rowsBefore);
      expect(await uploadedAudit()).toEqual(auditBefore);
      expect(await h.blobNames("layouts/INVTPL-WHOLESALE/")).toEqual(
        blobsBefore,
      );
    });

    it("the same bytes again succeed as an overwrite: same blob_ref, a new token, no blob created", async () => {
      const current = await layoutDraft(wholesaleId);
      const original = blobStore.putObject.bind(blobStore);
      const created: boolean[] = [];
      vi.spyOn(blobStore, "putObject").mockImplementation(
        async (...args: Parameters<typeof blobStore.putObject>) => {
          const put = await original(...args);
          created.push(put.created);
          return put;
        },
      );

      const result = await upload(
        wholesaleId,
        markedPackage("INVTPL-WHOLESALE", 1, "MARKER-B").zip,
        expected(current),
      );
      expect(result).toMatchObject({ ok: true, replaced: true });
      const after = await layoutDraft(wholesaleId);
      expect(after.blobRef).toBe(current.blobRef);
      expect(after.token).not.toBe(current.token);
      expect(created.length).toBeGreaterThan(0);
      expect(created.every((c) => c === false)).toBe(true);
    });

    it("an Activate with the settings token from before an overwrite is DRAFT_CONFLICT and promotes nothing (Inv #62)", async () => {
      const staleSettings = await h.settingsDraft(wholesaleId);
      const result = await upload(
        wholesaleId,
        markedPackage("INVTPL-WHOLESALE", 1, "MARKER-D").zip,
        expected(await layoutDraft(wholesaleId)),
      );
      expect(result).toMatchObject({ ok: true, replaced: true });

      const activated = await activateTemplate(
        {
          draftId: staleSettings.billTemplateVersionId,
          expectedDraftToken: staleSettings.token,
          changeNote: "Wholesale layout",
          familyId: wholesaleId,
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(activated).toEqual({ ok: false, code: "DRAFT_CONFLICT" });
      expect((await layoutRows(wholesaleId)).map((r) => r.status)).toEqual([
        "DRAFT",
      ]);
      expect(await h.blobNames("generated/INVOICE/WHOLESALE/")).toHaveLength(0);
    });

    it("an overwrite of a draft activated meanwhile is DRAFT_CHANGED_SINCE_WARNING", async () => {
      const warned = await layoutDraft(wholesaleId);
      const settings = await h.settingsDraft(wholesaleId);
      const activated = await activateTemplate(
        {
          draftId: settings.billTemplateVersionId,
          expectedDraftToken: settings.token,
          changeNote: "Wholesale layout",
          familyId: wholesaleId,
        },
        ACTOR,
        { render: cleanRender() },
      );
      expect(activated.ok).toBe(true);
      const rowsBefore = await layoutRows(wholesaleId);
      const auditBefore = await uploadedAudit();

      const result = await upload(
        wholesaleId,
        markedPackage("INVTPL-WHOLESALE", 1, "MARKER-E").zip,
        expected(warned),
      );
      expect(result).toEqual({
        ok: false,
        code: "DRAFT_CHANGED_SINCE_WARNING",
        problems: [],
      });
      expect(await layoutRows(wholesaleId)).toEqual(rowsBefore);
      expect(rowsBefore.map((r) => r.status)).toEqual(["ACTIVE"]);
      expect(await uploadedAudit()).toEqual(auditBefore);
    });

    it("guardrail 71 (concurrency half) — two creates with { none } on an empty type: one ok, one DRAFT_CHANGED_SINCE_WARNING, one layout DRAFT", async () => {
      const created = await createTemplateType({ name: "Race" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      blobBarrier(2);

      const results = await Promise.all([
        upload(
          created.typeId,
          markedPackage(created.layoutCode, 1, "RACE-1").zip,
          { none: true },
        ),
        upload(
          created.typeId,
          markedPackage(created.layoutCode, 1, "RACE-2").zip,
          { none: true },
          SECOND,
        ),
      ]);
      expect(results.filter((r) => r.ok)).toHaveLength(1);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, code: "DRAFT_CHANGED_SINCE_WARNING", problems: [] },
      ]);
      const rows = await layoutRows(created.typeId);
      expect(rows.map((r) => [r.version_no, r.status])).toEqual([[1, "DRAFT"]]);
    }, 120_000);

    it("guardrail 71 (concurrency half) — two overwrites carrying the same token: one ok, one DRAFT_CHANGED_SINCE_WARNING, one replace audited", async () => {
      const created = await createTemplateType({ name: "Race Two" }, ACTOR);
      if (!created.ok) throw new Error(`create type failed: ${created.code}`);
      const first = await upload(
        created.typeId,
        markedPackage(created.layoutCode, 1, "RACE-TWO-0").zip,
        { none: true },
      );
      if (!first.ok) throw new Error(`upload failed: ${first.code}`);
      const warned = expected(await layoutDraft(created.typeId));
      const auditBefore = (await uploadedAudit()).length;
      blobBarrier(2);

      const results = await Promise.all([
        upload(
          created.typeId,
          markedPackage(created.layoutCode, 1, "RACE-TWO-1").zip,
          warned,
        ),
        upload(
          created.typeId,
          markedPackage(created.layoutCode, 1, "RACE-TWO-2").zip,
          warned,
          SECOND,
        ),
      ]);
      expect(results.filter((r) => r.ok)).toEqual([
        {
          ok: true,
          versionId: first.versionId,
          versionNo: 1,
          replaced: true,
        },
      ]);
      expect(results.filter((r) => !r.ok)).toEqual([
        { ok: false, code: "DRAFT_CHANGED_SINCE_WARNING", problems: [] },
      ]);
      const rows = await layoutRows(created.typeId);
      expect(rows.map((r) => [r.version_no, r.status])).toEqual([[1, "DRAFT"]]);
      expect(await uploadedAudit()).toHaveLength(auditBefore + 1);
    }, 120_000);
  },
);
