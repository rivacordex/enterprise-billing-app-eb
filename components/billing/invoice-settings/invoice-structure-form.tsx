"use client";

// bm55-spec §Design D4 (`edit` tab), code-standards Part 2 Next.js rules 5/6,
// Styling rule 7, ui-context §10b — `InvoiceStructureForm`, the template
// editor's interaction leaf. It holds the admin's UNSAVED structure and drives
// the live preview: any valid change → a 400 ms debounced call to
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
//     sections render as text "Shown"/"Hidden" and the footnote as a plain
//     list, with no inputs and no grey wash — the placeholder/outline toggles
//     and the source select still drive the preview;
//   - the source select offers the layout's sample bill and, only for a
//     `billrun_view` holder, the most recent posted bills.
//
// bm71 (D56): the Usage annex row and the charge-detail column toggles are
// gone with the old line table. bm72 (D20, D56 part 2; Phase 3 Next.js rule
// 2, general §4.12): Notes & terms is gone, Payment information is the only
// toggle, and the **Footnote** field holds 1–5 lines. The form runs on React
// Hook Form with the shared structure schema as its resolver. `useFieldArray`
// needs objects, so a line is `{ text }` in the form and a plain string in the
// structure (`toStructure` / `toFormValues`), and the schema's errors are
// mapped back onto the lines.
//
// bm80 (ui-context §10e) — a save refused with `DRAFT_LAYOUT_REPLACED` (an
// upload overwrote the layout and bumped the settings token) adopts the
// returned token WITHOUT `reset()` or `router.refresh()`, so the inputs keep
// the unsaved values; a Warning alert above the settings says so, and the
// preview re-renders with the new layout. The next successful save clears it.

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useRef, useState } from "react";
import { useFieldArray, useForm, useWatch } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { AlertTriangle, Info, Lock, Plus, X } from "lucide-react";
import { toast } from "sonner";
import type { FieldErrors, Resolver } from "react-hook-form";

import {
  activateTemplateAction,
  type ActivateTemplateActionResult,
} from "@/actions/billing/invoice-settings/activate-template.action";
import { saveTemplateDraftAction } from "@/actions/billing/invoice-settings/save-template-draft.action";
import { previewInvoiceTemplateAction } from "@/actions/billing/invoice-settings/preview-invoice-template.action";
import {
  ActivateVersionDialog,
  StructureChangeSummary,
  type ActivateConfirmResult,
} from "@/components/billing/invoice-settings/activate-version-dialog";
import {
  SECTION_ROWS,
  describeStructureChanges,
  isOptionalSection,
} from "@/components/billing/invoice-settings/structure-labels";
import {
  InvoicePreviewFrame,
  type PreviewError,
  type PreviewStatus,
} from "@/components/billing/invoice-settings/invoice-preview-frame";
import { DRAFT_CONFLICT_MESSAGE } from "@/components/billing/invoice-settings/draft-messages";
import { LayoutProblemsAlert } from "@/components/billing/invoice-settings/layout-problems-alert";
import {
  LAYOUT_REPLACED_SAVE_MESSAGE,
  TEMPLATE_TYPE_MESSAGES,
  layoutChangeLine,
} from "@/components/billing/invoice-settings/template-type-messages";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Switch } from "@/components/ui/switch";
import type {
  InvoiceTemplateStructure,
  LayoutProblem,
  RecentPostedBill,
} from "@/types/billing";
import {
  FOOTNOTE_LINE_MAX_LENGTH,
  FOOTNOTE_MAX_LINES,
  invoiceTemplateStructureSchema,
} from "@/validation/billing/invoice-template-structure.schema";

const SAMPLE = "sample";
const DEBOUNCE_MS = 400;
// ui-context §6c — past a normal render window the caption reads "Queued".
const QUEUED_HINT_DELAY_MS = 2_500;

// The last settled preview. `key` is the request it answered and `queuedKey`
// the request the "Queued" hint applies to; while the current request is
// neither settled nor queued, the preview reads as loading.
interface PreviewState {
  key: string | null;
  queuedKey: string | null;
  status: PreviewStatus;
  html: string | null;
  templateLabel: string | null;
  pinnedVersionNo: number | null;
  error: PreviewError | null;
}

