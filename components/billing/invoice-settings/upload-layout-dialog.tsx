"use client";

// bm78-spec §11 (code-standards › Invoice Template Types, Next.js rule 4,
// Styling rules 3–4; ui-context §10e) — `UploadLayoutDialog`: the one way a
// layout enters the app. It keeps no server state. A refused package lists
// every problem in one Danger alert grouped by file (never a toast) and stays
// until the next attempt; a changed draft or a retired type shows its message
// and re-fetches the page; success closes and re-fetches. While the type has an
// open layout DRAFT the trigger is disabled with a caption (bm80 replaces this
// with the overwrite path).

import { useRouter } from "next/navigation";
import { useState } from "react";

import { uploadLayoutPackageAction } from "@/actions/billing/invoice-settings/upload-layout-package.action";
import {
  TEMPLATE_TYPE_MESSAGES,
  uploadConfirm,
  uploadCreatesDraft,
  uploadDraftOpen,
} from "@/components/billing/invoice-settings/template-type-messages";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
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
import type { LayoutProblem } from "@/types/billing";

export interface UploadLayoutDialogProps {
  familyId: string;
  // The version this upload will create (the page's "Next layout version").
  nextVersionNo: number;
  openLayoutDraft: { versionId: string; versionNo: number } | null;
}

function groupByFile(
  problems: readonly LayoutProblem[],
): [string, LayoutProblem[]][] {
  const groups = new Map<string, LayoutProblem[]>();
  for (const p of problems) {
    const list = groups.get(p.file) ?? [];
    list.push(p);
    groups.set(p.file, list);
  }
  return [...groups];
}

export function UploadLayoutDialog({
  familyId,
  nextVersionNo,
  openLayoutDraft,
}: UploadLayoutDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [problems, setProblems] = useState<LayoutProblem[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (submitting) return;
    setOpen(next);
    if (!next) {
      setFile(null);
      setProblems([]);
      setMessage(null);
    }
  }

  async function upload(): Promise<void> {
    if (!file) return;
    setSubmitting(true);
    setProblems([]);
    setMessage(null);
    try {
      const form = new FormData();
      form.set("familyId", familyId);
      form.set("expectedDraft", "none");
      form.set("file", file);
      const result = await uploadLayoutPackageAction(form);
      if (result.ok) {
        setOpen(false);
        setFile(null);
        router.refresh();
        return;
      }
      switch (result.code) {
        case "LAYOUT_REJECTED":
          setProblems(result.problems);
          break;
        case "DRAFT_CHANGED_SINCE_WARNING":
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadDraftChanged);
          router.refresh();
          break;
        case "TEMPLATE_TYPE_RETIRED":
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadTypeRetired);
          router.refresh();
          break;
        case "FORBIDDEN":
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadForbidden);
          break;
        default:
          setMessage(TEMPLATE_TYPE_MESSAGES.uploadFailed);
      }
    } catch {
      setMessage(TEMPLATE_TYPE_MESSAGES.uploadFailed);
    } finally {
      setSubmitting(false);
    }
  }

  if (openLayoutDraft) {
    return (
      <div className="flex flex-wrap items-center gap-2">
        <Button type="button" disabled>
          {TEMPLATE_TYPE_MESSAGES.uploadTrigger}
        </Button>
        <span className="text-body-sm text-muted-foreground">
          {uploadDraftOpen(openLayoutDraft.versionNo)}
        </span>
      </div>
    );
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button type="button">{TEMPLATE_TYPE_MESSAGES.uploadTrigger}</Button>
      </DialogTrigger>
      <DialogContent className="max-h-[calc(100dvh-2rem)] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{TEMPLATE_TYPE_MESSAGES.uploadTitle}</DialogTitle>
          <DialogDescription>
            {uploadCreatesDraft(nextVersionNo)}
          </DialogDescription>
        </DialogHeader>

        <Field>
          <FieldLabel htmlFor="layout-package-file">
            {TEMPLATE_TYPE_MESSAGES.uploadFileLabel}
          </FieldLabel>
          <Input
            id="layout-package-file"
            type="file"
            accept=".zip"
            disabled={submitting}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setProblems([]);
              setMessage(null);
            }}
          />
        </Field>

        {problems.length > 0 ? (
          <Alert variant="destructive">
            <AlertTitle>{TEMPLATE_TYPE_MESSAGES.uploadRejected}</AlertTitle>
            <AlertDescription>
              <ul className="space-y-2">
                {groupByFile(problems).map(([groupFile, list]) => (
                  <li key={groupFile}>
                    <span className="font-mono text-mono">{groupFile}</span>
                    <ul className="ml-4 list-disc">
                      {list.map((p, i) => (
                        <li key={`${p.code}-${i}`}>
                          <span className="font-mono text-mono">{p.code}</span>{" "}
                          — {p.message}
                        </li>
                      ))}
                    </ul>
                  </li>
                ))}
              </ul>
            </AlertDescription>
          </Alert>
        ) : null}

        {message ? (
          <p
            role="alert"
            className="text-body-sm text-[color:var(--color-danger-700)]"
          >
            {message}
          </p>
        ) : null}

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
