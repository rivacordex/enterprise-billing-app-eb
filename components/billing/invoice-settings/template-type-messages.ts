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
} as const;

// "A new draft v{n} will be created." / "Create draft v{n}" /
// "This type already has a draft layout v{n}." (bm80 replaces the last).
export function uploadCreatesDraft(n: number): string {
  return `A new draft v${n} will be created.`;
}
export function uploadConfirm(n: number): string {
  return `Create draft v${n}`;
}
export function uploadDraftOpen(n: number): string {
  return `This type already has a draft layout v${n}.`;
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
