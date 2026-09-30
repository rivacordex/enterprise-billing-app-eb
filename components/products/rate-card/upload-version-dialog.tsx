"use client";

import { useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { FileSpreadsheet, Loader2, Upload } from "lucide-react";
import { toast } from "sonner";

import {
  uploadRatecardVersionAction,
  type UploadRatecardVersionActionResult,
} from "@/actions/product/upload-ratecard-version.action";
import { UploadErrorTable } from "@/components/products/rate-card/upload-error-table";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Field, FieldLabel } from "@/components/ui/field";
import { RATE_CARD_FILE_HEADERS } from "@/validation/product/ratecard.schema";

// pm66-spec D1–D4 — the application's FIRST `<input type="file">`, and the
// binding pattern for every upload after it (§3.20).
//
// D1 — the picker is an UNCONTROLLED `<input type="file">` inside a `<form>`;
// on submit the form is read into `FormData` (`new FormData(form)`) and passed
// to the Server Action. The `File` NEVER enters react-hook-form state and is
// never serialised to JSON/base64 — only its NAME string is kept, for display.
// No Route Handler; a multipart body reaches a Server Action through `FormData`
// exactly as a text field does (§5.5).
//
// D2 — the client header sniff is a CONVENIENCE, never a boundary: it may say
// "this does not look like a rate card export"; it may NEVER say "valid". It
// compares the first line against pm58's header map, IMPORTED
// (RATE_CARD_FILE_HEADERS) — never a second spelling. The server re-parses and
// re-validates the entire file unconditionally regardless (§3.19).
//
// D4 — on a structural failure the dialog STAYS OPEN and the file input keeps
// its selection (the input is uncontrolled and never remounts), so the user
// sees what failed against what they picked; the row-level report renders via
// UploadErrorTable, never a toast.

type UploadFailureCode = Extract<
  UploadRatecardVersionActionResult,
  { ok: false }
>["code"];

const ISSUE_CODES = new Set<UploadFailureCode>([
  "HEADER_MISMATCH",
  "DUPLICATE_ROW_KEY",
  "ROW_SCHEMA_INVALID",
]);

// Human copy for the non-structural refusals (the structural ones render the
// row-level table instead). Every refusal renders from the server's typed
// result, never from client state (D10).
const CODE_MESSAGES: Partial<Record<UploadFailureCode, string>> = {
  CONCURRENT_UPLOAD_CONFLICT:
    "Another upload for this card is in progress. Try again.",
  CARD_NAME_REQUIRED: "Pick a card name before uploading.",
  NO_FILE: "Choose a CSV file to upload.",
  INVALID_FILE_TYPE: "That is not a .csv file.",
  FILE_TOO_LARGE: "That file is too large to upload.",
  UNPARSEABLE_FILE: "The file could not be read as CSV.",
  FORBIDDEN: "You don't have permission to do that.",
  SERVER_ERROR: "Something went wrong. Please try again.",
};

export interface UploadVersionDialogProps {
  trigger: React.ReactNode;
  // Existing card names to choose from (distinct, from the version list). When
  // empty (no card exists yet), a free-text input lets the first card be named.
  cardNames: string[];
}

