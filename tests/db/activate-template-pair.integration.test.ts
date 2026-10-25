import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";

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
import { blobStore } from "@/services/billing/blob-store";
import { activateTemplate } from "@/services/billing/invoice-template/activate-template";
import { saveTemplateDraft } from "@/services/billing/invoice-template/save-template-draft";
import { listTemplateTypes } from "@/services/billing/read/invoice-template-settings";
import { cleanRender } from "@/tests/helpers/layout-package";
import { registerTemplateTypeDb } from "@/tests/db/helpers/template-type-db-harness";

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
    let wholesaleId: string;
    const h = registerTemplateTypeDb({
      databaseUrl,
      blobConnection,
      actor: {
        id: ACTOR,
        name: "Template Activator",
        email: "template-activator@example.com",
      },
      blobPrefixes: BLOB_PREFIXES,
      holder: hoisted.holder,
    });

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
      return h.sql<
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

    const activatedAudit = () => h.auditRows("INVOICE_TEMPLATE_ACTIVATED");

    let standardBefore: Awaited<ReturnType<typeof typeRows>>;

    beforeAll(async () => {
      wholesaleId = await h.createTypeWithLayout("Wholesale");
      standardBefore = await typeRows("BTF00000001");
    }, 180_000);

    afterEach(() => {
      vi.restoreAllMocks();
    });

    it("[Inv #63] a layout DRAFT that fails the compliance re-run is LAYOUT_REJECTED and writes nothing (no generated blob)", async () => {
      const before = await typeRows(wholesaleId);
      const auditBefore = (await activatedAudit()).length;
      const result = await activate(
        wholesaleId,
        await h.settingsDraft(wholesaleId),
        cleanRender(["http://x/a.png"]),
      );
      expect(result).toMatchObject({ ok: false, code: "LAYOUT_REJECTED" });
      if (result.ok || result.code !== "LAYOUT_REJECTED") return;
      expect(result.problems.map((p) => p.code)).toContain(
        "LAYOUT_EXTERNAL_FETCH",
      );
      expect(await typeRows(wholesaleId)).toEqual(before);
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(await h.blobNames("generated/INVOICE/WHOLESALE/")).toHaveLength(0);
    }, 120_000);

    it("an upload re-point committed between the blob writes and the transaction is DRAFT_CONFLICT and promotes nothing", async () => {
      const draft = await h.settingsDraft(wholesaleId);
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
            await h.db.transaction((tx) =>
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
      const draft = await h.settingsDraft(wholesaleId);
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
        h.sql`UPDATE billing.bill_template_version SET blob_ref = 'invoice-templates/layouts/x/'
            WHERE bill_template_version_id = ${layout.bill_template_version_id}`,
      ).rejects.toThrow(/VERSION_IMMUTABLE/);
    });

    it("a second upload and activation retires the v1 pair and promotes v2; the audit names v1", async () => {
      const v1 = await typeRows(wholesaleId);
      const layoutV1 = v1.find((r) => r.kind === "layout")!;
      const settingsV1 = v1.find((r) => r.kind === "generated")!;
      await h.upload(wholesaleId, "INVTPL-WHOLESALE", 2);
      const result = await activate(
        wholesaleId,
        await h.settingsDraft(wholesaleId),
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
      await h.upload(wholesaleId, "INVTPL-WHOLESALE", 3);
      const t1 = await h.settingsDraft(wholesaleId);
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
        await h.blobNames(`generated/INVOICE/WHOLESALE/v${saved.versionNo}-`),
      ).toHaveLength(0);

      const ok = await activate(wholesaleId, t1);
      expect(ok).toMatchObject({ ok: true, versionNo: saved.versionNo });
      if (!ok.ok) return;
      expect(ok.layout).toMatchObject({ versionNo: 3 });
    }, 120_000);

    it("[Inv #67] a type retired via SQL is TEMPLATE_TYPE_RETIRED and nothing is written", async () => {
      const typeId = await h.createTypeWithLayout("Old Pair");
      const draft = await h.settingsDraft(typeId);
      await h.sql`
        UPDATE billing.bill_template_family SET retired_datetime = now()
        WHERE bill_template_family_id = ${typeId}`;
      const before = await typeRows(typeId);
      const auditBefore = (await activatedAudit()).length;

      expect(await activate(typeId, draft)).toEqual({
        ok: false,
        code: "TEMPLATE_TYPE_RETIRED",
      });
      expect(await typeRows(typeId)).toEqual(before);
      expect(await activatedAudit()).toHaveLength(auditBefore);
      expect(await h.blobNames("generated/INVOICE/OLD_PAIR/")).toHaveLength(0);
    }, 120_000);

    it("Standard is untouched: none of its rows changed across every Wholesale activation", async () => {
      expect(await typeRows("BTF00000001")).toEqual(standardBefore);
    });
  },
);
