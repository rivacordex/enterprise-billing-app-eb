import { db } from "@/db/client";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import {
  loadGeneratedFiles,
  type GeneratedVersionFile,
} from "@/services/billing/invoice-template/load";
import {
  InvoiceRenderError,
  type InvoiceErrorCode,
  type InvoiceTemplateStructure,
  type RecentPostedBill,
  type TemplateVersionHistoryRow,
  type TemplateVersionStatus,
} from "@/types/billing";

// bm55-spec §Design D4/D5 — the Invoice template page's and the file
// download's reads. Pages and the route handler reach the DB only through
// here (code-standards §3.1). Nothing is cached: the "current" version is
// resolved on every request (Inv #42).

// The preview source select lists this many posted bills (D4).
const RECENT_POSTED_BILLS_LIMIT = 20;

export interface InvoiceTemplatePageData {
  // The version new invoices use: the non-default ACTIVE ?? the default.
  current: BillTemplateVersion;
  // The version the page shows: `?version=` when it names a stored generated
  // version, else `current`.
  shown: BillTemplateVersion;
  shownStructure: InvoiceTemplateStructure;
  history: TemplateVersionHistoryRow[];
}

function toHistoryRow(
  row: BillTemplateVersion & { usedByCount: number },
  layoutLabels: ReadonlyMap<string, string>,
): TemplateVersionHistoryRow {
  return {
    billTemplateVersionId: row.billTemplateVersionId,
    versionNo: row.versionNo,
    status: row.status as TemplateVersionStatus,
    isDefault: row.isDefault,
    layoutLabel:
      (row.refLayoutVersionId && layoutLabels.get(row.refLayoutVersionId)) ??
      "—",
    createdBy: row.createdBy,
    createdAt: row.createdDatetime,
    activatedAt: row.activatedDatetime,
    retiredAt: row.retiredDatetime,
    changeNote: row.changeNote,
    usedByCount: row.usedByCount,
  };
}

// A version the page may show: a stored (non-DRAFT) generated version. A
// DRAFT becomes viewable to EDIT users once bm57 creates one.
function isShowable(
  row: BillTemplateVersion | null,
): row is BillTemplateVersion {
  return row !== null && row.kind === "generated" && row.status !== "DRAFT";
}

export async function getInvoiceTemplatePageData(
  versionId: string | undefined,
): Promise<InvoiceTemplatePageData> {
  const [active, fallback, selected, generatedRows, layoutRows] =
    await Promise.all([
      billTemplateVersionRepository.findActive(db, { kind: "generated" }),
      billTemplateVersionRepository.findDefault(db, { kind: "generated" }),
      versionId === undefined
        ? Promise.resolve(null)
        : billTemplateVersionRepository.findById(db, versionId),
      billTemplateVersionRepository.listForKind(db, { kind: "generated" }),
      billTemplateVersionRepository.listForKind(db, { kind: "layout" }),
    ]);

  const current = active ?? fallback;
  if (!current) {
    // The default rows are trigger-protected (bm50); a missing one is a
    // corrupted catalog, surfaced through error.tsx — never a blank page.
    throw new InvoiceRenderError(
      "TEMPLATE_VERSION_NOT_FOUND",
      "no ACTIVE or default generated template version",
      { kind: "generated" },
    );
  }

  const shown = isShowable(selected) ? selected : current;
  const layoutLabels = new Map(
    layoutRows.map((l) => [
      l.billTemplateVersionId,
      `${l.layoutCode ?? "layout"} v${l.versionNo}`,
    ]),
  );

  return {
    current,
    shown,
    // CHECK `btv_generated_has_layout` guarantees a generated row's structure.
    shownStructure: shown.structure!,
    history: generatedRows.map((r) => toHistoryRow(r, layoutLabels)),
  };
}

export type GeneratedHbsSources =
  | { ok: true; invoiceHbs: string; footerHbs: string }
  | { ok: false; code: InvoiceErrorCode };

// The Generated .hbs tab: the shown version's stored, checksum-verified bytes.
// A verification failure is reported, never rendered with unverified bytes.
export async function getGeneratedHbsSources(
  row: BillTemplateVersion,
): Promise<GeneratedHbsSources> {
  try {
    const files = await loadGeneratedFiles(row);
    return {
      ok: true,
      invoiceHbs: files["invoice.hbs"].toString("utf-8"),
      footerHbs: files["footer.hbs"].toString("utf-8"),
    };
  } catch (error) {
    if (error instanceof InvoiceRenderError) {
      return { ok: false, code: error.code };
    }
    throw error;
  }
}

// D5 — one stored file of a generated version, exactly the stored bytes
// (index + file digest verified by `loadGeneratedFiles`; a mismatch throws
// `TEMPLATE_CHECKSUM_MISMATCH`). `null` when the id is not a stored
// (non-DRAFT) generated version.
export async function getGeneratedVersionFile(
  versionId: string,
  file: GeneratedVersionFile,
): Promise<{ bytes: Buffer; versionNo: number } | null> {
  const row = await billTemplateVersionRepository.findById(db, versionId);
  if (!isShowable(row)) return null;
  const files = await loadGeneratedFiles(row);
  return { bytes: files[file], versionNo: row.versionNo };
}

// D3/D4 — the live preview's posted-bill sources. The page calls this only
// for a `billrun_view : READ` holder; the action re-checks that permission.
export async function listRecentPostedBills(): Promise<RecentPostedBill[]> {
  return customerBillRepository.listRecentPosted(db, RECENT_POSTED_BILLS_LIMIT);
}