const ACTIVATE_MESSAGES = {
  CHANGE_NOTE_REQUIRED: "A change note is required.",
  DRAFT_CONFLICT: DRAFT_CONFLICT_MESSAGE,
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
  // bm79 — the pair's layout DRAFT failed the compliance re-run; the retired type.
  LAYOUT_REJECTED: TEMPLATE_TYPE_MESSAGES.activateLayoutRejected,
  TEMPLATE_TYPE_RETIRED: TEMPLATE_TYPE_MESSAGES.typeRetired,
  FORBIDDEN: "You do not have permission to activate a template.",
  VALIDATION_ERROR: "The request was not valid. Reload and try again.",
  SERVER_ERROR: "The version could not be activated. Please try again.",
} as const;

const SAVE_FAILED_MESSAGE = "The draft could not be saved. Please try again.";

function activateMessage(
  result: Extract<ActivateTemplateActionResult, { ok: false }>,
): string {
  return ACTIVATE_MESSAGES[result.code];
}

// --- form values ↔ structure ------------------------------------------------

interface StructureFormValues {
  sections: { payment: boolean };
  footnote: { text: string }[];
}

// The structure in a fixed key order, so two structures compare equal as JSON
// whatever key order their source (a jsonb row, the form) produced.
function canonical(
  structure: InvoiceTemplateStructure,
): InvoiceTemplateStructure {
  return {
    sections: { payment: structure.sections.payment },
    columns: {},
    footnote: [...structure.footnote],
  };
}

function toFormValues(
  structure: InvoiceTemplateStructure,
): StructureFormValues {
  return {
    sections: { payment: structure.sections.payment },
    footnote: structure.footnote.map((text) => ({ text })),
  };
}

function toStructure(values: StructureFormValues): InvoiceTemplateStructure {
  return {
    sections: { payment: values.sections.payment },
    columns: {},
    footnote: values.footnote.map((line) => line.text),
  };
}

// The schema reports a line's error at `footnote.N` and a line-count error at
// `footnote` (or `footnote.root`); the form shows them at `footnote.N.text`
// and `footnote.root`.
function toFormErrors(
  errors: FieldErrors<InvoiceTemplateStructure>,
): FieldErrors<StructureFormValues> {
  const { footnote, ...rest } = errors as Record<string, unknown>;
  if (footnote === undefined || footnote === null) {
    return rest as FieldErrors<StructureFormValues>;
  }
  const lines: unknown[] = [];
  let root: unknown;
  for (const [key, value] of Object.entries(footnote)) {
    if (/^\d+$/.test(key)) lines[Number(key)] = { text: value };
    else if (key === "root") root = value;
  }
  const { message, type } = footnote as { message?: string; type?: string };
  if (root === undefined && message !== undefined) root = { message, type };
  return {
    ...rest,
    footnote: Object.assign(lines, root === undefined ? {} : { root }),
  } as FieldErrors<StructureFormValues>;
}

// General §4.12 — the shared schema is the form's resolver, so the browser
// enforces what the save and activate actions enforce (1–5 lines, ≤ 200
// characters, no blank line). A valid submit receives the parsed (trimmed)
// structure.
const structureResolver = zodResolver(invoiceTemplateStructureSchema);
const resolver: Resolver<StructureFormValues> = async (
  values,
  context,
  options,
) => {
  const result = await structureResolver(
    toStructure(values),
    context,
    options as unknown as Parameters<typeof structureResolver>[2],
  );
  if (Object.keys(result.errors).length > 0) {
    return {
      values: {},
      errors: toFormErrors(
        result.errors as FieldErrors<InvoiceTemplateStructure>,
      ),
    };
  }
  return {
    values: toFormValues(result.values as InvoiceTemplateStructure),
    errors: {},
  };
};

