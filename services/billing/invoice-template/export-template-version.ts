import { zipSync } from "fflate";

import { db } from "@/db/client";
import { insertAuditEvent } from "@/db/repositories/audit.repository";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { loadLayoutForExport } from "@/services/billing/invoice-template/load";
import { isShowable } from "@/services/billing/invoice-template/version-visibility";
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

export type ExportTemplateVersionResult =
  | { ok: true; fileName: string; bytes: Uint8Array }
  | { ok: false; code: "NOT_FOUND" }; // a checksum mismatch throws InvoiceRenderError

const SETTINGS_FILE = "settings.json";

export async function exportTemplateVersion(
  versionId: string,
  actor: { id: string; userName: string },
  canEdit: boolean,
): Promise<ExportTemplateVersionResult> {
  // A DRAFT pair (or a discarded one) exports only for EDIT, the rule for
  // viewing it (bm57); for a READ user it is a 404, as for an unknown id.
  const settings = await billTemplateVersionRepository.findById(db, versionId);
  if (!isShowable(settings, canEdit)) return { ok: false, code: "NOT_FOUND" };
  if (!settings.refLayoutVersionId || !settings.refBillTemplateFamilyId) {
    return { ok: false, code: "NOT_FOUND" };
  }
  const [layout, type] = await Promise.all([
    billTemplateVersionRepository.findById(db, settings.refLayoutVersionId),
    billTemplateFamilyRepository.findById(db, settings.refBillTemplateFamilyId),
  ]);
  if (!layout || !layout.layoutCode || !layout.checksum || !type) {
    return { ok: false, code: "NOT_FOUND" };
  }

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

  const bytes = zipSync({
    ...Object.fromEntries(
      [...files].map(([name, data]) => [name, new Uint8Array(data)]),
    ),
    [SETTINGS_FILE]: new Uint8Array(Buffer.from(settingsJson, "utf-8")),
  });
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
