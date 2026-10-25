import { db } from "@/db/client";
import { billTemplateFamilyRepository } from "@/db/repositories/billing/bill-template-family";
import { billTemplateVersionRepository } from "@/db/repositories/billing/bill-template-version";
import { customerBillRepository } from "@/db/repositories/billing/customer-bill.repository";
import type { BillTemplateVersion } from "@/db/schema/billing/bill-template-version";
import {
  loadGeneratedFiles,
  type GeneratedVersionFile,
} from "@/services/billing/invoice-template/load";
import { deriveTemplateTypeStatus } from "@/services/billing/invoice-template/template-types";
import {
  InvoiceRenderError,
  type InvoiceErrorCode,
  type InvoiceTemplateStructure,
  type RecentPostedBill,
  type TemplateDraftInfo,
  type TemplateTypeListRow,
  type TemplateTypeStatus,
  type TemplateVersionHistoryRow,
  type TemplateVersionStatus,
} from "@/types/billing";
import { invoiceTemplateStructureSchema } from "@/validation/billing/invoice-template-structure.schema";

// bm55-spec §Design D4/D5 — the Invoice template page's and the file
// download's reads. Pages and the route handler reach the DB only through
// here (code-standards §3.1). Nothing is cached: the "current" version is
// resolved on every request (Inv #42).

// The preview source select lists this many posted bills (D4).
const RECENT_POSTED_BILLS_LIMIT = 20;

// bm77 — the type the `[typeId]` page shows, whatever its state.
export interface InvoiceTemplateTypeHeader {
  typeId: string;
  // ui-context §10b — the type named in the page heading.
  typeName: string;
  typeStatus: TemplateTypeStatus;
  isDefaultType: boolean;
  layoutCode: string;
  // The version the type's next layout upload gets (bm78): max + 1, or 1.
  nextLayoutVersionNo: number;
  // bm78 — the type's open layout DRAFT (an upload not yet activated). While
  // one exists the Upload trigger is disabled (bm80 adds the overwrite path).
  openLayoutDraft: { versionId: string; versionNo: number } | null;
}

// The type has settings: today's editor data.
export interface InvoiceTemplateEditorData {
  empty: false;
  // The version new invoices use: the non-default ACTIVE ?? the default. bm78:
  // `null` for an uploaded-but-not-activated type (it has only a settings
  // DRAFT, which the page then shows).
  current: BillTemplateVersion | null;
  // The version the page shows: `?version=` when it names a stored generated
  // version of this type, else `defaultShown`.
  shown: BillTemplateVersion;
  // bm57 D4: the version the page opens on when no `?version=` names one: the
  // working DRAFT for an EDIT user who has one, else `current`.
  defaultShown: BillTemplateVersion;
  // bm57 D4: the working DRAFT, only ever loaded for EDIT users (READ users
  // never see it on the edit tab; it is still listed in `history`).
  draft: TemplateDraftInfo | null;
  shownStructure: InvoiceTemplateStructure;
  // `current`'s structure, parsed (the Activate dialog diffs against it);
  // `null` when there is no current version yet (bm78).
  currentStructure: InvoiceTemplateStructure | null;
  // bm79 — set when the working DRAFT points at a layout DRAFT (an uploaded
  // pair): the Activate dialog's "Layout: <code> v<old> → v<new>" line.
  // `fromVersionNo` is the current settings version's layout, or `null`.
  layoutChange: {
    code: string;
    fromVersionNo: number | null;
    toVersionNo: number;
  } | null;
  history: TemplateVersionHistoryRow[];
}

// bm77 — a type with no settings at all ("Not yet usable": nothing uploaded
// yet) renders the empty state instead of the editor. bm78: a type with only a
// settings DRAFT (uploaded, not activated) renders the editor on that draft for
// an EDIT user; a READ user, who never sees drafts, still gets the empty state.
export type InvoiceTemplatePageData = InvoiceTemplateTypeHeader &
  (InvoiceTemplateEditorData | { empty: true; current: null; history: [] });

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

// A generated version's stored structure, parsed with the editor's schema. A
// row that fails it was written before the schema changed (e.g. a database
// migrated before bm72 rewrote the `0046` seed in place, so with no
// `footnote`): a corrupted catalog that needs the bm64 reset, surfaced
// through error.tsx rather than a TypeError in the form.
function parseStoredStructure(
  row: BillTemplateVersion,
): InvoiceTemplateStructure {
  const parsed = invoiceTemplateStructureSchema.safeParse(row.structure);
  if (!parsed.success) {
    throw new InvoiceRenderError(
      "TEMPLATE_VERSION_NOT_FOUND",
      `generated version ${row.billTemplateVersionId} has a structure the current schema refuses; reset the template catalog`,
      {
        reason: "STRUCTURE_INVALID",
        versionId: row.billTemplateVersionId,
        issues: parsed.error.issues.map((i) => i.path.join(".")),
      },
    );
  }
  return parsed.data;
}

// A version the page may show: a stored generated version, or a draft for an
// EDIT user (bm57 D4). Review fix (bm79) — a discarded draft (RETIRED, never
// activated) has no files and is still a draft: only EDIT users may open it,
// and it is never a stored version (no file download, no Generated files).
function isDraftLike(row: BillTemplateVersion): boolean {
  return row.status === "DRAFT" || row.activatedDatetime === null;
}

function isShowable(
  row: BillTemplateVersion | null,
  canEdit: boolean,
): row is BillTemplateVersion {
  return (
    row !== null && row.kind === "generated" && (!isDraftLike(row) || canEdit)
  );
}