// The structure a preview or a save would send, or `null` while the form is
// invalid (no preview request is made for an invalid structure).
function parsedStructure(
  values: StructureFormValues,
): InvoiceTemplateStructure | null {
  const parsed = invoiceTemplateStructureSchema.safeParse(toStructure(values));
  return parsed.success ? canonical(parsed.data) : null;
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
  // bm66/bm77: the template type (from the `[typeId]` page) the live
  // preview renders with and the save/activate actions write to.
  familyId: string;
  // bm79: set when the draft carries a layout DRAFT (an uploaded pair); the
  // Activate dialog's summary leads with its layout line.
  layoutChange?: {
    code: string;
    fromVersionNo: number | null;
    toVersionNo: number;
  } | null;
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
  familyId,
  layoutChange = null,
}: InvoiceStructureFormProps): React.JSX.Element {
  const router = useRouter();
  // bm79 — the compliance re-run's problems from the last refused Activate.
  const [layoutProblems, setLayoutProblems] = useState<LayoutProblem[]>([]);
  // bm80 — the last save found the layout replaced by an upload.
  const [layoutReplaced, setLayoutReplaced] = useState(false);
  const {
    control,
    register,
    handleSubmit,
    reset,
    setError,
    setValue,
    formState: { errors, isSubmitting },
  } = useForm<StructureFormValues>({
    resolver,
    mode: "onChange",
    defaultValues: toFormValues(initialStructure),
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "footnote",
  });
  const values = useWatch({ control }) as StructureFormValues;
  // Parsed once per change of the values, not on every preview state update.
  const structure = useMemo(() => parsedStructure(values), [values]);
  // The valid structure's JSON: the preview effect's dependency, so it re-runs
  // on a real change only.
  const structureKey = structure === null ? null : JSON.stringify(structure);
  // The structure the preview renders: the latest valid one. An invalid
  // structure (a blank or over-long line) keeps the last valid one, so the
  // source, toggles and Retry still produce a preview.
  const [previewKey, setPreviewKey] = useState(structureKey);
  if (structureKey !== null && structureKey !== previewKey) {
    setPreviewKey(structureKey);
  }

  // bm57: the last-saved structure (pristine = unchanged since load or save),
  // the live token and the draft the Activate button targets.
  const [saved, setSaved] = useState(() => canonical(initialStructure));
  const [draftToken, setDraftToken] = useState(expectedDraftToken);
  const [draftId, setDraftId] = useState(draftVersionId);
  const [draftNo, setDraftNo] = useState(draftVersionNo);
  const [activateOpen, setActivateOpen] = useState(false);

  // The page re-renders after every save, activation and Reload, without
  // remounting this form. A server state this form already holds (its own
  // save) changes nothing, so an Activate dialog opened before the refresh
  // lands stays open with its note. A different one (a Reload after
  // DRAFT_CONFLICT, an activation) is adopted: the form, its saved baseline
  // and the draft it targets reload from the server.
  const serverState = JSON.stringify([
    expectedDraftToken,
    draftVersionId,
    canonical(initialStructure),
  ]);
  const [seenServerState, setSeenServerState] = useState(serverState);
  const [adopted, setAdopted] = useState<InvoiceTemplateStructure | null>(null);
  if (serverState !== seenServerState) {
    setSeenServerState(serverState);
    const held =
      expectedDraftToken === draftToken &&
      draftVersionId === draftId &&
      JSON.stringify(canonical(initialStructure)) === JSON.stringify(saved);
    if (!held) {
      setSaved(canonical(initialStructure));
      setDraftToken(expectedDraftToken);
      setDraftId(draftVersionId);
      setDraftNo(draftVersionNo);
      setActivateOpen(false);
      setAdopted(canonical(initialStructure));
      // bm79 review fix — a refused activation's problems describe the draft
      // this form held; a newer server state (discarded, replaced, activated)
      // drops them.
      setLayoutProblems([]);
      setLayoutReplaced(false);
    }
  }
  useEffect(() => {
    if (adopted !== null) reset(toFormValues(adopted));
  }, [adopted, reset]);

  const pristine = structureKey === JSON.stringify(saved);
  // bm58 D1: activate only what the history already shows, i.e. a saved draft
  // with no unsaved edits.
  const canActivate = pristine && draftId !== null && !isSubmitting;
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
    key: null,
    queuedKey: null,
    status: "ready",
    html: null,
    templateLabel: null,
    pinnedVersionNo: null,
    error: null,
  });
  // The latest request's id — a settling request that no longer holds it is
  // stale and never overwrites newer state.
  const requestRef = useRef(0);

  // bm79 review fix — the working copy of a DRAFT previews that draft (and the
  // layout it points at, an uploaded layout DRAFT included); any other version
  // previews the version in use. The action honours it only for EDIT.
  const previewDraft = editable && draftId !== null;

  // Every input of the current request; any change (an edit, the source, a
  // toggle, Retry) makes the shown preview stale until its request settles.
  const requestKey =
    previewKey === null
      ? null
      : JSON.stringify([
          previewKey,
          source,
          annotate,
          outline,
          retryToken,
          familyId,
          previewDraft,
        ]);
  const pending = requestKey !== null && preview.key !== requestKey;
  const previewStatus: PreviewStatus = pending
    ? preview.queuedKey === requestKey
      ? "queued"
      : "loading"
    : preview.status;

  useEffect(() => {
    if (previewKey === null || requestKey === null) return;
    const id = ++requestRef.current;
    const debounce = setTimeout(() => {
      const queued = setTimeout(() => {
        if (requestRef.current !== id) return;
        setPreview((p) => ({ ...p, queuedKey: requestKey }));
      }, QUEUED_HINT_DELAY_MS);

      previewInvoiceTemplateAction({
        structure: JSON.parse(previewKey) as InvoiceTemplateStructure,
        source: source === SAMPLE ? "sample" : { billId: source },
        annotate,
        outline,
        familyId,
        draft: previewDraft,
      })
        .then((result) => {
          if (requestRef.current !== id) return;
          if (result.ok) {
            setPreview({
              key: requestKey,
              queuedKey: null,
              status: "ready",
              html: result.html,
              templateLabel: result.templateLabel,
              pinnedVersionNo: result.pinnedVersionNo,
              error: null,
            });
          } else {
            setPreview((p) => ({
              ...p,
              key: requestKey,
              status: "error",
              error: { code: result.code, detail: result.detail },
            }));
          }
        })
        .catch(() => {
          if (requestRef.current !== id) return;
          setPreview((p) => ({
            ...p,
            key: requestKey,
            status: "error",
            error: { code: "PREVIEW_FAILED" },
          }));
        })
        .finally(() => clearTimeout(queued));
    }, DEBOUNCE_MS);
    return () => clearTimeout(debounce);
  }, [
    previewKey,
    requestKey,
    source,
    annotate,
    outline,
    familyId,
    previewDraft,
  ]);

  // The server's refusal of a line (`structure.footnote.N`) shows under it;
  // false when nothing could be placed on a line.
  function showServerErrors(fieldErrors: Record<string, string[]>): boolean {
    let placed = false;
    for (const [path, messages] of Object.entries(fieldErrors)) {
      const line = /^structure\.footnote\.(\d+)$/.exec(path)?.[1];
      if (line === undefined) continue;
      setError(`footnote.${Number(line)}.text`, {
        type: "server",
        message: messages[0] ?? "Invalid line",
      });
      placed = true;
    }
    return placed;
  }

  async function saveDraft(submitted: StructureFormValues): Promise<void> {
    const next = canonical(toStructure(submitted));
    try {
      const result = await saveTemplateDraftAction({
        structure: next,
        expectedDraftToken: draftToken,
        familyId,
      });
      if (result.ok) {
        setSaved(next);
        reset(toFormValues(next));
        setDraftToken(result.draftToken);
        setDraftId(result.versionId);
        setDraftNo(result.versionNo);
        setLayoutReplaced(false);
        toast.success(
          `Draft v${result.versionNo} saved — not used on invoices`,
        );
        return;
      }
      if (result.code === "DRAFT_LAYOUT_REPLACED") {
        // No `reset` and no `router.refresh()`: the values stay; the fresh
        // token makes "review and save again" save over the replaced pair.
        setDraftToken(result.draftToken);
        setLayoutReplaced(true);
        setRetryToken((n) => n + 1);
      } else if (result.code === "DRAFT_CONFLICT") {
        toast.warning(ACTIVATE_MESSAGES.DRAFT_CONFLICT, {
          action: { label: "Reload", onClick: () => router.refresh() },
        });
      } else if (result.code === "FORBIDDEN") {
        toast.error("You do not have permission to save the draft.");
      } else if (
        !("fieldErrors" in result) ||
        !showServerErrors(result.fieldErrors)
      ) {
        toast.error(SAVE_FAILED_MESSAGE);
      }
    } catch {
      toast.error(SAVE_FAILED_MESSAGE);
    }
  }

  async function activate(changeNote: string): Promise<ActivateConfirmResult> {
    if (draftId === null || draftToken === null) {
      return { ok: false, message: ACTIVATE_MESSAGES.DRAFT_CONFLICT };
    }
    setLayoutProblems([]);
    const result = await activateTemplateAction({
      draftId,
      expectedDraftToken: draftToken,
      changeNote,
      familyId,
    });
    if (result.ok) {
      // No `router.refresh()`: the action revalidates the Invoice Settings layout
      // and its response carries the fresh page (no draft), which this form
      // adopts as a server state it does not hold.
      toast.success(`Template v${result.versionNo} activated`);
      return { ok: true };
    }
    if (result.code === "DRAFT_CONFLICT") {
      // The held token is stale, so every retry would conflict again. Offer the
      // same Reload as a failed save; the refresh re-renders the page with the
      // newer token, and the form adopts the server's draft.
      toast.warning(ACTIVATE_MESSAGES.DRAFT_CONFLICT, {
        action: { label: "Reload", onClick: () => router.refresh() },
      });
    }
    if (result.code === "LAYOUT_REJECTED") setLayoutProblems(result.problems);
    // The type was retired meanwhile: re-fetch, so the page drops its edit
    // controls (ui-context §10e).
    if (result.code === "TEMPLATE_TYPE_RETIRED") router.refresh();
    return { ok: false, message: activateMessage(result) };
  }

  const footnoteRootError = errors.footnote?.root?.message;

  return (
    <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
      <div className="space-y-6">
        {layoutReplaced ? (
          <p
            role="alert"
            className="flex items-start gap-2 rounded-sm bg-[color:var(--color-warning-50)] px-3 py-2 text-body-sm text-[color:var(--color-warning-700)]"
          >
            <AlertTriangle size={14} className="mt-0.5 shrink-0" aria-hidden />
            {LAYOUT_REPLACED_SAVE_MESSAGE}
          </p>
        ) : null}
        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Sections
          </legend>
          {SECTION_ROWS.map(({ key, label }) => {
            const optional = isOptionalSection(key);
            // A mandatory section is always shown and is not stored.
            const shown = optional ? values.sections[key] : true;
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
                      checked={shown}
                      disabled={!optional}
                      onCheckedChange={(v) => {
                        if (!optional) return;
                        setValue(`sections.${key}`, v === true, {
                          shouldDirty: true,
                        });
                      }}
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
                  <ReadOnlyValue shown={shown} />
                )}
              </div>
            );
          })}
        </fieldset>

        {/* bm72 (ui-context §10b Phase 3 rows) — the footnote lines. */}
        <fieldset
          className="space-y-3 rounded-md border border-border bg-card p-4"
          aria-describedby="footnote-hint"
        >
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Footnote
          </legend>
          <p
            id="footnote-hint"
            className="text-caption text-[color:var(--text-muted)]"
          >
            Printed after Total Amount on the last page
          </p>
          {editable ? (
            <>
              {fields.map((field, index) => {
                const id = `footnote-line-${index + 1}`;
                // The schema trims before its 200-character limit.
                const length = values.footnote[index]?.text.trim().length ?? 0;
                const lineError = errors.footnote?.[index]?.text?.message;
                const over = length > FOOTNOTE_LINE_MAX_LENGTH;
                return (
                  <div key={field.id} className="space-y-1">
                    <div className="flex items-center justify-between gap-2">
                      <Label htmlFor={id} className="text-body-sm">
                        Line {index + 1}
                      </Label>
                      <span
                        className={`text-caption tabular-nums ${
                          over
                            ? "text-[color:var(--color-danger-700)]"
                            : "text-[color:var(--text-muted)]"
                        }`}
                      >
                        {length}/{FOOTNOTE_LINE_MAX_LENGTH}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Input
                        id={id}
                        className="rounded-sm"
                        aria-invalid={lineError ? true : undefined}
                        aria-describedby={lineError ? `${id}-error` : undefined}
                        {...register(`footnote.${index}.text`)}
                      />
                      {fields.length > 1 ? (
                        <Button
                          type="button"
                          variant="ghost"
                          size="icon"
                          aria-label={`Remove line ${index + 1}`}
                          onClick={() => remove(index)}
                        >
                          <X aria-hidden />
                        </Button>
                      ) : null}
                    </div>
                    {lineError ? (
                      <p
                        id={`${id}-error`}
                        role="alert"
                        className="text-caption text-[color:var(--color-danger-700)]"
                      >
                        {lineError}
                      </p>
                    ) : null}
                  </div>
                );
              })}
              {footnoteRootError ? (
                <p
                  role="alert"
                  className="text-caption text-[color:var(--color-danger-700)]"
                >
                  {footnoteRootError}
                </p>
              ) : null}
              {fields.length < FOOTNOTE_MAX_LINES ? (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={() => append({ text: "" })}
                >
                  <Plus aria-hidden />
                  Add line
                </Button>
              ) : null}
            </>
          ) : (
            <ul
              aria-label="Footnote lines"
              className="list-disc space-y-1 pl-5 text-body-sm text-foreground"
            >
              {values.footnote.map((line, index) => (
                <li key={index}>{line.text}</li>
              ))}
            </ul>
          )}
        </fieldset>

        <fieldset className="space-y-3 rounded-md border border-border bg-card p-4">
          <legend className="px-1 text-overline font-semibold tracking-wider text-muted-foreground uppercase">
            Preview
          </legend>
          <div className="space-y-1.5">
            <Label htmlFor="preview-source" className="text-body-sm">
              Preview with
            </Label>
            <Select value={source} onValueChange={setSource}>
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
              onCheckedChange={setAnnotate}
            />
          </div>
          <div className="flex items-center justify-between gap-3">
            <Label htmlFor="preview-outline" className="text-body-sm">
              Outline
            </Label>
            <Switch
              id="preview-outline"
              checked={outline}
              onCheckedChange={setOutline}
            />
          </div>
        </fieldset>

        {editable ? (
          <div className="flex flex-wrap justify-end gap-2">
            <Button
              type="button"
              variant="outline"
              disabled={pristine || isSubmitting}
              onClick={() => void handleSubmit(saveDraft)()}
            >
              {isSubmitting ? "Saving…" : "Save draft"}
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
            <div className="space-y-2">
              {layoutChange ? (
                <p className="font-mono text-mono">
                  {layoutChangeLine(layoutChange)}
                </p>
              ) : null}
              {activeStructure ? (
                <StructureChangeSummary changes={structureChanges} />
              ) : (
                <p>{TEMPLATE_TYPE_MESSAGES.firstVersionOfType}</p>
              )}
            </div>
          }
          onConfirm={activate}
        />
      ) : null}

      <div className="min-w-0 space-y-3">
        {layoutProblems.length > 0 ? (
          <LayoutProblemsAlert
            title={TEMPLATE_TYPE_MESSAGES.activateLayoutRejectedTitle}
            problems={layoutProblems}
          />
        ) : null}
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
          status={previewStatus}
          error={pending ? null : preview.error}
          onRetry={() => setRetryToken((t) => t + 1)}
        />
      </div>
    </div>
  );
}
