// bm77 (code-standards › Invoice Template Types, Styling rule 6) — the exact
// UI strings of the template type list, create dialog and detail page,
// defined once and reused by the components and their tests. Later units
// (bm78 upload, bm79 activate/discard, bm83 retire) add theirs here.
export const TEMPLATE_TYPE_MESSAGES = {
  listHeading: "Invoice template types",
  createTrigger: "New invoice template type",
  createTitle: "New invoice template type",
  nameLabel: "Name",
  nameHint:
    "3–60 letters, digits, spaces, & ( ) or -. The name can't be changed later.",
  nameTaken:
    "An invoice template type with this name already exists (names of retired types stay reserved).",
  createFailed: "The invoice template type could not be created. Try again.",
  createForbidden:
    "You do not have permission to create an invoice template type.",
  backToList: "← All invoice template types",
  emptyState:
    "No layout uploaded yet. Upload a layout package to create the first draft.",
  showRetired: "Show retired types",
  hideRetired: "Hide retired types",
  // bm78 — the upload dialog.
  uploadTrigger: "Upload layout package",
  uploadTitle: "Upload layout package",
  uploadFileLabel: "Layout package (.zip)",
  uploadChecking: "Checking package…",
  uploadRejected: "The layout package was refused.",
  uploadFailed: "The layout package could not be uploaded. Try again.",
  uploadForbidden: "You do not have permission to upload a layout package.",
  uploadDraftChanged:
    "This type's drafts changed since you opened the page. The page has been reloaded — check the draft and try again.",
  uploadTypeRetired:
    "This invoice template type has been retired, so a layout can no longer be uploaded to it.",
  // bm80 — the overwrite path (Styling rules 3 and 6).
  overwriteTitle: "Overwrite the draft layout?",
  overwriteConfirm: "Overwrite draft",
  // A layout DRAFT with no recorded writer: `last_modified_by` is SET NULL when
  // the uploader is deleted (the approve-and-post panel's wording).
  overwriteNoAuthor: "an unknown user",
  overwriteStale:
    "The draft changed since this warning was shown. Review the updated warning and try again.",
  layoutReplacedSave:
    "The layout was replaced by an upload. Your unsaved changes are kept below; review and save again.",
  // bm79 — Activate (the pair) and Discard.
  firstVersionOfType: "First version of this type.",
  activateLayoutRejected:
    "The layout no longer passes the compliance check. Nothing was activated.",
  activateLayoutRejectedTitle: "The draft layout failed the compliance check.",
  typeRetired:
    "This invoice template type has been retired, so its drafts can no longer be activated or discarded.",
  discardTrigger: "Discard",
  discardConfirm: "Discard draft",
  discardFailed: "The draft could not be discarded. Please try again.",
  discardForbidden: "You do not have permission to discard a draft.",
  // bm81 — Export (Version history) and the restore note (upload dialog).
  exportLink: "Export",
  // bm83 — save and preview on a retired type (typeRetired above is worded
  // for activate and discard).
  typeRetiredEdit:
    "This invoice template type has been retired, so it can no longer be edited or previewed.",
  // bm83 — the Retire dialog (ui-context §10e).
  retireTrigger: "Retire type…",
  retireConfirm: "Retire type",
  retireBoundBansLabel: "billing accounts bound to this type",
  retireNoBoundBans: "No billing accounts are bound to this type.",
  retireShowMore: "Show more",
  retireTargetLabel: "Move its billing accounts to",
  retireNameLabel: "Type the name of this type to confirm",
  retireAlreadyRetired: "This invoice template type has already been retired.",
  retireDefaultNotRetirable: "The Standard type can't be retired.",
  retireTargetNotUsable:
    "The chosen type can no longer take billing accounts. Choose another type.",
  retireNameMismatch:
    "The typed name doesn't match this type's name. Nothing was retired.",
  retireFailed: "The invoice template type could not be retired. Try again.",
  retireForbidden:
    "You do not have permission to retire an invoice template type.",
  retireListFailed: "More billing accounts could not be loaded. Try again.",
} as const;

// "A new draft v{n} will be created." / "Create draft v{n}".
export function uploadCreatesDraft(n: number): string {
  return `A new draft v${n} will be created.`;
}
export function uploadConfirm(n: number): string {
  return `Create draft v${n}`;
}

// bm80 — the upload success toasts: created (bm78's wording) or replaced.
export function uploadCreatedToast(n: number): string {
  return `Draft v${n} created`;
}
export function uploadReplacedToast(n: number): string {
  return `Draft v${n} replaced`;
}

// bm80 — the exact overwrite warning (code-standards › Invoice Template Types,
// Styling rule 6), from the page's server data. bm81 review fix (#3, plan
// D127): when the chosen package is an app export, its settings replace the
// draft settings, so the last sentence becomes RESTORE_NOTE instead of "kept".
export function OVERWRITE_WARNING(
  n: number,
  date: string,
  user: string,
  settingsReplaced = false,
): string {
  const settings = settingsReplaced
    ? RESTORE_NOTE
    : "Your draft settings (Payment and footnote) are kept.";
  return `This type already has a draft (layout v${n}, last changed ${date} by ${user}). Uploading will overwrite the existing draft layout. ${settings}`;
}
export const LAYOUT_REPLACED_SAVE_MESSAGE =
  TEMPLATE_TYPE_MESSAGES.layoutReplacedSave;

// bm81 (code-standards › Invoice Template Types, Styling rule 6; ui-context
// §10e) — the upload dialog's restore note, shown when the chosen zip carries a
// schema-valid settings.json. Advisory only: the server decides.
export const RESTORE_NOTE =
  "The package's settings (Payment and footnote) will replace the draft settings.";
export function RESTORED_FROM(n: number): string {
  return `Restored from v${n}`;
}

// bm79 — the Activate dialog's layout line: "Layout: <code> v<old> → v<new>",
// or "Layout: <code> v<n> (first version)" for a type with no ACTIVE layout.
export function layoutChangeLine(change: {
  code: string;
  fromVersionNo: number | null;
  toVersionNo: number;
}): string {
  return change.fromVersionNo === null
    ? `Layout: ${change.code} v${change.toVersionNo} (first version)`
    : `Layout: ${change.code} v${change.fromVersionNo} → v${change.toVersionNo}`;
}

// bm79 — the Discard dialog.
export function discardTitle(n: number): string {
  return `Discard draft v${n}?`;
}
export function discardBody(
  n: number,
  layoutDraft: { code: string; versionNo: number } | null,
): string {
  return layoutDraft
    ? `The draft settings v${n} and the draft layout ${layoutDraft.code} v${layoutDraft.versionNo} will be retired. Their version numbers are not reused.`
    : `The draft settings v${n} will be retired. Their version numbers are not reused.`;
}

// bm83 — the Retire dialog's title and body, and the success toast.
export function retireTitle(name: string): string {
  return `Retire ${name}?`;
}
export function retireBody(name: string): string {
  return `Every billing account bound to ${name} moves to the type you choose, and ${name} is retired. This can't be undone. Its versions, history and exports are kept.`;
}
export function retireSuccessToast(
  name: string,
  n: number,
  target: string,
): string {
  return `${name} retired. ${n} billing accounts moved to ${target}.`;
}
// bm83 (ui-context §10e) — the retired type's Info status line.
export function retiredStatusLine(date: string): string {
  return `Retired ${date}. History and exports remain available.`;
}
