"use client";

// ac21-spec §3.3 — the only client component in this unit. Renders for
// pending_approval documents when the viewer holds EDIT. Surfaces the
// Result-code catalog vocabulary (code-standards §9) back to the user;
// never re-implements the SELF_APPROVAL rule client-side (server enforces it).

import { useRouter } from "next/navigation";
import { useState } from "react";

import { approveDocumentAction } from "@/actions/accounts/approve-document";
import type { DocState } from "@/types/accounts";

export interface DocumentApprovalActionsProps {
  documentId: string;
  lastModified: Date;
  state: DocState;
  createdBy: string;
  currentUserId: string;
}

const RESULT_MESSAGES: Record<string, string> = {
  SELF_APPROVAL:
    "Self-approval is not permitted — another approver must post this document.",
  CONFLICT: "Document was modified by another user. Refresh and try again.",
  DOC_STATE_INVALID: "Document is no longer pending approval.",
};

export function DocumentApprovalActions({
  documentId,
  lastModified,
  state,
  createdBy,
  currentUserId,
}: DocumentApprovalActionsProps): React.JSX.Element | null {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (state !== "pending_approval") return null;

  const isSelf = createdBy === currentUserId;

  async function handleApprove(): Promise<void> {
    setBusy(true);
    setMessage(null);
    try {
      const result = await approveDocumentAction({ documentId, lastModified });
      if (!result.ok) {
        setMessage(
          RESULT_MESSAGES[result.code] ?? "Approval failed. Please try again.",
        );
        return;
      }
      router.refresh();
    } catch {
      setMessage("Approval failed. Please try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 border-t border-[color:var(--border-subtle)] pt-4">
      <h3 className="text-[11px] font-semibold tracking-wider text-muted-foreground uppercase">
        Actions
      </h3>
      <div className="flex items-center gap-3">
        <button
          type="button"
          disabled={busy || isSelf}
          onClick={() => void handleApprove()}
          title={
            isSelf
              ? "You created this document — another approver must post it"
              : undefined
          }
          aria-label="Approve and post document"
          className="rounded-md bg-[color:var(--action-primary-bg)] px-4 py-2 text-body-sm font-medium text-white hover:bg-[color:var(--action-primary-bg-hover)] focus-visible:[box-shadow:var(--focus-ring)] focus-visible:outline-none disabled:cursor-not-allowed disabled:opacity-50"
        >
          {busy ? "Posting…" : "Approve & post"}
        </button>
      </div>
      {message && (
        <p className="text-body-sm text-destructive" role="alert">
          {message}
        </p>
      )}
    </div>
  );
}
