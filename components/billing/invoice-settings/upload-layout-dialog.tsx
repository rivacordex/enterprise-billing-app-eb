"use client";

// bm78-spec §11 (code-standards › Invoice Template Types, Next.js rule 4,
// Styling rules 3–4; ui-context §10e) — `UploadLayoutDialog`: the one way a
// layout enters the app. It keeps no server state. A refused package lists
// every problem in one Danger alert grouped by file (never a toast) and stays
// until the next attempt; every refusal shows its message and re-fetches the
// page (Next.js rule 4); success closes and re-fetches.
//
// bm80 (Next.js rule 5, Styling rules 3 and 6, ui-context §7 and §10e) — while
// the type has an open layout DRAFT the dialog is an `AlertDialog` carrying the
// exact overwrite warning, built from the page's server data, and the confirm
// "Overwrite draft" in the danger role. The request names the warned-about
// DRAFT (`expectedDraftVersionId` + `expectedDraftToken`); a stale warning
// shows the reason and re-fetches, and the dialog re-renders with the new
// server data and warns again.
//
// bm81 (ui-context §10e, General rule 3) — when the chosen zip carries a
// schema-valid `settings.json` (an export), an Info note says its settings will
// replace the draft settings. The note is read in the browser and is display
// only: the server re-parses and decides everything.

import { useRouter } from "next/navigation";
import { useState } from "react";
import { unzipSync } from "fflate";
import { AlertCircle, AlertTriangle, Info } from "lucide-react";
import { toast } from "sonner";

import { uploadLayoutPackageAction } from "@/actions/billing/invoice-settings/upload-layout-package.action";
import {
  OVERWRITE_WARNING,
  RESTORED_FROM,
  RESTORE_NOTE,
  TEMPLATE_TYPE_MESSAGES,
  uploadConfirm,
  uploadCreatedToast,
  uploadCreatesDraft,
  uploadReplacedToast,
} from "@/components/billing/invoice-settings/template-type-messages";
import { LayoutProblemsAlert } from "@/components/billing/invoice-settings/layout-problems-alert";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { Input } from "@/components/ui/input";
import { formatDatetime } from "@/lib/formatters";
import type { LayoutProblem, OpenLayoutDraftInfo } from "@/types/billing";
import {
  templateExportSettingsSchema,
  type TemplateExportSettings,
} from "@/validation/billing/template-export-settings.schema";

const SETTINGS_FILE = "settings.json";
const RESTORE_NOTE_MAX_BYTES = 64 * 1024;