export function UploadVersionDialog({
  trigger,
  cardNames,
}: UploadVersionDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);
  const [fileName, setFileName] = useState<string | null>(null);
  const [sniffWarning, setSniffWarning] = useState<string | null>(null);
  const [result, setResult] =
    useState<UploadRatecardVersionActionResult | null>(null);
  const formRef = useRef<HTMLFormElement>(null);

  // The uncontrolled form is submitted here: `new FormData(form)` gathers the
  // uncontrolled file input (D1) plus the card-name field, and the Server
  // Action receives it. The action's typed return value is the ONLY source of
  // truth (D10). On a structural failure the dialog stays open and the input
  // keeps its selection (it never remounts) so the error table shows what
  // failed against what was picked (D4).
  async function handleSubmit(
    event: React.FormEvent<HTMLFormElement>,
  ): Promise<void> {
    event.preventDefault();
    const form = formRef.current;
    if (!form) return;
    const formData = new FormData(form);
    setPending(true);
    setResult(null);
    try {
      const res = await uploadRatecardVersionAction(formData);
      setResult(res);
      if (res.ok) {
        toast.success(
          res.warnings.length > 0
            ? `Draft created (${res.rowCount} rows) — a matching checksum was found on an earlier version.`
            : `Draft created (${res.rowCount} rows).`,
        );
        // Reset the display state on success BEFORE closing: the dialog content
        // (and the uncontrolled file input) unmounts on close, but this
        // component stays mounted, so a stale `fileName`/`result` would
        // otherwise persist and reopen showing the prior file's name over an
        // empty input. `handleOpenChange(false)` can't do it here — it early-
        // returns while `pending` is still true inside this try.
        resetForm();
        setOpen(false);
        router.refresh();
      } else if (!ISSUE_CODES.has(res.code)) {
        toast.error(CODE_MESSAGES[res.code] ?? "Something went wrong.");
      }
    } catch {
      toast.error("Something went wrong. Please try again.");
    } finally {
      setPending(false);
    }
  }

  function resetForm(): void {
    setFileName(null);
    setSniffWarning(null);
    setResult(null);
  }

  function handleOpenChange(next: boolean): void {
    if (pending) return;
    if (!next) {
      resetForm();
    }
    setOpen(next);
  }

  // D2 — the sniff. Read a small slice, compare the first line's tokens against
  // the imported header set. Honest: it can warn, it can never bless.
  async function handleFileChange(
    event: React.ChangeEvent<HTMLInputElement>,
  ): Promise<void> {
    const file = event.target.files?.[0] ?? null;
    setFileName(file?.name ?? null);
    setSniffWarning(null);
    // Clear any prior result so the error report never outlives the file it
    // described — validation output always matches the CURRENT selection (D4).
    setResult(null);
    if (!file) return;
    try {
      const text = await file.slice(0, 8192).text();
      const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
      const tokens = new Set(
        firstLine
          .replace(/^﻿/, "")
          .split(",")
          .map((cell) => cell.trim()),
      );
      const looksLikeRateCard = RATE_CARD_FILE_HEADERS.every((header) =>
        tokens.has(header),
      );
      if (!looksLikeRateCard) {
        setSniffWarning(
          "This does not look like a rate card export — the server will check it anyway.",
        );
      }
    } catch {
      // A sniff failure is never fatal — the server is the boundary.
    }
  }

  const structuralIssues =
    result && !result.ok && ISSUE_CODES.has(result.code) && "issues" in result
      ? result.issues
      : null;

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>{trigger}</DialogTrigger>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Upload
              size={18}
              className="text-[color:var(--text-link)]"
              aria-hidden
            />
            Upload new version
          </DialogTitle>
        </DialogHeader>

        <form
          ref={formRef}
          onSubmit={(e) => void handleSubmit(e)}
          className="flex flex-col gap-4"
        >
          <Field>
            <FieldLabel htmlFor="ratecard-card-name">Card name</FieldLabel>
            {cardNames.length > 0 ? (
              <select
                id="ratecard-card-name"
                name="cardName"
                defaultValue={cardNames[0]}
                disabled={pending}
                className="h-9 w-full rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
              >
                {cardNames.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id="ratecard-card-name"
                name="cardName"
                placeholder="RAN_USAGE"
                disabled={pending}
                className="h-9 w-full rounded-sm border border-border bg-card px-3 text-body text-foreground focus:outline-none focus-visible:[box-shadow:var(--focus-ring)] disabled:opacity-50"
              />
            )}
          </Field>

          {/* File picker — a styled label over the native input (there is NO
              drag-and-drop handler, so the copy says "click", not "drop"). The
              input is `sr-only`, so `focus-within` on the label surfaces a
              visible keyboard-focus ring when the hidden input is focused. The
              input stays uncontrolled (D1). */}
          <label
            htmlFor="ratecard-file"
            className="flex cursor-pointer flex-col items-center gap-2 rounded-md border-2 border-dashed border-[color:var(--border-strong)] bg-[color:var(--surface-sunken)] p-8 text-center focus-within:[box-shadow:var(--focus-ring)]"
          >
            <FileSpreadsheet
              size={32}
              className="text-[color:var(--text-disabled)]"
              aria-hidden
            />
            <span className="text-body-sm text-muted-foreground">
              {fileName ?? "Click to choose a CSV file"}
            </span>
            <input
              id="ratecard-file"
              name="file"
              type="file"
              accept=".csv,text/csv"
              onChange={(e) => void handleFileChange(e)}
              disabled={pending}
              className="sr-only"
            />
          </label>

          {sniffWarning && (
            <p className="text-caption text-[color:var(--text-warning)]">
              {sniffWarning}
            </p>
          )}

          {/* The hint that makes RC7's two-step gate legible at decision time. */}
          <p className="rounded-md bg-[color:var(--bg-info)] p-3 text-body-sm text-[color:var(--text-info)]">
            Uploads land as <strong>Draft</strong>. Nothing takes effect until
            you activate it.
          </p>

          {/* Persistently-mounted live region: it exists before content
              changes so a structural failure is ANNOUNCED (a short summary),
              while the detailed UploadErrorTable stays OUTSIDE it so its rows
              are not read out as status. */}
          <div role="status" aria-live="polite" className="sr-only">
            {structuralIssues
              ? `Upload failed — the file has ${structuralIssues.length} issue${
                  structuralIssues.length === 1 ? "" : "s"
                }. No version was created.`
              : ""}
          </div>

          {structuralIssues && <UploadErrorTable issues={structuralIssues} />}

          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              disabled={pending}
              onClick={() => handleOpenChange(false)}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              disabled={pending}
              className="bg-[color:var(--action-primary-bg)] hover:bg-[color:var(--action-primary-bg-hover)]"
            >
              {pending && <Loader2 className="animate-spin" />}
              Upload &amp; validate
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