export async function getInvoiceTemplatePageData(
  typeId: string,
  versionId: string | undefined,
  { canEdit }: { canEdit: boolean },
): Promise<InvoiceTemplatePageData | null> {
  // bm77 — the type comes from the URL, never `findDefault`. Its current
  // version, draft and history are scoped to it (review fix §24c). An unknown
  // type is `null`: the page calls `notFound()`.
  const type = await billTemplateFamilyRepository.findById(db, typeId);
  if (!type) return null;
  const familyId = type.billTemplateFamilyId;
  const [active, fallback, selected, generatedRows, layoutRows, draftRow] =
    await Promise.all([
      billTemplateVersionRepository.findActive(db, {
        kind: "generated",
        familyId,
      }),
      billTemplateVersionRepository.findDefault(db, {
        kind: "generated",
        familyId,
      }),
      versionId === undefined
        ? Promise.resolve(null)
        : billTemplateVersionRepository.findById(db, versionId),
      billTemplateVersionRepository.listForKind(db, {
        kind: "generated",
        familyId,
      }),
      billTemplateVersionRepository.listForKind(db, {
        kind: "layout",
        withUsage: false,
        familyId,
      }),
      canEdit
        ? billTemplateVersionRepository.findDraft(db, {
            kind: "generated",
            familyId,
          })
        : Promise.resolve(null),
    ]);
  const openLayout = layoutRows.find((l) => l.status === "DRAFT") ?? null;

  const current = active ?? fallback;
  const header: InvoiceTemplateTypeHeader = {
    typeId: familyId,
    typeName: type.name,
    typeStatus: deriveTemplateTypeStatus(type, current !== null),
    isDefaultType: type.isDefault,
    layoutCode: type.layoutCode,
    nextLayoutVersionNo:
      layoutRows.reduce((max, l) => Math.max(max, l.versionNo), 0) + 1,
    openLayoutDraft: openLayout
      ? {
          versionId: openLayout.billTemplateVersionId,
          versionNo: openLayout.versionNo,
        }
      : null,
  };
  // A type with no settings yet (created empty; bm78 uploads the first
  // layout) — not an error, the page renders the empty state.
  // Nothing to show: no settings at all, or (for a READ user) only a draft.
  const defaultShown = draftRow ?? current;
  if (!defaultShown) {
    return { ...header, empty: true, current: null, history: [] };
  }

  // A `?version=` from another type falls back too: the heading names this
  // type, and the history lists its versions only.
  const shown =
    isShowable(selected, canEdit) &&
    selected.refBillTemplateFamilyId === familyId
      ? selected
      : defaultShown;
  const draft: TemplateDraftInfo | null = draftRow
    ? {
        billTemplateVersionId: draftRow.billTemplateVersionId,
        versionNo: draftRow.versionNo,
        token: draftRow.token,
        savedAt: draftRow.lastModifiedDatetime,
        savedBy: await billTemplateVersionRepository.findLatestDraftSaver(
          db,
          draftRow.billTemplateVersionId,
        ),
      }
    : null;
  const layoutById = new Map(
    layoutRows.map((l) => [l.billTemplateVersionId, l]),
  );
  const draftLayout = draftRow?.refLayoutVersionId
    ? layoutById.get(draftRow.refLayoutVersionId)
    : undefined;
  const currentLayout = current?.refLayoutVersionId
    ? layoutById.get(current.refLayoutVersionId)
    : undefined;
  const layoutChange =
    draftLayout?.status === "DRAFT"
      ? {
          code: type.layoutCode,
          fromVersionNo: currentLayout?.versionNo ?? null,
          toVersionNo: draftLayout.versionNo,
        }
      : null;
  const layoutLabels = new Map(
    layoutRows.map((l) => [
      l.billTemplateVersionId,
      `${l.layoutCode ?? "layout"} v${l.versionNo}${l.status === "DRAFT" ? " (draft)" : ""}`,
    ]),
  );

  return {
    ...header,
    empty: false,
    current,
    shown,
    defaultShown,
    draft,
    shownStructure: parseStoredStructure(shown),
    currentStructure: current ? parseStoredStructure(current) : null,
    layoutChange,
    history: generatedRows.map((r) => toHistoryRow(r, layoutLabels)),
  };
}

// bm77 — the type list: every type, the default first, with its derived
// status and the settings version new invoices of that type use.
export async function listTemplateTypes(): Promise<TemplateTypeListRow[]> {
  const [types, activeByType] = await Promise.all([
    billTemplateFamilyRepository.listAll(db),
    billTemplateVersionRepository.listActiveSettingsByFamily(db),
  ]);
  return types.map((t) => {
    const active = activeByType.get(t.billTemplateFamilyId) ?? null;
    return {
      billTemplateFamilyId: t.billTemplateFamilyId,
      name: t.name,
      isDefault: t.isDefault,
      status: deriveTemplateTypeStatus(t, active !== null),
      activeVersionNo: active?.versionNo ?? null,
      activeSince: active?.activatedDatetime ?? null,
      retiredAt: t.retiredDatetime,
    };
  });
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
  if (!isShowable(row, false)) return null;
  const files = await loadGeneratedFiles(row);
  return { bytes: files[file], versionNo: row.versionNo };
}

// D3/D4 — the live preview's posted-bill sources. The page calls this only
// for a `billrun_view : READ` holder; the action re-checks that permission.
export async function listRecentPostedBills(): Promise<RecentPostedBill[]> {
  return customerBillRepository.listRecentPosted(db, RECENT_POSTED_BILLS_LIMIT);
}
