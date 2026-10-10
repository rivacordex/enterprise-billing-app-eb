"use client";

// bm55-spec §Design D4 (`edit` tab), code-standards Part 2 Next.js rules 5/6,
// Styling rule 7, ui-context §10b — `InvoiceStructureForm`, the template
// editor's interaction leaf. It holds the admin's UNSAVED structure and drives
// the live preview: any change → a 400 ms debounced call to
// `previewInvoiceTemplateAction` (a READ that saves nothing). bm57 adds **Save
// draft** (EDIT only): it saves the structure as the single working DRAFT with
// an optimistic token (`DRAFT_CONFLICT` on a stale one). bm58 adds **Activate**
// (EDIT only): enabled only when a saved draft exists and the form has no
// unsaved changes (otherwise "Save draft first"), it opens the shared
// `ActivateVersionDialog`, which asks for the required change note.
//
//   - mandatory sections: checked + disabled + `Lock` + "Required" in
//     `--text-muted`; the label stays `--text-body`, so a locked-on section
//     never looks switched off;
//   - read-only (a READ user, or a non-current version opened from history):
//     sections/columns render as text "Shown"/"Hidden" with no grey wash —
//     the placeholder/outline toggles and the source select still drive the
//     preview;
//   - the source select offers the layout's sample bill and, only for a
//     `billrun_view` holder, the most recent posted bills.

import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";
import { Info, Lock } from "lucide-react";
import { toast } from "sonner";

import {
  activateTemplateAction,
  type ActivateTemplateActionResult,
} from "@/actions/billing/invoice-settings/activate-template.action";
import { saveTemplateDraftAction } from "@/actions/billing/invoice-settings/save-template-draft.action";
import { previewInvoiceTemplateAction } from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import {
  ActivateVersionDialog,
  type ActivateConfirmResult,
} from "@/components/billing/invoice-settings/activate-version-dialog";
import {
  COLUMN_LABELS,
  SECTION_ROWS,
  describeStructureChanges,
} from "@/components/billing/invoice-settings/structure-labels";
import {
  InvoicePreviewFrame,
  type PreviewError,
  type PreviewStatus,
} from "@/components/billing/invoice-settings/invoice-preview-frame";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import {
  INVOICE_COLUMN_KEYS,
  INVOICE_OPTIONAL_SECTION_KEYS,
  type InvoiceColumnKey,
  type InvoiceSectionKey,
  type InvoiceTemplateStructure,
  type RecentPostedBill,
} from "@/types/billing";

const SAMPLE = "sample";
const DEBOUNCE_MS = 400;
// ui-context §6c — past a normal render window the caption reads "Queued".
const QUEUED_HINT_DELAY_MS = 2_500;

function isOptional(key: InvoiceSectionKey): boolean {
  return (INVOICE_OPTIONAL_SECTION_KEYS as readonly string[]).includes(key);
}

interface PreviewState {
  status: PreviewStatus;
  html: string | null;
  templateLabel: string | null;
  pinnedVersionNo: number | null;
  error: PreviewError | null;
}

const ACTIVATE_MESSAGES = {
  CHANGE_NOTE_REQUIRED: "A change note is required.",
  DRAFT_CONFLICT: "Another user changed the draft — reload to see it.",
  MANDATORY_SECTION_HIDDEN:
    "A required section is hidden in the draft, so it cannot be activated.",
  TEMPLATE_CHECKSUM_MISMATCH:
    "A stored layout file failed verification. Nothing was activated.",
  TEMPLATE_VERSION_NOT_FOUND:
    "The draft's layout could not be found. Nothing was activated.",
  TEMPLATE_GENERATION_FAILED:
    "The template could not be generated. Nothing was activated.",
  TEMPLATE_COMPILE_FAILED:
    "The generated template failed its test render. Nothing was activated.",
  ACTIVATION_BLOB_CONFLICT:
    "A different file already exists at the target path. Nothing was activated.",
  FORBIDDEN: "You do not have permission to activate a template.",
  VALIDATION_ERROR: "The request was not valid. Reload and try again.",
  SERVER_ERROR: "The version could not be activated. Please try again.",
} as const;