// bm81 — the chosen zip's export settings, or `null`: only `settings.json` is
// inflated, and only when it is at most 64 KiB. Any error is `null` (no note).
export async function readRestoreNote(
  file: File,
): Promise<TemplateExportSettings | null> {
  try {
    const entries = unzipSync(new Uint8Array(await file.arrayBuffer()), {
      filter: (f) =>
        f.name === SETTINGS_FILE && f.originalSize <= RESTORE_NOTE_MAX_BYTES,
    });
    const bytes = entries[SETTINGS_FILE];
    if (!bytes) return null;
    const parsed = templateExportSettingsSchema.safeParse(
      JSON.parse(new TextDecoder().decode(bytes)),
    );
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

export interface UploadLayoutDialogProps {
  familyId: string;
  // The version this upload will create (the page's "Next layout version").
  nextVersionNo: number;
  // bm80 — the type's open layout DRAFT as the page read it, or `null`.
  openLayoutDraft: OpenLayoutDraftInfo | null;
  locale: string;
  timezone: string;
}

export function UploadLayoutDialog({
  familyId,
  nextVersionNo,
  openLayoutDraft,
  locale,
  timezone,
}: UploadLayoutDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [problems, setProblems] = useState<LayoutProblem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  // The note for the file it was read from; shown only while that file is
  // still the chosen one.
  const [restoreNote, setRestoreNote] = useState<{
    file: File;
    settings: TemplateExportSettings;
  } | null>(null);
  const restore =
    restoreNote !== null && restoreNote.file === file
      ? restoreNote.settings
      : null;

  function handleOpenChange(next: boolean): void {
    if (submitting) return;
    setOpen(next);
    // Opening or closing starts clean.
    setFile(null);
    setProblems([]);
    setMessage(null);
  }

  // bm80 — the warned-about draft changed (a refusal's re-fetch revealed,
  // replaced or removed it): the dialog stays open on the new server data
  // (the warning, or the plain create form), keeps the refusal's message, and
  // drops the selected file and the problems of the previous attempt
  // (adjusted during render, as the structure form adopts server state).
  const draftKey = openLayoutDraft
    ? `${openLayoutDraft.versionId}@${openLayoutDraft.token}`
    : null;
  const [seenDraftKey, setSeenDraftKey] = useState(draftKey);
  if (draftKey !== seenDraftKey) {
    setSeenDraftKey(draftKey);
    setFile(null);
    setProblems([]);
  }

  async function upload(): Promise<void> {
    if (!file) return;
    setSubmitting(true);
    setProblems([]);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("familyId", familyId);
      if (openLayoutDraft) {
        form.set("expectedDraftVersionId", openLayoutDraft.versionId);
        form.set("expectedDraftToken", openLayoutDraft.token);
      }
      form.set("file", file);
      const result = await uploadLayoutPackageAction(form);
      if (result.ok) {
        toast.success(
          result.replaced
            ? uploadReplacedToast(result.versionNo)
            : uploadCreatedToast(result.versionNo),
        );
        setOpen(false);
        setFile(null);
        router.refresh();
        return;
      }
      switch (result.code) {
        case "LAYOUT_REJECTED":
          setProblems(result.problems);
          break;
        // Review fix (owner decision) — the two refusals whose re-fetch can
        // remount this dialog elsewhere (an empty type's alert → the heading)
        // also raise a Warning toast, which survives the remount. The problems
        // list stays an in-dialog Danger alert, never a toast.
        case "DRAFT_CHANGED_SINCE_WARNING": {
          const reason = openLayoutDraft
            ? TEMPLATE_TYPE_MESSAGES.overwriteStale
            : TEMPLATE_TYPE_MESSAGES.uploadDraftChanged;
          setMessage(reason);
          toast.warning(reason);
          break;
        }
        case "TEMPLATE_TYPE_RETIRED":
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadTypeRetired);
          toast.warning(TEMPLATE_TYPE_MESSAGES.uploadTypeRetired);
          break;
        case "FORBIDDEN":
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadForbidden);
          break;
        default:
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadFailed);
      }
      router.refresh();
    } catch {
      setMessage(TEMPLATE_TYPE_MESSAGES.uploadFailed);
    } finally {
      setSubmitting(false);
    }
  }

  const trigger = (
    <Button type="button">{TEMPLATE_TYPE_MESSAGES.uploadTrigger}</Button>
  );

  const body = (
    <>
      <Field>
        <FieldLabel htmlFor="layout-package-file">
          {TEMPLATE_TYPE_MESSAGES.uploadFileLabel}
        </FieldLabel>
        <Input
          // A new server draft resets the picker along with `file`.
          key={draftKey ?? "none"}
          id="layout-package-file"
          type="file"
          accept=".zip"
          disabled={submitting}
          onChange={(e) => {
            const chosen = e.target.files?.[0] ?? null;
            setFile(chosen);
            setProblems([]);
            setMessage(null);
            if (chosen) {
              void readRestoreNote(chosen).then((settings) =>
                setRestoreNote(settings ? { file: chosen, settings } : null),
              );
            }
          }}
        />
      </Field>

      {restore ? (
        <Alert data-testid="restore-note">
          <Info aria-hidden />
          <AlertDescription className="space-y-1">
            <p>{RESTORE_NOTE}</p>
            <p className="font-mono text-mono">
              {RESTORED_FROM(restore.source.layoutVersion)}
            </p>
          </AlertDescription>
        </Alert>
      ) : null}

      {problems.length > 0 ? (
        <LayoutProblemsAlert
          title={TEMPLATE_TYPE_MESSAGES.uploadRejected}
          problems={problems}
        />
      ) : null}

      {message ? (
        <Alert variant="destructive" role="alert">
          <AlertCircle aria-hidden />
          <AlertDescription>{message}</AlertDescription>
        </Alert>
      ) : null}
    </>
  );

  if (openLayoutDraft) {
    return (
      <AlertDialog open={open} onOpenChange={handleOpenChange}>
        <AlertDialogTrigger asChild>{trigger}</AlertDialogTrigger>
        <AlertDialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
          <AlertDialogHeader>
            <AlertDialogTitle>
              {TEMPLATE_TYPE_MESSAGES.overwriteTitle}
            </AlertDialogTitle>
            <AlertDialogDescription asChild>
              <div
                data-testid="overwrite-warning"
                className="flex items-start gap-2 rounded-md bg-[color:var(--color-warning-50)] px-3 py-2 text-left text-body-sm text-[color:var(--color-warning-700)]"
              >
                <AlertTriangle
                  size={16}
                  className="mt-0.5 shrink-0"
                  aria-hidden
                />
                <p>
                  {OVERWRITE_WARNING(
                    openLayoutDraft.versionNo,
                    formatDatetime(
                      openLayoutDraft.lastModifiedDatetime,
                      locale,
                      timezone,
                    ),
                    openLayoutDraft.lastModifiedByName ??
                      TEMPLATE_TYPE_MESSAGES.overwriteNoAuthor,
                  )}
                </p>
              </div>
            </AlertDialogDescription>
          </AlertDialogHeader>

          {body}

          <AlertDialogFooter>
            <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
            <Button
              type="button"
              variant="destructive"
              disabled={file === null || submitting}
              onClick={() => void upload()}
            >
              {submitting
                ? TEMPLATE_TYPE_MESSAGES.uploadChecking
                : TEMPLATE_TYPE_MESSAGES.overwriteConfirm}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{TEMPLATE_TYPE_MESSAGES.uploadTitle}</DialogTitle>
          <DialogDescription>
            {uploadCreatesDraft(nextVersionNo)}
          </DialogDescription>
        </DialogHeader>

        {body}

        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            disabled={submitting}
            onClick={() => handleOpenChange(false)}
          >
            Cancel
          </Button>
          <Button
            type="button"
            disabled={file === null || submitting}
            onClick={() => void upload()}
          >
            {submitting
              ? TEMPLATE_TYPE_MESSAGES.uploadChecking
              : uploadConfirm(nextVersionNo)}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
