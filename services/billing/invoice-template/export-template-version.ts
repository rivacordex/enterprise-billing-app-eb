import { zipSync, type Zippable } from "fflate";

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { loadLayoutForExport } from "@/services/billing/invoice-template/load";
import { isShowable } from "@/services/billing/invoice-template/version-visibility";
import { LAYOUT_PACKAGE_FILES } from "@/types/billing";
import {
  templateExportSettingsSchema,
  type TemplateExportSettings,
} from "@/validation/billing/template-export-settings.schema";

// bm81 (Inv #68; code-standards › Invoice Template Types, Next.js rule 2, API
// rule 2) — export one version PAIR, addressed by its settings (`generated`)
// version: the layout's VERIFIED stored bytes (every file plus checksums.json,
// through `loadLayoutForExport`, so a tampered blob throws
// TEMPLATE_CHECKSUM_MISMATCH and nothing is returned or audited) and a
// `settings.json` that checksums.json does not list. The audit row is written
// before the bytes are returned, and only after they verified.
// Review fix (#11) — the settings row, its layout row and the type are read in
// ONE read-only REPEATABLE READ snapshot (the invoice-csv.ts pattern), so a
// restore-overwrite committing between the reads can't pair one version's
// settings with another's files. The files then load by that layout row's
// content-addressed `blob_ref`, which is write-once.

export type ExportTemplateVersionResult =
  | { ok: true; fileName: string; bytes: Uint8Array<ArrayBuffer> }
  | { ok: false; code: "NOT_FOUND" }; // a checksum mismatch throws InvoiceRenderError

const SETTINGS_FILE = LAYOUT_PACKAGE_FILES.settings;

export async function exportTemplateVersion(
  versionId: string,
  actor: { id: string; userName: string },
  canEdit: boolean,
): Promise<ExportTemplateVersionResult> {
  // A DRAFT pair (or a discarded one) exports only for EDIT, the rule for
  // viewing it (bm57); for a READ user it is a 404, as for an unknown id.
  const pair = await db.transaction(
    async (tx) => {
      const settings = await billTemplateVersionRepository.findById(
        tx,
        versionId,
      );
      if (!isShowable(settings, canEdit)) return null;
      if (!settings.refLayoutVersionId || !settings.refBillTemplateFamilyId) {
        return null;
      }
      const layout = await billTemplateVersionRepository.findById(
        tx,
        settings.refLayoutVersionId,
      );
      const type = await billTemplateFamilyRepository.findById(
        tx,
        settings.refBillTemplateFamilyId,
      );
      if (!layout || !layout.layoutCode || !layout.checksum || !type) {
        return null;
      }
      return {
        settings,
        layout: {
          ...layout,
          layoutCode: layout.layoutCode,
          checksum: layout.checksum,
        },
        type,
      };
    },
    { isolationLevel: "repeatable read", accessMode: "read only" },
  );
  if (!pair) return { ok: false, code: "NOT_FOUND" };
  const { settings, layout, type } = pair;

  // Throws on any mismatch: no bytes, no audit row.
  const files = await loadLayoutForExport(layout);

  const content: TemplateExportSettings = templateExportSettingsSchema.parse({
    exportFormat: 1,
    source: {
      typeCode: type.code,
      typeName: type.name,
      layoutVersion: layout.versionNo,
      settingsVersion: settings.versionNo,
      status: settings.status,
      layoutChecksum: layout.checksum,
      exportedAt: new Date().toISOString(),
      exportedBy: actor.userName,
    },
    structure: settings.structure,
  });
  const settingsJson = `${JSON.stringify(content, null, 2)}\n`;

  // Review fix (cleanup) — woff2 is already compressed: store it (level 0)
  // instead of deflating it again for no size gain; the verified Buffers go in
  // as they are (a Buffer is a Uint8Array), with no copy.
  const entries: Zippable = {};
  for (const [name, data] of files) {
    entries[name] = name.endsWith(".woff2") ? [data, { level: 0 }] : data;
  }
  entries[SETTINGS_FILE] = Buffer.from(settingsJson, "utf-8");
  const bytes = zipSync(entries) as Uint8Array<ArrayBuffer>;
  const fileName = `${layout.layoutCode}-v${layout.versionNo}-s${settings.versionNo}.zip`;

  await insertAuditEvent(db, {
    eventType: "INVOICE_TEMPLATE_EXPORTED",
    actorUserId: actor.id,
    targetEntity: "BILL_TEMPLATE_VERSION",
    targetId: settings.billTemplateVersionId,
    beforeData: null,
    afterData: {
      familyId: type.billTemplateFamilyId,
      layoutVersionId: layout.billTemplateVersionId,
      layoutVersionNo: layout.versionNo,
      settingsVersionNo: settings.versionNo,
      layoutChecksum: layout.checksum,
      fileName,
    },
  });

  return { ok: true, fileName, bytes };
}