function activateMessage(
  result: Extract<ActivateTemplateActionResult, { ok: false }>,
): string {
  return ACTIVATE_MESSAGES[result.code];
}

export interface InvoiceStructureFormProps {
  initialStructure: InvoiceTemplateStructure;
  // false for a READ user or a version opened read-only from history.
  editable: boolean;
  recentBills: RecentPostedBill[];
  canPreviewBills: boolean;
  // bm57: the working draft's concurrency token as the page loaded it, or
  // `null` when no draft exists. Sent back with every save.
  expectedDraftToken?: string | null;
  // bm58: the working draft's id and version number (for Activate), and the
  // structure currently in use for new invoices (for the dialog's diff).
  draftVersionId?: string | null;
  draftVersionNo?: number | null;
  activeStructure?: InvoiceTemplateStructure | null;
}

function RequiredMark(): React.JSX.Element {
  return (
    <span className="inline-flex items-center gap-1 text-caption text-[color:var(--text-muted)]">
      <Lock size={12} aria-hidden />
      Required
    </span>
  );
}

function ReadOnlyValue({ shown }: { shown: boolean }): React.JSX.Element {
  return (
    <span className="text-body-sm text-foreground">
      {shown ? "Shown" : "Hidden"}
    </span>
  );
}

export function InvoiceStructureForm({
  initialStructure,
  editable,
  recentBills,
  canPreviewBills,
  expectedDraftToken = null,
  draftVersionId = null,
  draftVersionNo = null,
  activeStructure = null,
}: InvoiceStructureFormProps): React.JSX.Element {
  const router = useRouter();
  const [structure, setStructure] = useState(initialStructure);
  // bm57: the last-saved structure (pristine = unchanged since load or save),
  // the live token, the in-flight flag and the server's per-row refusals.
  const [saved, setSaved] = useState(initialStructure);
  const [draftToken, setDraftToken] = useState(expectedDraftToken);
  const [draftId, setDraftId] = useState(draftVersionId);
  const [draftNo, setDraftNo] = useState(draftVersionNo);
  const [activateOpen, setActivateOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [hiddenErrors, setHiddenErrors] = useState<ReadonlySet<string>>(
    new Set(),
  );
  const pristine = JSON.stringify(structure) === JSON.stringify(saved);
  // bm58 D1: activate only what the history already shows, i.e. a saved draft
  // with no unsaved edits.
  const canActivate = pristine && draftId !== null && !saving;
  const activateLabel = !pristine
    ? "Save draft first"
    : draftNo !== null
      ? `Activate v${draftNo}`
      : "Activate";
  const structureChanges = activeStructure
    ? describeStructureChanges(activeStructure, saved)
    : [];
  const [source, setSource] = useState<string>(SAMPLE);
  const [annotate, setAnnotate] = useState(false);
  const [outline, setOutline] = useState(false);
  const [retryToken, setRetryToken] = useState(0);
  const [preview, setPreview] = useState<PreviewState>({
    status: "loading",
    html: null,
    templateLabel: null,
    pinnedVersionNo: null,
    error: null,
  });
  // The latest request's id — a settling request that no longer holds it is
  // stale and never overwrites newer state.
  const requestRef = useRef(0);

  // Called from event handlers only (react-hooks/set-state-in-effect).
  function markLoading(): void {
    setPreview((p) => ({ ...p, status: "loading", error: null }));
  }

  useEffect(() => {
    const id = ++requestRef.current;
    const debounce = setTimeout(() => {
      const queued = setTimeout(() => {
        if (requestRef.current !== id) return;
        setPreview((p) =>
          p.status === "loading" ? { ...p, status: "queued" } : p,
        );
      }, QUEUED_HINT_DELAY_MS);

      previewInvoiceTemplateAction({
        structure,
        source: source === SAMPLE ? "sample" : { billId: source },
        annotate,
        outline,
      })
        .then((result) => {
          if (requestRef.current !== id) return;
          if (result.ok) {
            setPreview({
              status: "ready",
              html: result.html,
              templateLabel: result.templateLabel,
              pinnedVersionNo: result.pinnedVersionNo,
              error: null,
            });
          } else {
            setPreview((p) => ({
              ...p,
              status: "error",
              error: { code: result.code, detail: result.detail },
            }));
          }
        })
        .catch(() => {
          if (requestRef.current !== id) return;
          setPreview((p) => ({
            ...p,
            status: "error",
            error: { code: "PREVIEW_FAILED" },
          }));
        })
        .finally(() => clearTimeout(queued));
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounce);
  }, [structure, source, annotate, outline, retryToken]);

  async function saveDraft(): Promise<void> {
    setSaving(true);
    setHiddenErrors(new Set());
    try {
      const result = await saveTemplateDraftAction({
        structure,
        expectedDraftToken: draftToken,
      });
      if (result.ok) {
        setSaved(structure);
        setDraftToken(result.draftToken);
        setDraftId(result.versionId);
        setDraftNo(result.versionNo);
        toast.success(
          `Draft v${result.versionNo} saved — not used on invoices`,
        );
        return;
      }
      if (result.code === "DRAFT_CONFLICT") {
        toast.warning("Another user changed the draft — reload to see it.", {
          action: { label: "Reload", onClick: () => router.refresh() },
        });
      } else if (result.code === "MANDATORY_SECTION_HIDDEN") {
        setHiddenErrors(
          new Set(
            Object.keys(result.fieldErrors).map((p) => p.split(".").pop()!),
          ),
        );
      } else if (result.code === "FORBIDDEN") {
        toast.error("You do not have permission to save the draft.");
      } else {
        toast.error("The draft could not be saved. Please try again.");
      }
    } catch {
      toast.error("The draft could not be saved. Please try again.");
    } finally {
      setSaving(false);
    }
  }

  async function activate(changeNote: string): Promise<ActivateConfirmResult> {
    if (draftId === null || draftToken === null) {
      return { ok: false, message: ACTIVATE_MESSAGES.DRAFT_CONFLICT };
    }
    const result = await activateTemplateAction({
      draftId,
      expectedDraftToken: draftToken,
      changeNote,
    });
    if (result.ok) {
      toast.success(`Template v${result.versionNo} activated`);
      router.refresh();
      return { ok: true };
    }
    return { ok: false, message: activateMessage(result) };
  }

  function toggleSection(key: InvoiceSectionKey, value: boolean): void {
    markLoading();
    setStructure((s) => ({ ...s, sections: { ...s.sections, [key]: value } }));
  }

  function toggleColumn(key: InvoiceColumnKey, value: boolean): void {
    markLoading();
    setStructure((s) => ({ ...s, columns: { ...s.columns, [key]: value } }));
  }

  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-6">
        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Sections
          </legend>
          {SECTION_ROWS.map(({ key, label }) => {
            const optional = isOptional(key);
            const id = `section-${key}`;
            return (
              <div
                key={key}
                className="flex flex-wrap items-center justify-between gap-3"
                data-testid={id}
              >
                {editable ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={structure.sections[key]}
                      disabled={!optional}
                      onCheckedChange={(v) => toggleSection(key, v === true)}
                    />
                    <Label
                      htmlFor={id}
                      className="text-body-sm text-foreground"
                    >
                      {label}
                    </Label>
                  </div>
                ) : (
                  <span className="text-body-sm text-foreground">{label}</span>
                )}
                {!optional ? (
                  <span className="flex items-center gap-3">
                    {editable ? null : <ReadOnlyValue shown />}
                    <RequiredMark />
                  </span>
                ) : editable ? null : (
                  <ReadOnlyValue shown={structure.sections[key]} />
                )}
                {hiddenErrors.has(key) ? (
                  <p
                    role="alert"
                    className="w-full text-caption text-[color:var(--color-danger-700)]"
                  >
                    This section is required and cannot be hidden.
                  </p>
                ) : null}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Charge-detail columns
          </legend>
          <p className="text-caption text-muted-foreground">
            Always shown: #, Description, Quantity, Unit price, Gross, Net
            amount.
          </p>
          {INVOICE_COLUMN_KEYS.map((key) => {
            const id = `column-${key}`;
            return (
              <div
                key={key}
                className="flex items-center justify-between gap-3"
                data-testid={id}
              >
                {editable ? (
                  <div className="flex items-center gap-2">
                    <Checkbox
                      id={id}
                      checked={structure.columns[key]}
                      onCheckedChange={(v) => toggleColumn(key, v === true)}
                    />
                    <Label
                      htmlFor={id}
                      className="text-body-sm text-foreground"
                    >
                      {COLUMN_LABELS[key]}
                    </Label>
                  </div>
                ) : (
                  <>
                    <span className="text-body-sm text-foreground">
                      {COLUMN_LABELS[key]}
                    </span>
                    <ReadOnlyValue shown={structure.columns[key]} />
                  </>
                )}
              </div>
            );
          })}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Preview
          </legend>
          <div className="space-y-1.5">
            <Label htmlFor="preview-source" className="text-body-sm">
              Preview with
            </Label>
            <Select
              value={source}
              onValueChange={(value) => {
                markLoading();
                setSource(value);
              }}
            >
              <SelectTrigger id="preview-source" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={SAMPLE}>Sample bill</SelectItem>
                {canPreviewBills
                  ? recentBills.map((bill) => (
                      <SelectItem
                        key={bill.customerBillId}
                        value={bill.customerBillId}
                      >
                        <span className="font-mono text-mono">
                          {bill.invoiceNumber}
                        </span>{" "}
                        · {bill.accountName}
                      </SelectItem>
                    ))
                  : null}
              </SelectContent>
            </Select>
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="preview-annotate" className="text-body-sm">
              Show placeholders
            </Label>
            <Switch
              id="preview-annotate"
              checked={annotate}
              onCheckedChange={(v) => {
                markLoading();
                setAnnotate(v);
              }}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="preview-outline" className="text-body-sm">
              Outline
            </Label>
            <Switch
              id="preview-outline"
              checked={outline}
              onCheckedChange={(v) => {
                markLoading();
                setOutline(v);
              }}
            />
          </div>
        </fieldset>

        {editable ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pristine || saving}
              onClick={() => void saveDraft()}
            >
              {saving ? "Saving…" : "Save draft"}
            </Button>
            <button
              type="button"
              disabled={!canActivate}
              title={
                canActivate
                  ? undefined
                  : pristine
                    ? "Save a draft first"
                    : "Save the draft before activating"
              }
              onClick={() => setActivateOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md bg-[color:var(--billrun-cta-bg)] px-4 py-2 text-body-sm font-semibold text-[color:var(--billrun-cta-text)] hover:bg-[color:var(--billrun-cta-bg-hover)] focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] active:bg-[color:var(--billrun-cta-bg-active)] disabled:cursor-not-allowed disabled:opacity-50"
            >
              {activateLabel}
            </button>
          </div>
        ) : null}
      </div>

      {editable ? (
        <ActivateVersionDialog
          open={activateOpen}
          onOpenChange={setActivateOpen}
          title={`Activate template v${draftNo ?? ""}`}
          confirmLabel={`Activate v${draftNo ?? ""}`}
          summary={
            structureChanges.length === 0 ? (
              <p>No change in structure.</p>
            ) : (
              <ul className="space-y-1">
                {structureChanges.map((c) => (
                  <li key={c.text}>
                    <span aria-hidden className="font-mono">
                      {c.sign}
                    </span>{" "}
                    {c.text}
                  </li>
                ))}
              </ul>
            )
          }
          onConfirm={activate}
        />
      ) : null}

      <div className="min-w-0 space-y-3">
        {preview.pinnedVersionNo !== null ? (
          <p
            role="status"
            className="inline-flex items-center gap-2 rounded-sm bg-[color:var(--color-info-50)] px-3 py-2 text-body-sm text-[color:var(--color-info-700)]"
          >
            <Info size={14} aria-hidden />
            Showing as issued under template v{preview.pinnedVersionNo}
          </p>
        ) : null}
        {preview.templateLabel ? (
          <p className="text-caption text-muted-foreground">
            {preview.templateLabel}
          </p>
        ) : null}
        <InvoicePreviewFrame
          html={preview.html}
          status={preview.status}
          error={preview.error}
          onRetry={() => {
            markLoading();
            setRetryToken((t) => t + 1);
          }}
        />
      </div>
    </div>
  );
}
