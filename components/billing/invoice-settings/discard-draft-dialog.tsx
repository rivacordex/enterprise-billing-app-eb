"use client";

// bm79 (ui-context §7 and §10e; code-standards › Invoice Template Types,
// Next.js rule 4) — `DiscardDraftDialog`, the Version history DRAFT row's
// ghost **Discard** control. The confirm is in the danger role inside the
// `AlertDialog` only. It keeps no server state: success closes and re-fetches;
// any refusal closes, shows its message as a toast and re-fetches the page, so
// the history shows the current DRAFT (a stale token is the Warning toast
// `DRAFT_CONFLICT_MESSAGE`, ui-context §10). A toast, because the re-fetch may
// remove the DRAFT row — and this dialog with it (review fix).

import { useRouter } from "next/navigation";
import { useState } from "react";
import { toast } from "sonner";

import { discardTemplateDraftAction } from "@/actions/billing/invoice-settings/discard-template-draft.action";
import { DRAFT_CONFLICT_MESSAGE } from "@/components/billing/invoice-settings/draft-messages";
import {
  TEMPLATE_TYPE_MESSAGES,
  discardBody,
  discardTitle,
} from "@/components/billing/invoice-settings/template-type-messages";
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
import type { DiscardTemplateDraftResult } from "@/types/billing";

export interface DiscardDraftDialogProps {
  familyId: string;
  draftId: string;
  draftToken: string;
  draftVersionNo: number;
  layoutDraft: { code: string; versionNo: number } | null;
}

function refusalMessage(
  code: Extract<DiscardTemplateDraftResult, { ok: false }>["code"],
): string {
  switch (code) {
    case "DRAFT_CONFLICT":
      return DRAFT_CONFLICT_MESSAGE;
    case "TEMPLATE_TYPE_RETIRED":
      return TEMPLATE_TYPE_MESSAGES.typeRetired;
    case "FORBIDDEN":
      return TEMPLATE_TYPE_MESSAGES.discardForbidden;
    default:
      return TEMPLATE_TYPE_MESSAGES.discardFailed;
  }
}

export function DiscardDraftDialog({
  familyId,
  draftId,
  draftToken,
  draftVersionNo,
  layoutDraft,
}: DiscardDraftDialogProps): React.JSX.Element {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  function handleOpenChange(next: boolean): void {
    if (submitting) return;
    setOpen(next);
    if (!next) setMessage(null);
  }

  async function discard(): Promise<void> {
    setSubmitting(true);
    setMessage(null);
    try {
      const result = await discardTemplateDraftAction({
        familyId,
        draftId,
        expectedDraftToken: draftToken,
      });
      if (result.ok) {
        setOpen(false);
        router.refresh();
        return;
      }
      setOpen(false);
      if (result.code === "DRAFT_CONFLICT") {
        toast.warning(refusalMessage(result.code));
      } else {
        toast.error(refusalMessage(result.code));
      }
      router.refresh();
    } catch {
      setMessage(TEMPLATE_TYPE_MESSAGES.discardFailed);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={handleOpenChange}>
      <AlertDialogTrigger asChild>
        <Button type="button" variant="ghost" size="sm">
          {TEMPLATE_TYPE_MESSAGES.discardTrigger}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{discardTitle(draftVersionNo)}</AlertDialogTitle>
          <AlertDialogDescription>
            {discardBody(draftVersionNo, layoutDraft)}
          </AlertDialogDescription>
        </AlertDialogHeader>

        {message ? (
          <p
            role="alert"
            className="text-body-sm text-[color:var(--color-danger-700)]"
          >
            {message}
          </p>
        ) : null}

        <AlertDialogFooter>
          <AlertDialogCancel disabled={submitting}>Cancel</AlertDialogCancel>
          <Button
            type="button"
            variant="destructive"
            disabled={submitting}
            onClick={() => void discard()}
          >
            {TEMPLATE_TYPE_MESSAGES.discardConfirm}
          </Button>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
